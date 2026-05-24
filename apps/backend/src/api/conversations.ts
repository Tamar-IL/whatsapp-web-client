import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler';
import { prisma } from '../db/prisma';
import { windowState } from '../lib/window';
import { withOutbox } from '../realtime/outbox';
import { ApiError } from '../lib/errors';

export const conversationsRouter = Router();

/**
 * GET /api/conversations
 * Phase 3 ticket 3.1 — paginated list of conversations, sorted by last_message_at
 * desc with pinned first. Each entry includes window state for the chat list.
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
 * GET /api/conversations/:id/messages
 * Phase 3 ticket 3.2 — reverse-chrono pagination via `before` cursor.
 *
 * Query params:
 *  - limit   (default 50, max 100)
 *  - before  ISO timestamp; returns messages with sentAt strictly less than this.
 *
 * Response is in chronological order (oldest → newest) so the client can append
 * to its existing list without flipping.
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

    res.json({
      messages: messages.reverse().map((m) => ({
        id: m.id,
        clientId: m.clientId,
        direction: m.direction,
        type: m.type,
        status: m.status,
        body: m.body,
        mediaUrl: m.mediaUrl,
        mediaMime: m.mediaMime,
        mediaName: m.mediaName,
        mediaSize: m.mediaSize,
        errorCode: m.errorCode,
        errorMessage: m.errorMessage,
        sentAt: m.sentAt,
      })),
    });
  }),
);

/**
 * POST /api/conversations/:id/read
 * Phase 3 ticket 3.3 — zero unread_count and emit a realtime update.
 */
conversationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;

    const conv = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    await withOutbox(async (tx, emit) => {
      await tx.conversation.update({
        where: { id },
        data: { unreadCount: 0 },
      });
      await emit({
        kind: 'conversation.updated',
        conversationId: id,
        payload: { unreadCount: 0 },
      });
    });

    res.json({ ok: true });
  }),
);
