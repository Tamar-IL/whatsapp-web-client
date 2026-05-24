import PgBoss from 'pg-boss';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Background job queue (pg-boss, deep-dive §1 of the spec review).
 *
 * Two entry points use this:
 *  - The HTTP server (server.ts) imports `enqueueJob` to schedule work.
 *  - The worker process (worker.ts) imports `startWorker` to register handlers
 *    and start consuming.
 *
 * Single-replica deployment for v1: HTTP and worker can be the same process
 * (set RUN_WORKER_INLINE=true) or split into two Railway services for isolation.
 */

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: 'pgboss',
    application_name: 'wweb-jobs',
  });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  return boss;
}

export async function enqueueJob<TData extends object>(
  name: JobName,
  data: TData,
  opts: PgBoss.SendOptions = {},
): Promise<string | null> {
  const b = await getBoss();
  return b.send(name, data as object, opts);
}

export type JobName =
  | 'download-media'
  | 'send-media'
  | 'send-voice'
  | 'reconcile-status';

export interface JobPayloads {
  'download-media': { messageSid: string; mediaSid: string; contentType: string };
  'send-media': { messageId: string; conversationSid: string; mediaSid: string; clientId: string };
  'send-voice': { messageId: string; conversationSid: string; tmpFilePath: string; clientId: string };
  'reconcile-status': { twilioSid: string };
}
