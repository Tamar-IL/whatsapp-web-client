import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { requireAuth } from './middleware';
import { env } from '../config/env';

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email as string | undefined) ?? ''}`,
  message: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Email and password required.');

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    // Always run bcrypt.compare even on missing user to avoid timing oracle.
    const ok = user
      ? await bcrypt.compare(parsed.data.password, user.passwordHash)
      : await bcrypt.compare(parsed.data.password, '$2a$12$invalidsaltforflowuniformityXXXXXXXXXXXXXXXXXXXXXX');

    if (!user || !ok) throw new ApiError(401, 'BAD_CREDENTIALS', 'Incorrect email or password.');

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = user.id;
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    await prisma.auditEvent.create({
      data: { userId: user.id, kind: 'auth.login', ip: req.ip ?? null },
    });

    res.json({ user: { id: user.id, email: user.email } });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
    res.clearCookie('wweb.sid');
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
      select: { id: true, email: true, createdAt: true },
    });
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Session invalid.');
    // Server-side settings the UI has to describe accurately rather than guess.
    res.json({ user, config: { defaultCountryCode: env.DEFAULT_COUNTRY_CODE } });
  }),
);
