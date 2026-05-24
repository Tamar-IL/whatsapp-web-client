import express, { type Express, type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { env, isProd } from './config/env';
import { logger } from './config/logger';
import { prisma } from './db/prisma';
import { sessionMiddleware } from './auth/session';
import { issueCsrfCookie, requireCsrf } from './auth/csrf';
import { twilioWebhookRouter } from './twilio/webhook';
import { apiRouter } from './api';
import { ApiError } from './lib/errors';

/**
 * Express app factory.
 *
 * ORDER MATTERS:
 *  1. trust proxy (Railway is a reverse proxy; cookies + signature verification depend on this)
 *  2. helmet
 *  3. cookie-parser
 *  4. Twilio webhook routes (BEFORE express.json — they parse urlencoded themselves)
 *  5. Health endpoints (no auth, no session)
 *  6. express.json
 *  7. Session middleware
 *  8. CSRF cookie issuance
 *  9. CORS (dev only — in prod the frontend is served from the same origin)
 * 10. /api router with requireCsrf
 * 11. Error handler
 */
export function createApp(): Express {
  const app = express();

  // 1
  app.set('trust proxy', Number(env.TRUST_PROXY));
  app.disable('x-powered-by');

  // Request logging
  app.use(pinoHttp({ logger, customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  } }));

  // 2
  app.use(helmet({
    contentSecurityPolicy: false, // Frontend serves itself; tighten in Phase 7
    crossOriginEmbedderPolicy: false,
  }));

  // 3
  app.use(cookieParser());

  // 4. Webhooks (own body parser, no session, no CSRF)
  app.use('/webhooks/twilio', twilioWebhookRouter);

  // 5. Health endpoints
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: 'ok' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // 6
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // 7
  app.use(sessionMiddleware);

  // 8
  app.use(issueCsrfCookie);

  // 9 (dev only)
  if (!isProd && env.FRONTEND_ORIGIN) {
    app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
  }

  // 10
  app.use('/api', requireCsrf, apiRouter);

  // 11. Error handler
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
      return;
    }
    req.log?.error({ err }, 'unhandled error');
    res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong.' });
  };
  app.use(errorHandler);

  return app;
}
