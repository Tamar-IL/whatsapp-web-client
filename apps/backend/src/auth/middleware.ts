import type { RequestHandler } from 'express';
import { ApiError } from '../lib/errors';

/**
 * Require a logged-in user. Throws 401 ApiError otherwise.
 * Mount AFTER session middleware on all protected API routes.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.session?.userId) {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'You must be logged in.'));
  }
  next();
};
