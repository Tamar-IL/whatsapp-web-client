import { Router } from 'express';

export const contactsRouter = Router();

// Phase 7 ticket 7.1: update display_name, opt_out flag.
contactsRouter.patch('/:id', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
