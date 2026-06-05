import { Router } from 'express';
import { requireAuth } from '../auth/middleware';
import { authRouter } from '../auth/routes';
import { conversationsRouter } from './conversations';
import { messagesRouter } from './messages';
import { scheduledRouter } from './scheduled';
import { templatesRouter } from './templates';
import { contactsRouter } from './contacts';
import { mediaRouter } from './media';

export const apiRouter = Router();

// Auth endpoints — login/logout are unauthenticated; /me requires auth.
apiRouter.use('/auth', authRouter);

// Everything else requires a logged-in user.
apiRouter.use(requireAuth);
apiRouter.use('/conversations', conversationsRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/scheduled', scheduledRouter);
apiRouter.use('/templates', templatesRouter);
apiRouter.use('/contacts', contactsRouter);
apiRouter.use('/media', mediaRouter);
