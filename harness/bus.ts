import { randomUUID } from 'node:crypto';
import type { AgentEvent, EventInput } from '@shared/events';
import { eventLog, db } from './db';

// The harness event bus. Two jobs now:
//   1. DURABLY persist every event to Postgres (so the timeline survives a crash)
//   2. broadcast it live to any connected inspector
//
// `emit` is async now — we write to the database before we hand the event out.

type Listener = (event: AgentEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  // Cleanup function. Prevents memory leaks by ensuring listeners are properly
  // removed when no longer needed.
  return () => listeners.delete(listener);
}

export async function emit(input: EventInput): Promise<void> {
  const event: AgentEvent = { ...input, id: randomUUID(), ts: Date.now() };

  // Saving events to the database first ensures that the event is persisted
  // before broadcasting it to clients. This guarantees that events can be
  // replayed later and prevents data loss if the application crashes after
  // emitting but before saving.
  await db.insert(eventLog).values({ data: event });

  for (const listener of listeners) {
    listener(event);
  }
}

// The full timeline so far, in order — read back from Postgres on every connect.
export async function history(): Promise<AgentEvent[]> {
  const rows = await db.select().from(eventLog).orderBy(eventLog.seq);

  return rows.map((row) => row.data);
}
