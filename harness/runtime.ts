import { DBOS } from '@dbos-inc/dbos-sdk';
import { streamText } from 'ai';
import type { ModelMessage, JSONValue } from 'ai';
import { EventType } from '@shared/events';
import { emit } from './bus';
import { model } from './model';
import { tools, runTool } from './tools';
import { SYSTEM_PROMPT } from './system-prompt';

// A safety cap so a confused model can't loop forever.
const MAX_STEPS = 10;

type ToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

// A turn represents one complete interaction cycle where the LLM is called and
// it either requests tool calls or finishes. Each time a tool call is made and the
// LLM needs to think again, that constitutes a new turn. Tracking turns helps
// manage the agent's conversation state and enables resuming from a specific
// turn after recovery.
type Turn = {
  text: string;
  toolCalls: ToolCall[];
  responseMessages: ModelMessage[];
};

// One model turn: stream the tokens out as events, then return the assistant's
// message(s) and any tool calls. We run this as a DBOS step, so a completed turn
// is checkpointed and never re-called — a crash won't re-bill the LLM.
async function modelTurn(
  workflowId: string,
  messages: ModelMessage[],
): Promise<Turn> {
  const result = streamText({ model, messages, tools });

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      await emit({ type: EventType.ModelDelta, workflowId, text: part.text });
    }
  }

  const rawCalls = await result.toolCalls;
  return {
    text: await result.text,
    toolCalls: rawCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input as Record<string, unknown>,
    })),
    responseMessages: (await result.response).messages,
  };
}

// Execute one tool. We run this as a DBOS step so its side effect (e.g.
// sendReply actually emailing someone) runs EXACTLY ONCE — a completed tool step
// is never re-run when DBOS recovers the workflow after a crash.
async function toolStep(
  workflowId: string,
  call: ToolCall,
): Promise<Record<string, unknown>> {
  await emit({
    type: EventType.ToolRequested,
    workflowId,
    toolCallId: call.toolCallId,
    name: call.toolName,
    args: call.input, // This helps us know the args the LLM wants to
    // use for the tool call. Useful for scenarios like: "do you
    // approve the bank transfer?" but we need to know the transaction
    // details in order to approve. The transaction details would
    // be the args here.
  });
  const output = await runTool(call.toolName, call.input);
  await emit({
    type: EventType.ToolCompleted,
    workflowId,
    toolCallId: call.toolCallId,
    result: output,
  });
  return output;
}

// THE DURABLE AGENT LOOP.
//
// Structurally it's the same while-loop as before — but every model call and
// every tool call is a DBOS step. DBOS checkpoints each step's result to
// Postgres. If the process crashes mid-run, DBOS recovers this workflow on the
// next launch and resumes from the last completed step: no repeated LLM calls,
// no duplicate sends, no lost work.
//
// The catch: the workflow body itself re-runs on recovery, so it must be
// deterministic. All non-determinism (the model, the tools, the clock) lives
// inside steps — the body just orchestrates and rebuilds `messages` from the
// cached step results.
async function agentWorkflow(input: string): Promise<string> {
  // The `input` parameter of this function is persisted to the database on
  // each new workflow execution
  // https://docs.dbos.dev/architecture#how-workflow-recovery-works
  const workflowId = DBOS.workflowID ?? 'unknown';

  // DBOS steps persist the inputs and outputs of WORKFLOWS in a database.
  // This makes operations durable, allowing them to survive server failures,
  // be retried if needed, and prevents duplicate executions. Each step's state
  // is tracked in the database, enabling recovery from where execution left off.
  // Database emit operations (like the one below and any time we call emit()
  // from bus.ts) should be in steps to make them persistent and idempotent.
  // Without being in a step,these operations are just floating in the workflow
  // and are not idempotent,meaning they could run more than once and produce
  // different results each time the workflow restarts.
  await DBOS.runStep(
    () => emit({ type: EventType.WorkflowStarted, workflowId, input }),
    { name: 'started' },
  );

  // This is deterministic so it can stay inside the workflow, it never changes
  const messages: ModelMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: input }, // If this is a recovery run, then the (old) `input`
    // param was retrieved from the database during `await DBOS.launch();`
    //  (see workflow_status and workflow_inputs tables in the dbos schema)
    // https://docs.dbos.dev/architecture#how-workflow-recovery-works
  ];

  let step = 0;
  while (step < MAX_STEPS) {
    // Wrapping an LLM call inside a step prevents it from rerunning every time
    // the workflow restarts. This avoids unnecessary LLM costs by ensuring that if the
    // LLM already ran on the current turn, it won't run again if the workflow stops and resumes.
    // Note that awaiting a step doesn't stop the streaming behavior. The stream continues
    // to work inside the step function. The await is waiting for the step to run and complete,
    // not for the result itself, so all the streaming operations within the step continue
    // to execute normally.
    const turn = await DBOS.runStep(() => modelTurn(workflowId, messages), {
      name: `model-${step}`,
    });
    messages.push(...turn.responseMessages);

    if (turn.toolCalls.length === 0) {
      await DBOS.runStep(
        () =>
          emit({ type: EventType.ModelCompleted, workflowId, text: turn.text }),
        { name: `model-done-${step}` },
      );
      await DBOS.runStep(
        () =>
          emit({
            type: EventType.WorkflowCompleted,
            workflowId,
            output: turn.text,
          }),
        { name: 'completed' },
      );
      return turn.text;
    }

    for (const call of turn.toolCalls) {
      const output = await DBOS.runStep(() => toolStep(workflowId, call), {
        name: `tool-${call.toolCallId}`,
      });

      // Feed the tool result back to the model on the next turn.
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: 'json', value: output as JSONValue },
          },
        ],
      });
    }

    step++;
  }

  // Reachable only if we did not `return` earlier, either because we hit the
  // maximum number of steps allowed or another error condition
  await DBOS.runStep(
    () =>
      emit({
        type: EventType.WorkflowFailed,
        workflowId,
        error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
      }),
    { name: 'failed' },
  );
  return '';
}

// Register the workflow with DBOS. `runAgentWorkflow` is the durable, recoverable
// version of the old `runAgent`.
export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkflow, {
  name: 'agentWorkflow',
});
