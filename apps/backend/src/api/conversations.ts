import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler';
import { prisma } from '../db/prisma';
import { windowState } from '../lib/window';
import { withOutbox } from '../realtime/outbox';
import { ApiError } from '../lib/errors';

export const conversationsRouter = Router();

/**
 * GET /api/conversations — paginated list, pinned first then by last message.
 */
conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const conversations = await prisma.conversation.findMany({
      take: limit,
      where: { isArchived: false },
      orderBy: [{ isPinned: 'desc' }, { lastMessageAt: 'desc' }],
      include: { contact: true },
    });

    res.json({
      conversations: conversations.map((c) => ({
        id: c.id,
        contact: {
          id: c.contact.id,
          phoneNumber: c.contact.phoneNumber,
          displayName: c.contact.displayName,
          profileName: c.contact.profileName,
          optOut: c.contact.optOut,
        },
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        isPinned: c.isPinned,
        isArchived: c.isArchived,
        window: windowState(c.lastInboundAt),
      })),
    });
  }),
);

/**
 * GET /api/conversations/:id — single conversation detail (contact + window),
 * used for the conversation header.
 */
conversationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const c = await prisma.conversation.findUnique({ where: { id }, include: { contact: true } });
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');
    res.json({
      conversation: {
        id: c.id,
        contact: {
          id: c.contact.id,
          phoneNumber: c.contact.phoneNumber,
          displayName: c.contact.displayName,
          profileName: c.contact.profileName,
          optOut: c.contact.optOut,
        },
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        isPinned: c.isPinned,
        isArchived: c.isArchived,
        window: windowState(c.lastInboundAt),
      },
    });
  }),
);

/**
 * GET /api/conversations/:id/messages — reverse-chrono pagination via `before`.
 * Response is chronological (oldest → newest).
 */
conversationsRouter.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before as string | undefined;

    const conv = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    const messages = await prisma.message.findMany({
      where: {
        conversationId: id,
        ...(before ? { sentAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: limit,
    });

    // Resolve quoted-reply snippets in one batched query.
    const replySids = messages
      .map((m) => m.replyToTwilioSid)
      .filter((s): s is string => Boolean(s));
    const quotedRows = replySids.length
      ? await prisma.message.findMany({
          where: { twilioSid: { in: replySids } },
          select: { id: true, twilioSid: true, body: true, direction: true, type: true },
        })
      : [];
    const quotedMap = new Map(quotedRows.map((q) => [q.twilioSid, q]));

    res.json({
      messages: messages.reverse().map((m) => {
        const quoted = m.replyToTwilioSid ? quotedMap.get(m.replyToTwilioSid) : undefined;
        return {
          id: m.id,
          clientId: m.clientId,
          direction: m.direction,
          type: m.type,
          status: m.status,
          body: m.body,
          mediaUrl: m.mediaUrl ? `/api/media/${m.id}` : null,
          mediaMime: m.mediaMime,
          mediaName: m.mediaName,
          mediaSize: m.mediaSize,
          hasMedia: Boolean(m.mediaUrl),
          errorCode: m.errorCode,
          errorMessage: m.errorMessage,
          sentAt: m.sentAt,
          replyTo: quoted
            ? { id: quoted.id, body: quoted.body, direction: quoted.direction, type: quoted.type }
            : null,
        };
      }),
    });
  }),
);

/**
 * POST /api/conversations/:id/read — zero unread_count, emit realtime update.
 */
conversationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const conv = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    await withOutbox(async (tx, emit) => {
      await tx.conversation.update({ where: { id }, data: { unreadCount: 0 } });
      await emit({ kind: 'conversation.updated', conversationId: id, payload: { unreadCount: 0 } });
    });

    res.json({ ok: true });
  }),
);
