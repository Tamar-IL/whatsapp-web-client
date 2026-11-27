import { Router } from 'express';
import { requireAuth } from '../auth/middleware';
import { authRouter } from '../auth/routes';
import { conversationsRouter } from './conversations';
import { messagesRouter } from './messages';
import { scheduledRouter } from './scheduled';
import { templatesRouter } from './templates';
import { contactsRouter } from './contacts';
import { mediaRouter } from './media';
import { settingsRouter, labelsRouter, savedRepliesRouter } from './library';
import { aiRouter } from './ai';
import { bulkRouter } from './bulk';
import { profileRouter } from './profile';

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
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/labels', labelsRouter);
apiRouter.use('/saved-replies', savedRepliesRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/bulk', bulkRouter);
apiRouter.use('/profile', profileRouter);
