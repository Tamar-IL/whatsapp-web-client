import { Router } from 'express';

export const mediaRouter = Router();

/**
 * GET /api/media/:id
 * Phase 4 ticket 4.1 — authenticated media endpoint with Range support.
 * STUB.
 */
mediaRouter.get('/:id', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
