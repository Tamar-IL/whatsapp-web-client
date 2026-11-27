import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { saveMedia, readMedia, mediaExists } from '../lib/mediaStore';
import { normalizePhone } from './conversations';
import { syntheticConversationSid } from '../twilio/programmable';

export const contactsRouter = Router();

const AVATAR_MAX = 3 * 1024 * 1024;
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX } });
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/** Tell every open tab that the chats of this contact changed. */
async function touchContact(contactId: string, reason: string) {
  const convs = await prisma.conversation.findMany({ where: { contactId }, select: { id: true } });
  await withOutbox(async (_tx, emit) => {
    for (const c of convs) await emit({ kind: 'conversation.updated', conversationId: c.id, payload: { reason } });
  });
}

const patchSchema = z.object({
  displayName: z.string().max(120).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  optOut: z.boolean().optional(),
});

/** PATCH /api/contacts/:id — name, notes, email, opt-out. */
contactsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid contact details.');
    const id = req.params.id!;
    const existing = await prisma.contact.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Contact not found.');
    const p = parsed.data;
    const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    const contact = await prisma.contact.update({
      where: { id },
      data: {
        ...(p.displayName !== undefined && { displayName: blankToNull(p.displayName) }),
        ...(p.notes !== undefined && { notes: blankToNull(p.notes) }),
        ...(p.email !== undefined && { email: blankToNull(p.email) }),
        ...(p.optOut !== undefined && { optOut: p.optOut }),
      },
    });
    await touchContact(id, 'contact');
    res.json({ contact });
  }),
);

/**
 * Contact photos.
 *
 * WhatsApp does not give businesses their customers' profile pictures — Twilio
 * passes on the name only — so the photo is one the operator uploads. Without
 * one the UI shows a coloured initial.
 */
contactsRouter.post(
  '/:id/avatar',
  avatarUpload.single('file'),
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const file = req.file;
    if (!file || !file.mimetype.startsWith('image/') || file.mimetype === 'image/svg+xml') {
      throw new ApiError(400, 'BAD_INPUT', 'Choose a JPG, PNG or WebP image (up to 3 MB).');
    }
    const existing = await prisma.contact.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Contact not found.');
    // A fresh key per upload doubles as a cache buster for the <img> URL.
    const key = `avatar-${id}-${Date.now()}`;
    await saveMedia(key, file.buffer);
    await saveMedia(`${key}.mime`, Buffer.from(file.mimetype));
    await prisma.contact.update({ where: { id }, data: { avatarFile: key } });
    await touchContact(id, 'avatar');
    res.json({ ok: true, avatarVersion: key });
  }),
);

contactsRouter.delete(
  '/:id/avatar',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    await prisma.contact.update({ where: { id }, data: { avatarFile: null } });
    await touchContact(id, 'avatar');
    res.json({ ok: true });
  }),
);

contactsRouter.get(
  '/:id/avatar',
  asyncHandler(async (req, res) => {
    const c = await prisma.contact.findUnique({ where: { id: req.params.id! }, select: { avatarFile: true } });
    if (!c?.avatarFile || !(await mediaExists(c.avatarFile))) {
      throw new ApiError(404, 'NOT_FOUND', 'No photo.');
    }
    const mime = (await mediaExists(`${c.avatarFile}.mime`))
      ? (await readMedia(`${c.avatarFile}.mime`)).toString()
      : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(await readMedia(c.avatarFile));
  }),
);

/** CSV cell, quoted when needed. */
function csvCell(v: string | null | undefined): string {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/contacts/export — every contact as CSV (opens in Excel; BOM keeps Hebrew readable). */
contactsRouter.get(
  '/export',
  asyncHandler(async (_req, res) => {
    const contacts = await prisma.contact.findMany({
      orderBy: { createdAt: 'asc' },
      include: { conversations: { include: { labels: { include: { label: true } } } } },
    });
    const lines = [
      ['phone', 'name', 'whatsapp_name', 'email', 'notes', 'labels', 'opted_out'].join(','),
      ...contacts.map((c) =>
        [
          c.phoneNumber,
          c.displayName,
          c.profileName,
          c.email,
          c.notes,
          [...new Set(c.conversations.flatMap((cv) => cv.labels.map((l) => l.label.name)))].join('; '),
          c.optOut ? 'yes' : 'no',
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send('﻿' + lines.join('\r\n'));
  }),
);

/** Minimal RFC-4180 CSV parser (quoted cells, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * POST /api/contacts/import — CSV with a "phone" column and optional
 * "name", "email", "notes", "labels" columns (labels separated by ";").
 * Each row becomes a contact with a chat (template-only until they write).
 * Existing contacts are updated, never duplicated.
 */
contactsRouter.post(
  '/import',
  csvUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'BAD_INPUT', 'Choose a CSV file.');
    const rows = parseCsv(req.file.buffer.toString('utf8').replace(/^﻿/, ''));
    if (rows.length < 2) throw new ApiError(400, 'EMPTY', 'The file has no rows under the header.');
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const iPhone = col('phone', 'phone number', 'number', 'טלפון', 'מספר');
    const iName = col('name', 'display name', 'שם');
    const iEmail = col('email', 'e-mail', 'מייל');
    const iNotes = col('notes', 'note', 'הערות');
    const iLabels = col('labels', 'label', 'תוויות');
    if (iPhone < 0) throw new ApiError(400, 'NO_PHONE_COLUMN', 'The first row must have a "phone" column.');

    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]!;
      const phone = normalizePhone(row[iPhone] ?? '');
      if (!phone) {
        errors.push(`Row ${r + 1}: "${row[iPhone] ?? ''}" is not a phone number`);
        continue;
      }
      const name = iName >= 0 ? row[iName]?.trim() || undefined : undefined;
      const email = iEmail >= 0 ? row[iEmail]?.trim() || undefined : undefined;
      const notes = iNotes >= 0 ? row[iNotes]?.trim() || undefined : undefined;
      const labelNames =
        iLabels >= 0 ? (row[iLabels] ?? '').split(/[;|]/).map((l) => l.trim()).filter(Boolean) : [];

      const before = await prisma.contact.findUnique({ where: { phoneNumber: phone }, select: { id: true } });
      const contact = await prisma.contact.upsert({
        where: { phoneNumber: phone },
        create: { phoneNumber: phone, displayName: name, email, notes },
        update: { ...(name && { displayName: name }), ...(email && { email }), ...(notes && { notes }) },
      });
      before ? updated++ : created++;
      const sid = syntheticConversationSid(phone);
      const conv = await prisma.conversation.upsert({
        where: { twilioConversationSid: sid },
        create: { contactId: contact.id, twilioConversationSid: sid },
        update: {},
      });
      for (const ln of labelNames) {
        const label = await prisma.label.upsert({ where: { name: ln }, create: { name: ln }, update: {} });
        await prisma.conversationLabel.upsert({
          where: { conversationId_labelId: { conversationId: conv.id, labelId: label.id } },
          create: { conversationId: conv.id, labelId: label.id },
          update: {},
        });
      }
    }
    await withOutbox(async (_tx, emit) => {
      await emit({ kind: 'conversation.updated', conversationId: null, payload: { reason: 'import' } });
    });
    res.json({ created, updated, errors: errors.slice(0, 50), errorCount: errors.length });
  }),
);
