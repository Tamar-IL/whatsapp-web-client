import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import type { RequestHandler } from 'express';
import { pgPool } from '../db/pool';
import { env, isProd } from '../config/env';

const PgStore = ConnectPgSimple(session);

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

export const sessionMiddleware: RequestHandler = session({
  name: 'wweb.sid',
  store: new PgStore({
    pool: pgPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15, // every 15 min
  }),
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProd, // requires HTTPS — Railway provides it
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000, // 30 days
  },
});
