import { DBOS } from '@dbos-inc/dbos-sdk';
import { streamText } from 'ai';
import type { ModelMessage, JSONValue, ToolSet } from 'ai';
import { EventType } from '@shared/events';
import { emit } from './bus';
import { model } from './model';
import { runTool } from './tools';
import { triageAgent, agents } from './agents';
import {
  buildContext,
  summarize,
  estimateTokens,
  MAX_CONTEXT_TOKENS,
  KEEP_CONTEXT_TOKENS,
} from './memory';

// A safety cap so a confused model can't loop forever.
const MAX_STEPS = 30;

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

// One model turn over the HYDRATED context (not the whole history). Run as a
// DBOS step so a completed turn is checkpointed and never re-billed.
async function modelTurn(
  workflowId: string,
  context: ModelMessage[],
  agentTools: ToolSet,
): Promise<Turn> {
  const result = streamText({ model, messages: context, tools: agentTools });

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
    args: call.input,
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

// Helper used to manually respond to tool calls that don't have automatic
// formatting (such as `handoff`).
function toolResultMessage(call: ToolCall, value: JSONValue): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'json', value },
      },
    ],
  };
}

// THE DURABLE AGENT LOOP, a general runtime that runs any agent.
//
// We keep the conversation as a list of TURNS. Each pass:
//   1. if we have too many turns, compact the oldest into a running summary
//   2. hydrate the context (system + task + summary + recent turns)
//   3. run one model turn over THAT context — not the whole history
//
// So the tokens we send stay roughly flat no matter how long the task runs. The
// full history still lives, durably, in the Postgres event log.
//
// Supports handoffs.
//   · it runs the CURRENT agent's prompt + tools (starts with the triage agent)
//   · the `handoff` tool isn't executed — the harness intercepts it and SWITCHES
//     the running agent, keeping the conversation. Control transfers laterally.
//
// `currentAgent` is rebuilt deterministically on recovery (the handoff is a
// consequence of a cached model decision), so this composes with durability.
async function agentWorkflow(input: string): Promise<string> {
  const workflowId = DBOS.workflowID ?? 'unknown';

  await DBOS.runStep(
    () => emit({ type: EventType.WorkflowStarted, workflowId, input }),
    { name: 'started' },
  );

  let currentAgent = triageAgent; // point of entry agent, this is the default
  // everytime a new workflow starts

  const turns: ModelMessage[][] = [];
  let summary = '';

  let step = 0;
  while (step < MAX_STEPS) {
    // 1. Compact: while the recent window is over budget, peel the oldest turns
    //    into the running summary (keeping at least the last turn verbatim).
    //    We compact before a model turn because we need to ensure the token limit
    //    before the actual model turn (LLM inference call) runs (where it can
    //    potentially go over budged and break mid-turn)
    if (estimateTokens(turns.flat()) > MAX_CONTEXT_TOKENS) {
      const old: ModelMessage[][] = [];
      while (
        turns.length > 1 &&
        estimateTokens(turns.flat()) > KEEP_CONTEXT_TOKENS
      ) {
        const oldest = turns.shift(); // sliding window
        if (oldest) {
          old.push(oldest);
        }
      }
      if (old.length > 0) {
        summary = await DBOS.runStep(() => summarize(old, summary), {
          name: `summarize-${step}`,
        });
        const contextTokens = estimateTokens(
          buildContext(currentAgent.systemPrompt, input, summary, turns),
        );
        await DBOS.runStep(
          () =>
            emit({
              type: EventType.MemoryCompacted,
              workflowId,
              summarizedTurns: old.length,
              contextTokens,
              summary,
            }),
          { name: `compacted-${step}` },
        );
      }
    }

    // 2 + 3. Hydrate the context and run one turn over it.
    // each model call goes over the hydrated context instead of the full history
    // and modelTurn takes that context instead of the whole messages array
    const context = buildContext(
      currentAgent.systemPrompt,
      input,
      summary,
      turns,
    );

    const turn = await DBOS.runStep(
      () => modelTurn(workflowId, context, currentAgent.tools),
      {
        name: `model-${step}`,
      },
    );
    const turnMessages: ModelMessage[] = [...turn.responseMessages];

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
      if (call.toolName === 'handoff') {
        // The harness intercepts handoff: switch the running agent, don't run
        // a tool execution. This is done at the runtime level rather than at
        // the main agent tool to clearly separate the main agent out of its
        // own context, and start a fresh conversation in a separate agent.
        // Otherwise the result of the handoff tool execution would go back to
        // the main agent into its own context and the main agent would remain involved.
        const to = String(call.input.to ?? '');
        const reason = String(call.input.reason ?? '');
        const from = currentAgent.name;
        await DBOS.runStep(
          () =>
            emit({
              type: EventType.AgentHandoff,
              workflowId,
              from,
              to,
              reason,
            }),
          { name: `handoff-${call.toolCallId}` },
        );
        currentAgent = agents[to] ?? currentAgent;
        turnMessages.push(
          toolResultMessage(call, {
            ok: true,
            message: `You are now the ${to} specialist. Take over and FINISH the task by calling the tools you need — do the work, don't just acknowledge the handoff.`,
          }),
        );
      } else {
        const output = await DBOS.runStep(() => toolStep(workflowId, call), {
          name: `tool-${call.toolCallId}`,
        });
        turnMessages.push(toolResultMessage(call, output as JSONValue));
      }
    }

    turns.push(turnMessages);
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
