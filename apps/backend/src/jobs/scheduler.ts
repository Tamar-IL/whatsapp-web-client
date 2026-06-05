import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { windowState } from '../lib/window';
import { deliverText, DeliverError } from '../lib/deliverText';
import { twilioErrorMessage } from '../lib/errors';
import { emitEphemeral } from '../realtime/io';

/**
 * In-process scheduled-message worker.
 *
 * Why not pg-boss? In this deployment only the HTTP server process runs
 * (Railway `start:prod` → node dist/server.js); the pg-boss worker is not
 * started, so jobs enqueued there would never be consumed. A simple DB-polling
 * loop inside the server process is therefore the robust choice: state lives in
 * `scheduled_messages`, so it survives restarts and resumes (overdue rows are
 * picked up on the next tick).
 *
 * The loop:
 *   1. Atomically claim due `pending` rows (status → 'sending') so overlapping
 *      ticks never double-send.
 *   2. For each: re-check the 24h window, deliver via the shared deliverText
 *      path, then mark sent | failed and ping the UI.
 */

const POLL_INTERVAL_MS = 20 * 1000;
const BATCH = 10;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(): void {
  if (timer) return;
  // Kick once shortly after boot to flush anything overdue, then poll.
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  setTimeout(() => void tick(), 3000);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Scheduled-message worker started.');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return; // never let ticks overlap
  running = true;
  try {
    const due = await prisma.scheduledMessage.findMany({
      where: { status: 'pending', scheduledFor: { lte: new Date() } },
      // Deterministic order: due time first, then creation order so messages
      // scheduled for the same instant go out first-scheduled-first. id is a
      // final tiebreaker (cuid is monotonic-ish but createdAt is the real key).
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: BATCH,
    });

    for (const row of due) {
      // Claim it: only proceed if we flip pending → sending (guards against a
      // concurrent cancel or a second tick).
      const claim = await prisma.scheduledMessage.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'sending', attempts: { increment: 1 } },
      });
      if (claim.count === 0) continue;

      await fire(row);
    }
  } catch (err) {
    logger.error({ err }, 'scheduler tick failed');
  } finally {
    running = false;
  }
}

async function fire(row: {
  id: string;
  conversationId: string;
  body: string;
  replyToId: string | null;
  clientId: string;
  createdById: string | null;
}): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { id: row.conversationId },
    include: { contact: true },
  });

  if (!conv) {
    await markFailed(row, 'Conversation no longer exists.');
    return;
  }

  // The window may have closed since the message was scheduled.
  if (!windowState(conv.lastInboundAt).open) {
    await markFailed(
      row,
      'The 24-hour window was closed when this was due, so it could not be sent. Reach out with a template, then resend.',
    );
    return;
  }

  try {
    const delivered = await deliverText({
      conv,
      body: row.body,
      clientId: row.clientId,
      replyToId: row.replyToId,
      userId: row.createdById,
    });

    await prisma.scheduledMessage.update({
      where: { id: row.id },
      data: { status: 'sent', sentMessageId: delivered.message.id, errorMessage: null },
    });
    // deliverText already emitted message.added; tell the UI to drop the chip.
    emitEphemeral('scheduled.removed', conv.id, {
      id: row.id,
      conversationId: conv.id,
      status: 'sent',
      sentMessageId: delivered.message.id,
    });
    logger.info({ scheduledId: row.id, messageId: delivered.message.id }, 'scheduled message sent');
  } catch (err) {
    const reason =
      err instanceof DeliverError
        ? twilioErrorMessage(err.twilioCode)
        : 'Sending failed unexpectedly. Try resending.';
    await markFailed(row, reason);
    logger.error({ err, scheduledId: row.id }, 'scheduled message failed');
  }
}

async function markFailed(row: { id: string; conversationId: string }, message: string): Promise<void> {
  await prisma.scheduledMessage.update({
    where: { id: row.id },
    data: { status: 'failed', errorMessage: message },
  });
  emitEphemeral('scheduled.updated', row.conversationId, {
    id: row.id,
    conversationId: row.conversationId,
    status: 'failed',
    errorMessage: message,
  });
}
