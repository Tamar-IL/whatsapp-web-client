import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError, twilioErrorMessage } from '../lib/errors';
import { windowState, WindowClosedError } from '../lib/window';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { deliverText, DeliverError } from '../lib/deliverText';
import { readMedia, mediaExists } from '../lib/mediaStore';
import { deliverMedia, MediaDeliverError } from '../lib/deliverMedia';
import { noteOperatorReply } from '../lib/serialize';
import { emitEphemeral } from '../realtime/io';
import {
  sendQuickReply,
  QuickReplyError,
  MAX_BUTTONS,
  MAX_BODY_CHARS,
  MAX_BUTTON_CHARS,
} from '../twilio/quickReply';
import { env } from '../config/env';

export const messagesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MEDIA_MAX_BYTES },
});

const sendTextSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().min(1).max(4096),
  clientId: z.string().min(1).max(64),
  replyToId: z.string().optional(), // id of the message being replied to (quoted)
});

/**
 * POST /api/messages — send a free-form WhatsApp text reply (Programmable Messaging).
 *
 * 1. Validate input.
 * 2. Look up conversation + contact; enforce the 24h window.
 * 3. Send via Twilio; store the message (status=sent) with a status callback.
 * 4. Emit a realtime 'message.added' so all tabs update.
 */
messagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = sendTextSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid send-message payload.');

    const conv = await prisma.conversation.findUnique({
      where: { id: parsed.data.conversationId },
      include: { contact: true },
    });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    if (!windowState(conv.lastInboundAt).open) {
      throw new ApiError(409, 'WINDOW_CLOSED', new WindowClosedError().message);
    }

    let delivered;
    try {
      delivered = await deliverText({
        conv,
        body: parsed.data.body,
        clientId: parsed.data.clientId,
        replyToId: parsed.data.replyToId,
        userId: req.session.userId ?? null,
      });
    } catch (err) {
      if (err instanceof DeliverError) {
        throw new ApiError(502, 'TWILIO_SEND_FAILED', twilioErrorMessage(err.twilioCode));
      }
      throw err;
    }

    await noteOperatorReply(conv.id);
    res.json({ message: delivered.message });
  }),
);

/**
 * POST /api/messages/media — send an image / video / document / audio file.
 *
 * Programmable Messaging sends media by URL, so we:
 *  1. Validate + persist the upload to local disk.
 *  2. Mint a short-lived signed public URL (/public/media/:token).
 *  3. Tell Twilio to fetch that URL and send it to the customer.
 *  4. Store the outbound message (served back to our UI from disk).
 */
messagesRouter.post(
  '/media',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const conversationId = req.body?.conversationId as string | undefined;
    const clientId = (req.body?.clientId as string | undefined) ?? crypto.randomUUID();
    const caption = (req.body?.caption as string | undefined)?.trim() || undefined;
    const file = req.file;

    if (!file || !conversationId) {
      throw new ApiError(400, 'BAD_INPUT', 'A file and conversationId are required.');
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');
    if (!windowState(conv.lastInboundAt).open) {
      throw new ApiError(409, 'WINDOW_CLOSED', new WindowClosedError().message);
    }

    let message;
    try {
      message = await deliverMedia({
        conv,
        buffer: file.buffer,
        mime: file.mimetype || 'application/octet-stream',
        name: file.originalname,
        caption,
        clientId,
      });
    } catch (err) {
      throw mediaErrorToApi(err);
    }
    await noteOperatorReply(conv.id);
    res.json({ message });
  }),
);

function mediaErrorToApi(err: unknown): unknown {
  if (err instanceof MediaDeliverError) {
    const status = err.code === 'VIDEO_TOO_LARGE' ? 413 : err.code === 'TWILIO_SEND_FAILED' ? 502 : 500;
    return new ApiError(status, err.code, err.message);
  }
  return err;
}

const sendButtonsSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().min(1).max(MAX_BODY_CHARS),
  buttons: z
    .array(z.string().trim().min(1).max(MAX_BUTTON_CHARS))
    .min(1)
    .max(MAX_BUTTONS),
  clientId: z.string().min(1).max(64),
});

/**
 * POST /api/messages/buttons — send a text with up to 3 quick-reply buttons.
 *
 * The 24h window check is not just the usual free-form rule here: an unapproved
 * quick-reply template is ONLY sendable in-session. Outside the window this
 * would need Meta approval, so the same WINDOW_CLOSED response is the correct
 * and complete answer — the operator's route out is a template, as always.
 *
 * Unlike the text path this takes no replyToId. A quoted reply is flattened into
 * the body (see deliverText), which would make every send a unique body and so a
 * brand-new Twilio Content resource — the exact leak getOrCreateContentSid
 * exists to prevent.
 */
