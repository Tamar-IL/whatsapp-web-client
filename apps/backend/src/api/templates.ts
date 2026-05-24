import { Router } from 'express';

export const templatesRouter = Router();

// Phase 6 ticket 6.3: list approved templates (proxied from Twilio Content API).
templatesRouter.get('/', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));

// Phase 6 ticket 6.5: send a template message.
templatesRouter.post('/send', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
