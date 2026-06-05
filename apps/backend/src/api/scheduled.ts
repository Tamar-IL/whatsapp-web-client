import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { prisma } from '../db/prisma';
import { emitEphemeral } from '../realtime/io';

export const scheduledRouter = Router();

/** Guard rails on how far ahead a message may be scheduled. */
const MIN_LEAD_MS = 30 * 1000; // at least 30s out, so the poller doesn't race the create
const MAX_LEAD_MS = 60 * 24 * 3600 * 1000; // at most 60 days

const createSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().min(1).max(4096),
  scheduledFor: z.string().datetime(), // ISO 8601, UTC
  clientId: z.string().min(1).max(64),
  replyToId: z.string().optional(),
});

interface ScheduledDto {
  id: string;
  conversationId: string;
  body: string;
  scheduledFor: string;
  status: string;
  clientId: string;
  replyToId: string | null;
  errorMessage: string | null;
  sentMessageId: string | null;
  createdAt: string;
}

function toDto(row: {
  id: string;
  conversationId: string;
  body: string;
  scheduledFor: Date;
  status: string;
  clientId: string;
  replyToId: string | null;
  errorMessage: string | null;
  sentMessageId: string | null;
  createdAt: Date;
}): ScheduledDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    body: row.body,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    clientId: row.clientId,
    replyToId: row.replyToId,
    errorMessage: row.errorMessage,
    sentMessageId: row.sentMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * POST /api/scheduled — schedule an outbound text for later delivery.
 *
 * We intentionally do NOT require the 24h window to be open right now: the whole
 * point is to send at a later time, by which the window may have re-opened (or
 * closed). The scheduler re-checks the window at fire time.
 */
scheduledRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid schedule payload.');

    const when = new Date(parsed.data.scheduledFor);
    const lead = when.getTime() - Date.now();
    if (Number.isNaN(when.getTime()) || lead < MIN_LEAD_MS) {
      throw new ApiError(400, 'BAD_TIME', 'Pick a time at least a minute from now.');
    }
    if (lead > MAX_LEAD_MS) {
      throw new ApiError(400, 'BAD_TIME', 'You can only schedule up to 60 days ahead.');
    }

    const conv = await prisma.conversation.findUnique({ where: { id: parsed.data.conversationId } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    // Validate the reply target belongs to this conversation, if provided.
    let replyToId: string | null = null;
    if (parsed.data.replyToId) {
      const target = await prisma.message.findFirst({
        where: { id: parsed.data.replyToId, conversationId: conv.id },
        select: { id: true },
      });
      replyToId = target?.id ?? null;
    }

    const row = await prisma.scheduledMessage.create({
      data: {
        conversationId: conv.id,
        body: parsed.data.body,
        replyToId,
        scheduledFor: when,
        clientId: parsed.data.clientId,
        createdById: req.session.userId ?? null,
      },
    });

    const dto = toDto(row);
    emitEphemeral('scheduled.added', conv.id, dto);
    res.json({ scheduled: dto });
  }),
);

/**
 * GET /api/scheduled?conversationId=... — list a conversation's scheduled
 * messages. Returns pending ones plus recently-resolved ones (so the UI can show
 * a "failed to send" note) ordered by when they fire.
 */
scheduledRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const conversationId = req.query.conversationId as string | undefined;
    if (!conversationId) throw new ApiError(400, 'BAD_INPUT', 'conversationId is required.');

    const rows = await prisma.scheduledMessage.findMany({
      where: {
        conversationId,
        OR: [
          { status: 'pending' },
          // keep failed visible briefly so the operator notices
          { status: 'failed', updatedAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
        ],
      },
      orderBy: { scheduledFor: 'asc' },
    });

    res.json({ scheduled: rows.map(toDto) });
  }),
);

const patchSchema = z.object({
  scheduledFor: z.string().datetime().optional(),
  body: z.string().min(1).max(4096).optional(),
});

/**
 * PATCH /api/scheduled/:id — reschedule (and/or edit the text of) a pending
 * message. Only pending rows can be changed; once a message has fired or been
 * canceled it is immutable.
 */
scheduledRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid schedule update.');
    if (parsed.data.scheduledFor === undefined && parsed.data.body === undefined) {
      throw new ApiError(400, 'BAD_INPUT', 'Nothing to update.');
    }

    const row = await prisma.scheduledMessage.findUnique({ where: { id: req.params.id } });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Scheduled message not found.');
    if (row.status !== 'pending') {
      throw new ApiError(409, 'NOT_EDITABLE', `This message is already ${row.status}.`);
    }

    const data: { scheduledFor?: Date; body?: string } = {};
    if (parsed.data.scheduledFor !== undefined) {
      const when = new Date(parsed.data.scheduledFor);
      const lead = when.getTime() - Date.now();
      if (Number.isNaN(when.getTime()) || lead < MIN_LEAD_MS) {
        throw new ApiError(400, 'BAD_TIME', 'Pick a time at least a minute from now.');
      }
      if (lead > MAX_LEAD_MS) {
        throw new ApiError(400, 'BAD_TIME', 'You can only schedule up to 60 days ahead.');
      }
      data.scheduledFor = when;
    }
    if (parsed.data.body !== undefined) data.body = parsed.data.body;

    const updated = await prisma.scheduledMessage.update({ where: { id: row.id }, data });
    const dto = toDto(updated);
    emitEphemeral('scheduled.updated', row.conversationId, dto);
    res.json({ scheduled: dto });
  }),
);

/**
 * DELETE /api/scheduled/:id — cancel a pending scheduled message.
 * Only pending rows can be canceled (a sent one already went out).
 */
scheduledRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const row = await prisma.scheduledMessage.findUnique({ where: { id } });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Scheduled message not found.');
    if (row.status !== 'pending') {
      throw new ApiError(409, 'NOT_CANCELABLE', `This message is already ${row.status}.`);
    }

    const updated = await prisma.scheduledMessage.update({
      where: { id },
      data: { status: 'canceled' },
    });

    emitEphemeral('scheduled.removed', row.conversationId, {
      id: updated.id,
      conversationId: row.conversationId,
      status: 'canceled',
    });
    res.json({ ok: true });
  }),
);
