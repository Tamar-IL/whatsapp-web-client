import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError, twilioErrorMessage } from '../lib/errors';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { emitEphemeral } from '../realtime/io';
import { twilioClient } from '../twilio/client';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { loadTemplates, renderTemplate } from './templates';

/**
 * Bulk template sends ("campaigns").
 *
 * A campaign stores one row per recipient and is worked off by an in-process
 * loop, one message every ~1.2 s, so it survives a restart (pending rows are
 * picked up again) and stays well inside Twilio/WhatsApp throughput limits.
 *
 * Variables may use per-contact tokens: {name} (display / WhatsApp name),
 * {first} (first word of it) and {phone}.
 */
export const bulkRouter = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contentSid: z.string().min(1),
  variables: z.record(z.string(), z.string().max(500)).default({}),
  conversationIds: z.array(z.string()).min(1).max(5000),
});

bulkRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid campaign.');
    const p = parsed.data;
    const template = (await loadTemplates()).find((t) => t.sid === p.contentSid);
    if (!template) throw new ApiError(404, 'NOT_FOUND', 'Template not found.');
    if (template.status !== 'approved') throw new ApiError(409, 'TEMPLATE_NOT_APPROVED', 'Only approved templates can be sent.');
    const missing = template.variables.filter((v) => !p.variables[v.key]?.trim()).map((v) => `{{${v.key}}}`);
    if (missing.length) throw new ApiError(400, 'MISSING_VARIABLES', `Fill in ${missing.join(', ')}.`);

    const ids = [...new Set(p.conversationIds)];
    const campaign = await prisma.bulkCampaign.create({
      data: {
        name: p.name,
        contentSid: p.contentSid,
        templateName: template.friendlyName,
        variables: p.variables,
        recipients: { create: ids.map((conversationId) => ({ conversationId })) },
      },
    });
    kick();
    res.status(201).json({ campaign: await summary(campaign.id) });
  }),
);

async function summary(id: string) {
  const c = await prisma.bulkCampaign.findUnique({ where: { id } });
  if (!c) return null;
  const groups = await prisma.bulkRecipient.groupBy({ by: ['status'], where: { campaignId: id }, _count: true });
  const count = (st: string) => groups.find((g) => g.status === st)?._count ?? 0;
  const total = groups.reduce((n, g) => n + g._count, 0);
  return {
    id: c.id,
    name: c.name,
    templateName: c.templateName,
    status: c.status,
    createdAt: c.createdAt,
    total,
    sent: count('sent'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('pending') + count('sending'),
  };
}

bulkRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.bulkCampaign.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
    res.json({ campaigns: (await Promise.all(rows.map((r) => summary(r.id)))).filter(Boolean) });
  }),
);

bulkRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = await summary(req.params.id!);
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
    const recipients = await prisma.bulkRecipient.findMany({
      where: { campaignId: req.params.id! },
      include: { conversation: { include: { contact: true } } },
      orderBy: { id: 'asc' },
    });
    res.json({
      campaign: s,
      recipients: recipients.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        name: r.conversation.contact.displayName ?? r.conversation.contact.profileName ?? r.conversation.contact.phoneNumber,
        phone: r.conversation.contact.phoneNumber,
        status: r.status,
        error: r.error,
        sentAt: r.sentAt,
      })),
    });
  }),
);

bulkRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    await prisma.bulkCampaign.update({ where: { id: req.params.id! }, data: { status: 'canceled' } });
    await prisma.bulkRecipient.updateMany({ where: { campaignId: req.params.id!, status: 'pending' }, data: { status: 'skipped', error: 'Canceled' } });
    emitEphemeral('bulk.progress', null, await summary(req.params.id!));
    res.json({ ok: true });
  }),
);

// ===== Worker =====

let running = false;
let timer: NodeJS.Timeout | null = null;
const GAP_MS = 1200;