messagesRouter.post(
  '/buttons',
  asyncHandler(async (req, res) => {
    const parsed = sendButtonsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'BAD_INPUT',
        `A message and 1–${MAX_BUTTONS} buttons are required (max ${MAX_BUTTON_CHARS} characters each).`,
      );
    }
    const { conversationId, body, buttons, clientId } = parsed.data;

    // WhatsApp rejects a template whose buttons are not all distinct, and two
    // identical chips would be unanswerable anyway — the reply text is the label.
    const seen = new Set(buttons.map((b) => b.toLowerCase()));
    if (seen.size !== buttons.length) {
      throw new ApiError(400, 'DUPLICATE_BUTTONS', 'Each button needs different text.');
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    if (!windowState(conv.lastInboundAt).open) {
      throw new ApiError(409, 'WINDOW_CLOSED', new WindowClosedError().message);
    }

    let sid: string;
    try {
      const sent = await sendQuickReply({
        toPhone: conv.contact.phoneNumber,
        body,
        buttons,
        statusCallbackUrl: `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`,
      });
      sid = sent.sid;
    } catch (err) {
      if (err instanceof QuickReplyError) {
        const friendly = twilioErrorMessage(err.twilioCode);
        throw new ApiError(502, 'TWILIO_SEND_FAILED', `${friendly} [${err.message}]`);
      }
      throw err;
    }

    const now = new Date();
    const message = await withOutbox(async (tx, emit) => {
      const m = await tx.message.create({
        data: {
          conversationId: conv.id,
          twilioSid: sid,
          clientId,
          direction: 'outbound',
          type: 'text',
          status: 'sent',
          body,
          buttons,
          sentAt: now,
        },
      });
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: now } });
      await emit({
        kind: 'message.added',
        conversationId: conv.id,
        payload: {
          messageId: m.id,
          clientId: m.clientId,
          direction: 'outbound',
          type: m.type,
          status: m.status,
          body: m.body,
          buttons,
          sentAt: m.sentAt,
        },
      });
      return m;
    });

    await noteOperatorReply(conv.id);
    res.json({
      message: {
        id: message.id,
        clientId: message.clientId,
        twilioSid: message.twilioSid,
        direction: 'outbound',
        type: message.type,
        status: message.status,
        body: message.body,
        buttons,
        sentAt: message.sentAt,
      },
    });
  }),
);


/** GET /api/messages/starred — every starred message, newest star first. */
messagesRouter.get(
  '/starred',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.message.findMany({
      where: { isStarred: true },
      orderBy: { starredAt: 'desc' },
      take: 500,
      include: { conversation: { include: { contact: true } } },
    });
    res.json({
      starred: rows.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        contactName:
          m.conversation.contact.displayName ?? m.conversation.contact.profileName ?? m.conversation.contact.phoneNumber,
        body: m.body,
        type: m.type,
        direction: m.direction,
        mediaName: m.mediaName,
        hasMedia: Boolean(m.mediaUrl),
        sentAt: m.sentAt,
        starredAt: m.starredAt,
      })),
    });
  }),
);

const flagSchema = z.object({
  isPinned: z.boolean().optional(),
  isStarred: z.boolean().optional(),
});

/** PATCH /api/messages/:id — pin / star a message. */
messagesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = flagSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid update.');
    const id = req.params.id!;
    const msg = await prisma.message.findUnique({ where: { id }, select: { id: true, conversationId: true } });
    if (!msg) throw new ApiError(404, 'NOT_FOUND', 'Message not found.');
    const { isPinned, isStarred } = parsed.data;
    const now = new Date();
    const m = await withOutbox(async (tx, emit) => {
      const row = await tx.message.update({
        where: { id },
        data: {
          ...(isPinned !== undefined && { isPinned, pinnedAt: isPinned ? now : null }),
          ...(isStarred !== undefined && { isStarred, starredAt: isStarred ? now : null }),
        },
      });
      await emit({
        kind: 'message.updated',
        conversationId: msg.conversationId,
        payload: { messageId: id, isPinned: row.isPinned, isStarred: row.isStarred },
      });
      return row;
    });
    res.json({ message: { id: m.id, isPinned: m.isPinned, isStarred: m.isStarred } });
  }),
);

/**
 * POST /api/messages/:id/forward — send a copy of a message to other chats.
 *
 * Text is re-sent as text; a file is re-sent from our stored copy. Each target
 * is handled independently: a chat whose 24h window is closed is reported as
 * skipped rather than failing the whole batch.
 */
