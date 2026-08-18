# Agent harness and orchestration tool.

A minimal proof of concept tool to keep agents durable, isolated, memory-aware and coordinated.

Check it out live at [harness.raymansell.com](https://harness.raymansell.com/)

### Test with sample prompts:

These prompts contain information relevant to the local knowled base of the agent (see `tools.ts`).

#### Default mode (unsupervised):

```
Handle these work items:
- item-1 (billing): Customer cus_88121 says they were charged twice. Find the duplicate charge and tell them the exact refund amount (in dollars).
- item-2 (bug_report): "The export button fails on Safari."
- item-3 (sales): "Can you send pricing for 50 seats?
```

Check the live event-stream. A durable execution layer stores every event and agent step in postgres. Workflows can be resumed after crashes or failures. Tool calls are only ever invoked once.

The billing item triggers three things:

1. A `runCode` tool with a secure sandbox to run agent-generated code in an isolated environment.
2. An agent handoff (control transfer) to a specelized billing agent.
3. Human-in-the-loop approvals for sensitive actions (refunds).

Memory management runs on every turn of the conversation (see `memory.compacted` events). This prevents the context window from growing forever.

#### Supervised mode: (toggle the `Supervised` button in the UI)

A single multi-area escalation request. Supervised mode will decompose the objective into multiple sub-tasks and delegate each one to specialized sub-agents.

```
Customer cus_88121: double-charged, the export feature is broken in Safari, and they want 50-seat pricing.
```

## Architectural patterns

- **The harness** — An agent runtime that gives an LLM its context, tools and guardrails.

- **Durable execution** — Backed by Postgres. Checkpoints agent events and steps so a crash/restart resumes exactly where it left off.

- **Secure sandboxing** — run untrusted, agent-generated code in an isolated runtime with timeouts.

- **Advanced memory** — hydrate the right context with state stores, sliding windows and summarization.

- **Orchestration** — route intent and hand off context between a triage agent and specialists.

- **Hierarchical supervision** — a supervisor that plans, spawns parallel sub-agents and merges results.

- **Human in the loop** — durable suspend/resume to wait minutes or days for human approval.

## Setup

### 1. Clone and install

```bash
git clone git@github.com:raymansell/harness-tool.git
cd harness-tool
npm install
```

### 2. Configure environment variables

Copy `.env.vars.example` to `.env.vars` and fill in your keys.

### 3. Boot server + UI.

```bash
npm run dev
```

## Tech stack

- **Runtime** — Node.js + Typescript
- **Server** — Express + `ws` Hosts the harness and streams its event log to the browser over one WebSocker
- **Database** — Postgres for durable execution via DBOS + event log.
- **LLM** — GPT-5.6 via the Vercel AI SDK.
- **UI** — Vite + React.
