import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { mailerConfigured, sendMail } from '../lib/mailer';
import { logger } from '../config/logger';
import { requireAuth } from './middleware';
import {
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_RESEND_COOLDOWN_MS,
  LOGIN_CODE_TTL_MS,
  generateLoginCode,
  hashLoginCode,
  loginCodeMatches,
} from './loginCode';

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email as string | undefined) ?? ''}`,
  message: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.' },
});

const emailKey = (req: Request) =>
  `${req.ip}:${((req.body?.email as string | undefined) ?? '').trim().toLowerCase()}`;

const codeRequestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { code: 'RATE_LIMITED', message: 'Too many code requests. Try again in 15 minutes.' },
});

const codeVerifyLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' },
});

/** Rotate the session id (prevents fixation) and mark the user as logged in. */
async function startSession(req: Request, userId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.userId = userId;
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

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

    await startSession(req, user.id);

    await prisma.auditEvent.create({
      data: { userId: user.id, kind: 'auth.login', ip: req.ip ?? null },
    });

    res.json({ user: { id: user.id, email: user.email } });
  }),
);

// ===== Forgot password → sign in with a one-time code sent by email =====

const codeRequestSchema = z.object({ email: z.string().trim().email() });
const codeVerifySchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/),
});

/**
 * Email a 6-digit sign-in code. Always answers { ok: true } for a well-formed
 * email, whether or not an account exists, so the endpoint can't be used to
 * discover which addresses are registered.
 */
authRouter.post(
  '/login-code/request',
  codeRequestLimiter,
  asyncHandler(async (req, res) => {
    const parsed = codeRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Enter a valid email address.');
    if (!mailerConfigured()) {
      throw new ApiError(503, 'MAIL_NOT_CONFIGURED', 'Email sign-in is not available right now.');
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user) {
      res.json({ ok: true });
      return;
    }

    // Cooldown: if a code was just sent, don't send another — the first one still works.
    const recent = await prisma.loginCode.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - LOGIN_CODE_RESEND_COOLDOWN_MS) } },
      select: { id: true },
    });
    if (recent) {
      res.json({ ok: true });
      return;
    }

    const code = generateLoginCode();
    await prisma.$transaction([
      // Only the newest code is ever valid.
      prisma.loginCode.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.loginCode.create({
        data: {
          userId: user.id,
          codeHash: hashLoginCode(user.id, code),
          expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS),
        },
      }),
    ]);

    try {
      await sendMail({
        to: user.email,
        subject: `Your sign-in code: ${code}`,
        text:
          `Your sign-in code is: ${code}\n\n` +
          `It expires in ${Math.round(LOGIN_CODE_TTL_MS / 60_000)} minutes and can be used once.\n` +
          `If you didn't ask for this, you can ignore this email.`,
      });
    } catch (err) {
      // Don't leak account existence through a different response; just log it.
      logger.error({ err, userId: user.id }, 'failed to send login code email');
    }

    await prisma.auditEvent.create({
      data: { userId: user.id, kind: 'auth.login_code.requested', ip: req.ip ?? null },
    });

    res.json({ ok: true });
  }),
);

authRouter.post(
  '/login-code/verify',
  codeVerifyLimiter,
  asyncHandler(async (req, res) => {
    const parsed = codeVerifySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Enter your email and the 6-digit code.');

    const invalid = () => new ApiError(401, 'BAD_CODE', 'The code is wrong or has expired. Request a new one.');

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user) throw invalid();

    const row = await prisma.loginCode.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.expiresAt < new Date() || row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) throw invalid();

    if (!loginCodeMatches(user.id, parsed.data.code, row.codeHash)) {
      await prisma.loginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw invalid();
    }

    // Consume atomically so two concurrent requests can't both use the same code.
    const consumed = await prisma.loginCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid();

    await startSession(req, user.id);

    await prisma.auditEvent.create({
      data: { userId: user.id, kind: 'auth.login_code', ip: req.ip ?? null },
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
    res.json({ user });
  }),
);