messagesRouter.post(
  '/:id/forward',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ conversationIds: z.array(z.string()).min(1).max(50) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Pick at least one chat.');
    const src = await prisma.message.findUnique({ where: { id: req.params.id! } });
    if (!src) throw new ApiError(404, 'NOT_FOUND', 'Message not found.');

    let buffer: Buffer | null = null;
    if (src.mediaUrl) {
      if (!(await mediaExists(src.id))) {
        throw new ApiError(410, 'GONE', 'This file is no longer stored on the server, so it cannot be forwarded.');
      }
      buffer = await readMedia(src.id);
    } else if (!src.body?.trim()) {
      throw new ApiError(400, 'NOTHING_TO_FORWARD', 'This message has no text or file to forward.');
    }

    const results: Array<{ conversationId: string; ok: boolean; error?: string }> = [];
    for (const conversationId of parsed.data.conversationIds) {
      const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
      if (!conv) {
        results.push({ conversationId, ok: false, error: 'Chat not found.' });
        continue;
      }
      if (!windowState(conv.lastInboundAt).open) {
        results.push({ conversationId, ok: false, error: '24-hour window closed — only templates can be sent.' });
        continue;
      }
      try {
        if (buffer) {
          await deliverMedia({
            conv,
            buffer,
            mime: src.mediaMime ?? 'application/octet-stream',
            name: src.mediaName ?? `${src.type}`,
            caption: src.body,
            origin: 'forward',
          });
        } else {
          await deliverText({ conv, body: src.body!, clientId: `c_${crypto.randomUUID()}`, userId: req.session.userId ?? null, origin: 'forward' });
        }
        results.push({ conversationId, ok: true });
      } catch (err) {
        const msg =
          err instanceof DeliverError ? twilioErrorMessage(err.twilioCode) : err instanceof Error ? err.message : 'Failed.';
        results.push({ conversationId, ok: false, error: msg });
      }
    }
    res.json({ results });
  }),
);

/**
 * POST /api/messages/:id/retry — resend a failed outbound message as a new
 * message. The failed row stays in the history (it really did fail), marked so
 * the UI stops offering a second retry.
 */
messagesRouter.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    const src = await prisma.message.findUnique({ where: { id: req.params.id! } });
    if (!src) throw new ApiError(404, 'NOT_FOUND', 'Message not found.');
    if (src.direction !== 'outbound' || src.status !== 'failed') {
      throw new ApiError(409, 'NOT_FAILED', 'Only failed messages can be retried.');
    }
    const conv = await prisma.conversation.findUnique({ where: { id: src.conversationId }, include: { contact: true } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');
    if (!windowState(conv.lastInboundAt).open) {
      throw new ApiError(409, 'WINDOW_CLOSED', new WindowClosedError().message);
    }

    let message;
    try {
      if (src.mediaUrl) {
        if (!(await mediaExists(src.id))) throw new ApiError(410, 'GONE', 'The file is no longer stored, so it cannot be resent.');
        message = await deliverMedia({
          conv,
          buffer: await readMedia(src.id),
          mime: src.mediaMime ?? 'application/octet-stream',
          name: src.mediaName ?? src.type,
          caption: src.body,
          origin: src.origin,
        });
      } else {
        if (!src.body) throw new ApiError(400, 'NOTHING_TO_RETRY', 'Nothing to resend.');
        message = (
          await deliverText({ conv, body: src.body, clientId: `c_${crypto.randomUUID()}`, userId: req.session.userId ?? null, origin: src.origin })
        ).message;
      }
    } catch (err) {
      if (err instanceof DeliverError) throw new ApiError(502, 'TWILIO_SEND_FAILED', twilioErrorMessage(err.twilioCode));
      throw mediaErrorToApi(err);
    }
    // Retried: the old bubble no longer needs a retry button.
    await prisma.message.update({ where: { id: src.id }, data: { errorMessage: 'retried' } });
    emitEphemeral('message.retried', conv.id, { messageId: src.id, newMessageId: message.id });
    res.json({ message });
  }),
);

/**
 * POST /api/messages/voice — Phase 5.
 *
 * POST /api/messages/:id/reaction — NOT IMPLEMENTED, and not implementable.
 * Twilio's Message resource accepts no parameter for reacting to (or replying
 * to) a previous message, on either Programmable Messaging or Conversations.
 * The only way to "send a reaction" would be to deliver the bare emoji as an
 * ordinary text message and render it locally as a chip — which lies to the
 * operator, since the emoji lands in the customer's chat with no link to the
 * message it refers to and can never be unsent. Left as 501 deliberately.
 * Revisit only if Twilio ships real reaction support.
 */
messagesRouter.post('/voice', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
messagesRouter.post('/:id/reaction', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));

