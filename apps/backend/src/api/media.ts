import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { ApiError } from '../lib/errors';
import { logger } from '../config/logger';
import { mediaExists, readMedia } from '../lib/mediaStore';
import { sendMail } from '../lib/mailer';

export const mediaRouter = Router();

/**
 * Resolve a message's media to raw bytes + content type, regardless of where it
 * lives. Outbound (and now persisted inbound) media is on local disk under
 * "local:<id>"; legacy/unpersisted inbound media is fetched from Twilio with
 * Basic auth. Used by both the streaming proxy and the "email me" endpoint.
 */
async function loadMediaBytes(
  id: string,
  mediaUrl: string,
  mediaMime: string | null,
): Promise<{ buf: Buffer; contentType: string }> {
  // Prefer our own stored copy whenever it exists — checked FIRST and regardless
  // of what mediaUrl points at, so a persisted inbound file is served straight
  // from disk.
  if (await mediaExists(id)) {
    return {
      buf: await readMedia(id),
      contentType: mediaMime || 'application/octet-stream',
    };
  }

  // No local copy. Outbound files we sent have no remote source to fall back to.
  if (mediaUrl.startsWith('local:')) {
    throw new ApiError(404, 'GONE', 'Media no longer available (cleared on server restart).');
  }

  // Otherwise the local copy is missing (e.g. ephemeral disk wiped on restart)
  // but mediaUrl still points at the original Twilio media — re-fetch it. Needs
  // Basic auth; the fetch spec strips Authorization on cross-origin redirects
  // (Twilio → CDN), so following redirects is safe.
  const authHeader =
    'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

  let upstream: Response;
  try {
    upstream = await fetch(mediaUrl, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    logger.error({ err, id }, 'media fetch failed');
    const reason = (err as Error)?.name === 'TimeoutError' ? 'timed out fetching from Twilio' : 'could not reach Twilio';
    throw new ApiError(502, 'MEDIA_FETCH_FAILED', `Media fetch failed: ${reason}.`);
  }
  if (!upstream.ok) {
    logger.warn({ id, status: upstream.status }, 'media upstream non-OK');
    throw new ApiError(502, 'MEDIA_UNAVAILABLE', 'Media is no longer available.');
  }
  return {
    buf: Buffer.from(await upstream.arrayBuffer()),
    contentType: mediaMime || upstream.headers.get('content-type') || 'application/octet-stream',
  };
}

function filenameFor(msg: { mediaName: string | null; type?: string }, id: string, contentType: string): string {
  if (msg.mediaName) return msg.mediaName;
  const ext = (contentType.split(';')[0]!.split('/')[1] || 'bin').trim();
  return `${msg.type || 'media'}-${id}.${ext}`;
}

/**
 * GET /api/media/:id — authenticated media proxy.
 *
 * The browser can't fetch Twilio media directly (auth + NetFree), so we serve
 * the bytes (from our local copy, or by proxying Twilio) under our own
 * authenticated endpoint. `?download=1` forces a download with the filename.
 */
mediaRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { mediaUrl: true, mediaMime: true, mediaName: true },
    });
    if (!msg?.mediaUrl) throw new ApiError(404, 'NOT_FOUND', 'No media for this message.');

    const { buf, contentType } = await loadMediaBytes(id, msg.mediaUrl, msg.mediaMime);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename="${filenameFor(msg, id, contentType)}"`);
    }
    res.send(buf);
  }),
);

/**
 * POST /api/media/:id/email — mail this media to the operator as an attachment.
 *
 * The SERVER fetches the bytes and sends them via SMTP, so the file never goes
 * through the operator's NetFree-filtered browser (which turns a direct download
 * into a block page). Delivers to MEDIA_EMAIL_TO.
 */
mediaRouter.post(
  '/:id/email',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const msg = await prisma.message.findUnique({
      where: { id },
      select: {
        mediaUrl: true,
        mediaMime: true,
        mediaName: true,
        type: true,
        sentAt: true,
        conversation: {
          select: {
            contact: { select: { phoneNumber: true, displayName: true, profileName: true } },
          },
        },
      },
    });
    if (!msg?.mediaUrl) throw new ApiError(404, 'NOT_FOUND', 'No media for this message.');

    const { buf, contentType } = await loadMediaBytes(id, msg.mediaUrl, msg.mediaMime);
    const filename = filenameFor(msg, id, contentType);

    const contact = msg.conversation?.contact;
    const who = contact?.displayName || contact?.profileName || contact?.phoneNumber || 'Unknown';
    // toLocaleString with an explicit timeZone throws on runtimes built without
    // full ICU data — fall back to a plain ISO timestamp rather than 500.
    let when: string;
    try {
      when = new Date(msg.sentAt).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
    } catch {
      when = new Date(msg.sentAt).toISOString();
    }
    const sizeKb = Math.max(1, Math.round(buf.length / 1024));

    const subject = `WhatsApp ${msg.type} from ${who}`;
    const text = [
      `Here is the ${msg.type} you received on WhatsApp.`,
      '',
      `From:     ${who}${contact?.phoneNumber ? ` (${contact.phoneNumber})` : ''}`,
      `Received: ${when}`,
      `File:     ${filename} (${contentType}, ~${sizeKb} KB)`,
      '',
      'The file is attached to this email.',
    ].join('\n');

    try {
      await sendMail({ to: env.MEDIA_EMAIL_TO, subject, text, attachments: [{ filename, content: buf, contentType }] });
    } catch (err) {
      // Re-surface configuration/known errors verbatim; wrap unexpected SMTP
      // failures with their real reason so the UI shows it instead of a generic
      // "Something went wrong."
      if (err instanceof ApiError) throw err;
      const reason = (err as Error)?.message ?? 'unknown error';
      logger.error({ err, id }, 'media email send failed');
      throw new ApiError(502, 'EMAIL_SEND_FAILED', `Could not send the email: ${reason}`);
    }
    res.json({ ok: true, to: env.MEDIA_EMAIL_TO });
  }),
);
