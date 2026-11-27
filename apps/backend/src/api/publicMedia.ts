import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { mediaExists, readMedia, verifyMediaToken } from '../lib/mediaStore';

/**
 * Public, token-protected media endpoint for OUTBOUND files.
 *
 * Mounted BEFORE the session middleware (Twilio has no session cookie). The
 * HMAC token in the path is the only thing that grants access, and it expires
 * in 15 minutes — long enough for Twilio to fetch the media it's about to send.
 */
export const publicMediaRouter = Router();

publicMediaRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const messageId = verifyMediaToken(req.params.token!);
    if (!messageId) throw new ApiError(403, 'BAD_TOKEN', 'Invalid or expired media token.');

    // Business-profile logo (not a message): stored with its MIME alongside.
    if (messageId.startsWith('profile-logo-')) {
      if (!(await mediaExists(messageId))) throw new ApiError(404, 'GONE', 'Media no longer available.');
      const mime = (await mediaExists(`${messageId}.mime`)) ? (await readMedia(`${messageId}.mime`)).toString() : 'image/jpeg';
      const buf = await readMedia(messageId);
      res.setHeader('Content-Type', mime);
      res.send(buf);
      return;
    }

    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { mediaMime: true, mediaName: true },
    });
    if (!msg) throw new ApiError(404, 'NOT_FOUND', 'Message not found.');
    if (!(await mediaExists(messageId))) throw new ApiError(404, 'GONE', 'Media no longer available.');

    const buf = await readMedia(messageId);
    res.setHeader('Content-Type', msg.mediaMime || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  }),
);
