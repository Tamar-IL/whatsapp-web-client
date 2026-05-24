import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { logger } from '../config/logger';
import { env, isProd } from '../config/env';
import { sessionMiddleware } from '../auth/session';
import { prisma } from '../db/prisma';

/**
 * Real-time gateway (deep-dive §4).
 *
 * Cookie-based auth: Socket.IO reuses the same session middleware as Express.
 * Reconnect resync protocol: on connect the client sends `subscribe { sinceEventId }`;
 * we replay OutboxEvent rows since that cursor then join the client to the `live`
 * room for ongoing fanout.
 */

let io: IOServer | null = null;

export function attachSocketIO(httpServer: HttpServer): IOServer {
  io = new IOServer(httpServer, {
    cors: {
      origin: isProd ? false : env.FRONTEND_ORIGIN, // same-origin in prod
      credentials: true,
    },
  });

  // Share session with Express
  io.engine.use(sessionMiddleware);

  // Require a logged-in user
  io.use((socket, next) => {
    const req = socket.request as unknown as { session?: { userId?: string } };
    if (!req.session?.userId) return next(new Error('unauthorized'));
    next();
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'socket connected');

    socket.on('subscribe', async ({ sinceEventId }: { sinceEventId?: string }) => {
      try {
        await replayMissedEvents(socket, sinceEventId);
        socket.join('live');
        socket.emit('subscribed', { ok: true });
      } catch (err) {
        logger.error({ err }, 'replay failed');
        socket.emit('subscribed', { ok: false, error: 'replay_failed' });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return io;
}

async function replayMissedEvents(socket: Socket, sinceEventId?: string): Promise<void> {
  const cursor = sinceEventId ? BigInt(sinceEventId) : 0n;
  const events = await prisma.outboxEvent.findMany({
    where: { id: { gt: cursor } },
    orderBy: { id: 'asc' },
    take: 1000,
  });
  for (const e of events) {
    socket.emit(e.kind, { id: e.id.toString(), conversationId: e.conversationId, payload: e.payload });
  }
}

/**
 * Broadcast a freshly-persisted event to all live subscribers.
 * Called after writing an OutboxEvent inside a transaction.
 */
export function broadcastEvent(event: {
  id: bigint;
  kind: string;
  conversationId?: string | null;
  payload: unknown;
}): void {
  if (!io) return;
  io.to('live').emit(event.kind, {
    id: event.id.toString(),
    conversationId: event.conversationId,
    payload: event.payload,
  });
}

export function getIO(): IOServer | null {
  return io;
}
