import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { twilioClient } from '../twilio/client';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { saveMedia, signMediaToken } from '../lib/mediaStore';
import { mediaPublicBaseUrl } from '../lib/deliverMedia';

/**
 * Your WhatsApp Business profile (the name, photo, "about" and contact details
 * customers see), via Twilio's Senders API (messaging.twilio.com/v2).
 *
 * Name changes go through Meta's display-name review and may take days; the
 * other fields usually update within minutes. Accounts on the older WhatsApp
 * self sign-up flow may not expose the Senders API — the error is then shown
 * as-is so the operator knows to edit the profile in the Twilio Console.
 */
export const profileRouter = Router();

const SENDERS = 'https://messaging.twilio.com/v2/Channels/Senders';

async function sendersApi(method: 'get' | 'post', uri: string, data?: object) {
  let res: { statusCode: number; body: unknown };
  try {
    res = await twilioClient.request({
      method,
      uri,
      ...(data && { headers: { 'Content-Type': 'application/json' }, data }),
    });
  } catch (err) {
    logger.error({ err }, 'Twilio Senders API unreachable');
    throw new ApiError(502, 'TWILIO_UNREACHABLE', 'Could not reach Twilio. Try again.');
  }
  const body = (typeof res.body === 'string' ? JSON.parse(res.body || 'null') : res.body) as Record<string, unknown> | null;
  if (res.statusCode >= 300) {
    logger.warn({ status: res.statusCode, body }, 'Twilio Senders API rejected request');
    throw new ApiError(
      400,
      'TWILIO_REJECTED',
      `Twilio: ${String(body?.message ?? `request failed (${res.statusCode})`)}. ` +
        'If this keeps failing, edit the profile in the Twilio Console → Messaging → Senders → WhatsApp senders.',
    );
  }
  return body;
}

interface SenderRow {
  sid: string;
  sender_id: string;
  status?: string;
  profile?: Record<string, unknown> | null;
}

async function findSender(): Promise<SenderRow> {
  const body = await sendersApi('get', `${SENDERS}?Channel=whatsapp&PageSize=100`);
  const list = ((body?.senders as SenderRow[] | undefined) ?? []);
  const me = list.find((s) => s.sender_id === env.TWILIO_WHATSAPP_SENDER);
  if (!me) {
    throw new ApiError(
      404,
      'SENDER_NOT_FOUND',
      `Twilio has no WhatsApp sender record for ${env.TWILIO_WHATSAPP_SENDER} in the Senders API. ` +
        'Edit the profile in the Twilio Console instead.',
    );
  }
  return me;
}

function toOut(s: SenderRow) {
  const p = (s.profile ?? {}) as Record<string, unknown>;
  const list = <T,>(v: unknown, key: string) =>
    Array.isArray(v) ? (v as Array<Record<string, unknown>>).map((x) => String(x[key] ?? '')).filter(Boolean) : ([] as T[]);
  return {
    senderId: s.sender_id,
    status: s.status ?? null,
    name: (p.name as string) ?? '',
    about: (p.about as string) ?? '',
    description: (p.description as string) ?? '',
    address: (p.address as string) ?? '',
    vertical: (p.vertical as string) ?? '',
    logoUrl: (p.logo_url as string) ?? '',
    emails: list<string>(p.emails, 'email'),
    websites: list<string>(p.websites, 'website'),
  };
}

profileRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ profile: toOut(await findSender()) });
  }),
);

const patchSchema = z.object({
  name: z.string().trim().max(100).optional(),
  about: z.string().max(139).optional(),
  description: z.string().max(512).optional(),
  address: z.string().max(256).optional(),
  vertical: z.string().max(64).optional(),
  emails: z.array(z.string().trim().email()).max(2).optional(),
  websites: z.array(z.string().trim().url()).max(2).optional(),
});

profileRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid profile.');
    const p = parsed.data;
    const sender = await findSender();
    const profile: Record<string, unknown> = {};
    if (p.name !== undefined) profile.name = p.name;
    if (p.about !== undefined) profile.about = p.about;
    if (p.description !== undefined) profile.description = p.description;
    if (p.address !== undefined) profile.address = p.address;
    if (p.vertical !== undefined && p.vertical) profile.vertical = p.vertical;
    if (p.emails) profile.emails = p.emails.map((email, i) => ({ email, label: i === 0 ? 'Email' : `Email ${i + 1}` }));
    if (p.websites) profile.websites = p.websites.map((website, i) => ({ website, label: i === 0 ? 'Website' : `Website ${i + 1}` }));
    const updated = (await sendersApi('post', `${SENDERS}/${sender.sid}`, { profile })) as SenderRow | null;
    res.json({ profile: toOut(updated ?? sender) });
  }),
);

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/** POST /api/profile/logo — new profile photo (square JPG/PNG works best). */
profileRouter.post(
  '/logo',
  logoUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file || !/^image\/(jpeg|png)$/.test(file.mimetype)) {
      throw new ApiError(400, 'BAD_INPUT', 'Choose a JPG or PNG image (up to 5 MB).');
    }
    const sender = await findSender();
    const key = `profile-logo-${Date.now()}`;
    await saveMedia(key, file.buffer);
    await saveMedia(`${key}.mime`, Buffer.from(file.mimetype));
    // Meta fetches the photo asynchronously, so the link stays valid for a week.
    const url = `${mediaPublicBaseUrl()}/public/media/${signMediaToken(key, 7 * 24 * 3600 * 1000)}`;
    const updated = (await sendersApi('post', `${SENDERS}/${sender.sid}`, { profile: { logo_url: url } })) as SenderRow | null;
    res.json({ profile: toOut(updated ?? sender) });
  }),
);