export function startBulkWorker(): void {
  if (timer) return;
  // Rows left in 'sending' by a crash go back to the queue.
  void prisma.bulkRecipient.updateMany({ where: { status: 'sending' }, data: { status: 'pending' } }).catch(() => undefined);
  timer = setInterval(kick, 15_000);
  setTimeout(kick, 4000);
}

function kick(): void {
  if (running) return;
  running = true;
  void work()
    .catch((err) => logger.error({ err }, 'bulk worker failed'))
    .finally(() => {
      running = false;
    });
}

function fillTokens(v: string, contact: { displayName: string | null; profileName: string | null; phoneNumber: string }) {
  const name = contact.displayName ?? contact.profileName ?? '';
  return v
    .replace(/\{name\}/g, name)
    .replace(/\{first\}/g, name.split(/\s+/)[0] ?? '')
    .replace(/\{phone\}/g, contact.phoneNumber)
    .trim();
}

async function work(): Promise<void> {
  for (;;) {
    const next = await prisma.bulkRecipient.findFirst({
      where: { status: 'pending', campaign: { status: 'running' } },
      orderBy: { id: 'asc' },
      include: { campaign: true, conversation: { include: { contact: true } } },
    });
    if (!next) {
      // Close campaigns with nothing left.
      const open = await prisma.bulkCampaign.findMany({ where: { status: 'running' }, select: { id: true } });
      for (const c of open) {
        const left = await prisma.bulkRecipient.count({ where: { campaignId: c.id, status: { in: ['pending', 'sending'] } } });
        if (!left) {
          await prisma.bulkCampaign.update({ where: { id: c.id }, data: { status: 'done' } });
          emitEphemeral('bulk.progress', null, await summary(c.id));
        }
      }
      return;
    }
    const claim = await prisma.bulkRecipient.updateMany({ where: { id: next.id, status: 'pending' }, data: { status: 'sending' } });
    if (!claim.count) continue;

    const contact = next.conversation.contact;
    if (contact.optOut) {
      await prisma.bulkRecipient.update({ where: { id: next.id }, data: { status: 'skipped', error: 'Opted out' } });
      continue;
    }
    const vars = Object.fromEntries(
      Object.entries(next.campaign.variables as Record<string, string>).map(([k, v]) => [k, fillTokens(v, contact) || '-']),
    );
    try {
      const template = (await loadTemplates()).find((t) => t.sid === next.campaign.contentSid);
      const sent = await twilioClient.messages.create({
        from: env.TWILIO_WHATSAPP_SENDER,
        to: `whatsapp:${contact.phoneNumber}`,
        contentSid: next.campaign.contentSid,
        contentVariables: JSON.stringify(vars),
        statusCallback: `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`,
      });
      const now = new Date();
      const body = template ? renderTemplate(template.body, vars) : `[template ${next.campaign.templateName}]`;
      const m = await withOutbox(async (tx, emit) => {
        const row = await tx.message.create({
          data: {
            conversationId: next.conversationId,
            twilioSid: sent.sid,
            clientId: `bulk_${crypto.randomUUID()}`,
            direction: 'outbound',
            type: 'text',
            status: 'sent',
            body,
            origin: 'bulk',
            sentAt: now,
          },
        });
        await tx.conversation.update({ where: { id: next.conversationId }, data: { lastMessageAt: now } });
        await emit({
          kind: 'message.added',
          conversationId: next.conversationId,
          payload: { messageId: row.id, clientId: row.clientId, direction: 'outbound', type: 'text', status: 'sent', body, sentAt: now, origin: 'bulk' },
        });
        return row;
      });
      await prisma.bulkRecipient.update({ where: { id: next.id }, data: { status: 'sent', messageId: m.id, sentAt: now } });
    } catch (err) {
      const e = err as { code?: string | number; message?: string };
      await prisma.bulkRecipient.update({
        where: { id: next.id },
        data: { status: 'failed', error: twilioErrorMessage(e.code ? String(e.code) : undefined) },
      });
    }
    emitEphemeral('bulk.progress', null, await summary(next.campaignId));
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
}
