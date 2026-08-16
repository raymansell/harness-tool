import { streamText } from 'ai';
import type { ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { EventType, type Emit } from '@shared/events';
import { model } from './model';
import { tools } from './tools';
import { SYSTEM_PROMPT } from './system-prompt';

// A safety cap so a confused model can't loop forever.
const MAX_STEPS = 10;

// THE BRITTLE AGENT.
//
// This is a script with an LLM in the middle. It works in a demo and dies in
// production a dozen ways:
//
//   · the `messages` array lives in memory      → crash = total loss
//   · tools run with no mediation               → `sendReply` just fires
//   · history only grows                        → context bloat
//   · one agent does everything                 → no specialization
export async function runAgent(opts: {
  input: string;
  emit: Emit;
}): Promise<void> {
  const { input, emit } = opts;
  const workflowId = randomUUID();

  emit({ type: EventType.WorkflowStarted, workflowId, input });

  // BRITTLE STATE: a plain in-memory array. If this process dies, it's gone.
  const messages: ModelMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: input },
  ];

  // THE LOOP. We drive it ourselves — each pass is exactly one model turn,
  // because streamText does a single generation by default.
  let step = 0;
  while (step < MAX_STEPS) {
    const result = streamText({ model, messages, tools });

    // Forward everything the model does onto the harness event stream so the
    // inspector can render it. (`part.type` here is the AI SDK's, not ours.)
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          emit({ type: EventType.ModelDelta, workflowId, text: part.text });
          break;
        case 'tool-call':
          emit({
            type: EventType.ToolRequested,
            workflowId,
            toolCallId: part.toolCallId,
            name: part.toolName,
            args: part.input, // This helps us know the args the LLM wants to
            // use for the tool call. Useful for scenarios like: "do you
            // approve the bank transfer?" but we need to know the transaction
            // details in order to approve. The transaction details would
            // be the args here.
          });
          break;
        case 'tool-result':
          emit({
            type: EventType.ToolCompleted,
            workflowId,
            toolCallId: part.toolCallId,
            result: part.output,
          });
          break;
        case 'error':
          emit({
            type: EventType.WorkflowFailed,
            workflowId,
            error: String(part.error),
          });
          return;
      }
    }

    // Append the model's message(s) — including any tool results — to history.
    messages.push(...(await result.response).messages);

    // No more tool calls means the model answered. We're done.
    const toolCalls = await result.toolCalls;
    if (toolCalls.length === 0) {
      const text = await result.text;
      emit({ type: EventType.ModelCompleted, workflowId, text });
      emit({ type: EventType.WorkflowCompleted, workflowId, output: text });
      return;
    }

    step++;
  }

  // Reachable only if we did not `return` earlier, either because we hit the
  // maximum number of steps allowed or another error condition
  emit({
    type: EventType.WorkflowFailed,
    workflowId,
    error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
  });
}
