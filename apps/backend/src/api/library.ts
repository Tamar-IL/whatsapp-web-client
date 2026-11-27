import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { prisma } from '../db/prisma';
import { emitEphemeral } from '../realtime/io';
import { getSettings, updateSettings, publicSettings, AI_MODELS } from '../lib/settings';

/**
 * Small CRUD resources: app settings, chat labels and saved replies.
 * Changes are pushed to every open tab with an ephemeral `library.changed`
 * ping so a second window never shows stale lists.
 */

// ===== Settings =====

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ settings: publicSettings(await getSettings()), aiModels: AI_MODELS });
  }),
);

settingsRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    if (typeof req.body !== 'object' || req.body === null) throw new ApiError(400, 'BAD_INPUT', 'Invalid settings.');
    const next = await updateSettings(req.body);
    emitEphemeral('library.changed', null, { kind: 'settings' });
    res.json({ settings: publicSettings(next), aiModels: AI_MODELS });
  }),
);

// ===== Labels =====

export const labelsRouter = Router();

const labelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  sortOrder: z.number().int().optional(),
});

labelsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const labels = await prisma.label.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { conversations: true } } },
    });
    res.json({
      labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color, sortOrder: l.sortOrder, count: l._count.conversations })),
    });
  }),
);

labelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = labelSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'A label needs a name (up to 40 characters).');
    const dup = await prisma.label.findUnique({ where: { name: parsed.data.name } });
    if (dup) throw new ApiError(409, 'DUPLICATE', 'A label with this name already exists.');
    const label = await prisma.label.create({ data: parsed.data });
    emitEphemeral('library.changed', null, { kind: 'labels' });
    res.status(201).json({ label });
  }),
);

labelsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = labelSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid label.');
    if (parsed.data.name) {
      const dup = await prisma.label.findFirst({ where: { name: parsed.data.name, id: { not: req.params.id! } } });
      if (dup) throw new ApiError(409, 'DUPLICATE', 'A label with this name already exists.');
    }
    const label = await prisma.label.update({ where: { id: req.params.id! }, data: parsed.data });
    emitEphemeral('library.changed', null, { kind: 'labels' });
    res.json({ label });
  }),
);

labelsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.label.delete({ where: { id: req.params.id! } }).catch(() => undefined);
    emitEphemeral('library.changed', null, { kind: 'labels' });
    res.json({ ok: true });
  }),
);

// ===== Saved replies ("/shortcut" in the input bar) =====

export const savedRepliesRouter = Router();

const replySchema = z.object({
  // Letters (any language), digits, - and _ — so "/מחיר" works as well as "/price".
  shortcut: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[\p{L}\p{N}_-]+$/u),
  body: z.string().min(1).max(4096),
  sortOrder: z.number().int().optional(),
});

savedRepliesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const replies = await prisma.savedReply.findMany({ orderBy: [{ sortOrder: 'asc' }, { shortcut: 'asc' }] });
    res.json({ replies });
  }),
);

savedRepliesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'BAD_INPUT', 'Shortcut: one word (letters, digits, - or _). Text: required.');
    }
    const dup = await prisma.savedReply.findUnique({ where: { shortcut: parsed.data.shortcut } });
    if (dup) throw new ApiError(409, 'DUPLICATE', `"/${parsed.data.shortcut}" already exists.`);
    const reply = await prisma.savedReply.create({ data: parsed.data });
    emitEphemeral('library.changed', null, { kind: 'savedReplies' });
    res.status(201).json({ reply });
  }),
);

savedRepliesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = replySchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid saved reply.');
    if (parsed.data.shortcut) {
      const dup = await prisma.savedReply.findFirst({ where: { shortcut: parsed.data.shortcut, id: { not: req.params.id! } } });
      if (dup) throw new ApiError(409, 'DUPLICATE', `"/${parsed.data.shortcut}" already exists.`);
    }
    const reply = await prisma.savedReply.update({ where: { id: req.params.id! }, data: parsed.data });
    emitEphemeral('library.changed', null, { kind: 'savedReplies' });
    res.json({ reply });
  }),
);

savedRepliesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.savedReply.delete({ where: { id: req.params.id! } }).catch(() => undefined);
    emitEphemeral('library.changed', null, { kind: 'savedReplies' });
    res.json({ ok: true });
  }),
);
