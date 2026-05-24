import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { env, isProd } from '../config/env';
import { ApiError } from '../lib/errors';

/**
 * Double-submit CSRF protection (deep-dive §7).
 *
 * - issueCsrfCookie: middleware that sets a non-HttpOnly CSRF cookie if missing.
 *   The frontend reads this cookie and echoes its value via the X-CSRF-Token header.
 * - requireCsrf: middleware that verifies the header matches the cookie for any
 *   state-changing request. Mount AFTER cookie-parser, AFTER session, BEFORE API
 *   route handlers.
 *
 * Webhook routes must NOT be wrapped (Twilio doesn't know about this cookie).
 */

export const issueCsrfCookie: RequestHandler = (req, res, next) => {
  if (!req.cookies?.[env.CSRF_COOKIE_NAME]) {
    const token = crypto.randomBytes(24).toString('base64url');
    res.cookie(env.CSRF_COOKIE_NAME, token, {
      httpOnly: false, // frontend must read it
      secure: isProd,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000,
    });
  }
  next();
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (!MUTATING.has(req.method)) return next();
  const cookie = req.cookies?.[env.CSRF_COOKIE_NAME];
  const header = req.header('X-CSRF-Token');
  if (!cookie || !header || cookie !== header) {
    return next(new ApiError(403, 'CSRF_MISMATCH', 'Missing or invalid CSRF token.'));
  }
  next();
};
