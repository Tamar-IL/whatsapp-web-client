import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { ApiError } from '../lib/errors';
import { logger } from '../config/logger';

export const mediaRouter = Router();

/**
 * GET /api/media/:id — authenticated media proxy (Phase 4, simplified).
 *
 * Inbound WhatsApp media is stored as Twilio media URLs which require Basic auth
 * to fetch. The browser can't fetch them directly (auth + Netfree). So we fetch
 * server-side with the account credentials and stream the bytes back under our
 * own authenticated endpoint.
 *
 * NOTE: this proxies on demand. Twilio retains media for a limited time, so a
 * persistent local copy (Railway Volume / S3) is the production-grade approach
 * (build-plan ticket 4.1/2.7). On-demand proxy is enough to view/download now.
 *
 * `?download=1` forces a download with the original filename.
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

    // Twilio media URL needs Basic auth (Account SID : Auth Token). The fetch
    // spec strips Authorization on cross-origin redirects (Twilio → CDN), so
    // following redirects is safe.
    const authHeader =
      'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

    let upstream: Response;
    try {
      upstream = await fetch(msg.mediaUrl, { headers: { Authorization: authHeader } });
    } catch (err) {
      logger.error({ err, id }, 'media fetch failed');
      throw new ApiError(502, 'MEDIA_FETCH_FAILED', 'Could not fetch media from Twilio.');
    }

    if (!upstream.ok) {
      logger.warn({ id, status: upstream.status }, 'media upstream non-OK');
      throw new ApiError(502, 'MEDIA_UNAVAILABLE', 'Media is no longer available.');
    }

    const contentType = msg.mediaMime || upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download) {
      const name = msg.mediaName || `download.${contentType.split('/')[1] || 'bin'}`;
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  }),
);
