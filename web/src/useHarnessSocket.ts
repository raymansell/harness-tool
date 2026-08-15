import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ClientMessage } from '@shared/events';

// The inspector's single source of truth: the harness event stream, received
// over one WebSocket. We also send commands (submit_task, ...) back over it.
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL = `${protocol}://${location.host}/ws`;

export function useHarnessSocket() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (e) => {
      const event = JSON.parse(e.data) as AgentEvent;
      setEvents((prev) => [...prev, event]);
    };

    return () => socket.close();
  }, []);

  const send = useCallback((message: ClientMessage) => {
    socketRef.current?.send(JSON.stringify(message));
  }, []);

  return { events, connected, send };
}
