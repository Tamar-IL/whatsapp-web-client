import type { RequestHandler } from 'express';
import twilio from 'twilio';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Twilio webhook signature verification (deep-dive §2).
 *
 * CRITICAL details:
 *  - URL passed to validateRequest MUST be the one Twilio used to call us.
 *    We build it from PUBLIC_BASE_URL + req.originalUrl — NOT req.protocol +
 *    req.get('host'), which is wrong behind Railway's proxy.
 *  - req.body must be the urlencoded form Twilio sent. The route mounting this
 *    middleware MUST use express.urlencoded BEFORE this — and the global JSON
 *    parser MUST NOT have run on this request.
 *
 * Returns 403 on failure. Logs at warn level with enough detail to debug.
 */
export const verifyTwilioSignature: RequestHandler = (req, res, next) => {
  const sig = req.header('X-Twilio-Signature');
  if (!sig) {
    logger.warn({ url: req.originalUrl }, 'Twilio webhook missing X-Twilio-Signature header.');
    return res.status(403).send('missing signature');
  }
  const url = `${env.PUBLIC_BASE_URL}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  const valid = twilio.validateRequest(env.TWILIO_AUTH_TOKEN, sig, url, params);
  if (!valid) {
    logger.warn(
      { url, paramKeys: Object.keys(params) },
      'Twilio webhook signature mismatch. Check PUBLIC_BASE_URL matches Twilio config.',
    );
    return res.status(403).send('bad signature');
  }
  next();
};
