import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { broadcastEvent } from './io';

/**
 * Transactional outbox helper.
 *
 * Usage:
 *   await withOutbox(async (tx, emit) => {
 *     const msg = await tx.message.create({ ... });
 *     emit({ kind: 'message.added', conversationId: msg.conversationId, payload: { messageId: msg.id } });
 *   });
 *
 * Writes to OutboxEvent happen INSIDE the same DB transaction as your state
 * changes. After commit, events are broadcast over Socket.IO.
 */

type Emit = (event: {
  kind: string;
  conversationId?: string | null;
  payload: unknown;
}) => Promise<void>;

export async function withOutbox<T>(
  fn: (tx: Prisma.TransactionClient, emit: Emit) => Promise<T>,
): Promise<T> {
  const pending: Array<{ id: bigint; kind: string; conversationId: string | null; payload: unknown }> = [];

  const result = await prisma.$transaction(async (tx) => {
    const emit: Emit = async (event) => {
      const row = await tx.outboxEvent.create({
        data: {
          kind: event.kind,
          conversationId: event.conversationId ?? null,
          payload: event.payload as Prisma.InputJsonValue,
        },
      });
      pending.push({
        id: row.id,
        kind: row.kind,
        conversationId: row.conversationId,
        payload: row.payload,
      });
    };
    return fn(tx, emit);
  });

  // Fan out AFTER commit so subscribers never see uncommitted state.
  for (const e of pending) broadcastEvent(e);

  return result;
}
