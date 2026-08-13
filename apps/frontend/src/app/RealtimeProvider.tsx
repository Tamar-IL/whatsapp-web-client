/**
 * RealtimeProvider — Socket.IO client with the reconnect-resync protocol
 * from deep-dive §4.
 *
 * On connect, sends `subscribe { sinceEventId }` so the server can replay missed
 * OutboxEvent rows. The latest event id is persisted in localStorage so a full
 * page reload still resumes cleanly.
 *
 * Phase 3 ticket 3.9: child components consume events via `useRealtime()`.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';

type ConnStatus = 'connecting' | 'connected' | 'disconnected';

interface RealtimeState {
  status: ConnStatus;
  socket: Socket | null;
}

const LAST_EVENT_KEY = 'wweb.lastEventId';

const Ctx = createContext<RealtimeState>({ status: 'connecting', socket: null });

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  // Held in state, NOT a ref: a ref assignment triggers no re-render, so
  // children kept seeing `socket: null` until the first status change — which
  // only lands after the server has already replayed the events missed while
  // offline. Those replayed events arrived with no listeners attached and were
  // lost, while `onAny` below advanced the cursor past them so they were never
  // sent again. Publishing the socket synchronously lets children subscribe
  // during the connection handshake, well before any replay arrives.
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    setSocket(socket);

    socket.on('connect', () => {
      const sinceEventId = localStorage.getItem(LAST_EVENT_KEY) ?? '0';
      socket.emit('subscribe', { sinceEventId });
    });

    socket.on('subscribed', ({ ok }: { ok: boolean }) => {
      if (ok) setStatus('connected');
    });

    socket.on('disconnect', () => setStatus('disconnected'));
    socket.io.on('reconnect_attempt', () => setStatus('connecting'));

    // Update the last-seen cursor on every event with an id.
    const updateCursor = (evt: unknown) => {
      const id = (evt as { id?: string })?.id;
      if (id) localStorage.setItem(LAST_EVENT_KEY, id);
    };
    socket.onAny((_event, payload) => updateCursor(payload));

    return () => {
      socket.removeAllListeners();
      socket.close();
      setSocket(null);
    };
  }, []);

  return <Ctx.Provider value={{ status, socket }}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeState {
  return useContext(Ctx);
}
