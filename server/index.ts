// MUST be first: loads .env.vars before any module that reads env at load time.
import './env';

import { DBOS } from '@dbos-inc/dbos-sdk';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ensureSchema, clearEventLog } from '../harness/db';
import { subscribe, history } from '../harness/bus';
import { runAgentWorkflow } from '../harness/runtime';
import type { ClientMessage } from '@shared/events';
import { runSupervisorWorkflow } from 'harness/supervisor';

const PORT = Number(process.env.PORT ?? 8787);

async function main() {
  // Make sure the durable event log exists.
  await ensureSchema();

  // Point DBOS at the same Postgres database for its checkpoint store, then
  // launch it. launch() ALSO recovers any workflows that were mid-flight when
  // the process last died, resuming them from their last completed step.
  DBOS.setConfig({
    name: 'harness',
    systemDatabaseUrl: process.env.DATABASE_URL,
  });
  await DBOS.launch();

  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Clear the durable log. The inspector calls this, then reloads.
  app.post('/api/clear', async (_req, res) => {
    await clearEventLog();
    res.json({ ok: true });
  });

  // Human-in-the-loop: deliver an approval decision to a suspended workflow.
  // DBOS.send wakes its recv() by writting the message to Postgres
  // even days later, even after a restart.
  app.post('/api/approve/:workflowId', async (req, res) => {
    const approved = Boolean(req.body?.approved);
    await DBOS.send(req.params.workflowId, { approved }, 'approval');
    res.json({ ok: true });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Broadcast every emitted event to all connected inspectors.
  subscribe((event) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  });

  wss.on('connection', async (socket: WebSocket) => {
    // Register the message handler FIRST. history() is now an async DB read, and
    // the client sends submit_task the instant it connects — if we awaited
    // history() before attaching this listener, that first message would be lost.
    socket.on('message', async (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // ignore anything that isn't valid JSON
      }

      if (message.type === 'submit_task') {
        // Start the durable workflow runtime in the background (either the single
        // agent loop, or the supervisor). The workflow reports progress via
        // the event stream; we don't wait for the result here.
        const workflow =
          message.mode === 'supervised'
            ? runSupervisorWorkflow
            : runAgentWorkflow;
        await DBOS.startWorkflow(workflow)(message.input);
      }
    });

    // Replay the DURABLE timeline so a fresh inspector shows everything —
    // including work that happened before a crash, and a workflow DBOS is
    // currently recovering.
    for (const event of await history()) {
      socket.send(JSON.stringify(event));
    }
  });

  server.listen(PORT, () => {
    console.log(`harness server listening on port ${PORT}  (ws: /ws)`);
  });
}
main().catch((error) => {
  console.error('failed to start:', error);
  process.exit(1);
});
