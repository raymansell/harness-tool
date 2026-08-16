import { tool } from 'ai';
import { z } from 'zod';

const KNOWLEDGE_BASE: Record<string, string> = {
  billing:
    'Double charges are usually a duplicate authorization that drops off in 3–5 days. If it already settled, refund immediately.',
  refund: 'Refunds post in 5–10 business days. Pro accounts can be expedited.',
  export:
    'The Safari export failure is a known bug (TICKET-4412). Workaround: use Chrome or the CSV export.',
  pricing:
    'Team plans are $20/seat/mo with a volume discount at 25+ seats. For 50+ seats, send the pricing PDF.',
};

// The tool SCHEMAS the model sees. Note there's no `execute` anymore.
// Previously the AI SDK ran the tools for us. To make tool calls DURABLE we take
// execution back: the harness runs each tool itself (see `runTool`), so every call
// can be wrapped in its own DBOS step and run exactly once.
export const tools = {
  searchKnowledgeBase: tool({
    description: 'Search the support knowledge base for relevant articles.',
    inputSchema: z.object({
      query: z.string().describe('what to look up'),
    }),
  }),

  classifyItem: tool({
    description: 'Classify a work item into a category.',
    inputSchema: z.object({
      itemId: z.string(),
      category: z.enum(['billing', 'technical', 'sales', 'other']),
    }),
  }),

  draftReply: tool({
    description: 'Write a draft reply for a work item. Does not send anything.',
    inputSchema: z.object({
      itemId: z.string(),
      message: z.string(),
    }),
  }),

  sendReply: tool({
    description:
      'Send the drafted reply to the customer. This really emails them.',
    inputSchema: z.object({
      itemId: z.string(),
      draftId: z.string(),
    }),
  }),
};

// Refactor the tool calls to centralize control of tool execution, making it more durable
// and manageable within a workflow system using DBOS. Removing automatic execution by the
// AI SDK and wrapping tool calls and model interactions builds a robust, persistent harness
// for AI tool workflows.

// The harness-owned executor. No sandbox or approval gate yet, but now that
// each call runs inside a DBOS step, a finished side effect such as `sendReply`
// is checkpointed and never repeated after a crash.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'searchKnowledgeBase': {
      const query = String(args.query ?? '').toLowerCase();
      const hits = Object.entries(KNOWLEDGE_BASE)
        .filter(([key]) => query.includes(key))
        .map(([, article]) => article);
      return {
        articles: hits.length ? hits : ['No exact match — use your judgment.'],
      };
    }
    case 'classifyItem':
      return { ok: true, itemId: args.itemId, category: args.category };
    case 'draftReply':
      return { ok: true, draftId: `draft-${args.itemId}` };
    case 'sendReply':
      // DANGEROUS: an irreversible side effect with zero confirmation.
      return { sent: true, itemId: args.itemId, draftId: args.draftId };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
