import type { RequestHandler } from 'express';

/**
 * Wrap an async route handler so thrown errors flow to Express's error middleware.
 * Avoids the boilerplate try/catch on every endpoint.
 */
export function asyncHandler<R extends RequestHandler>(handler: R): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
