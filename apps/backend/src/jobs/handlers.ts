import type PgBoss from 'pg-boss';
import { getBoss, type JobPayloads } from './queue';
import { logger } from '../config/logger';

/**
 * Job handlers. Each is a stub for Phase 2-5 implementation.
 *
 * Register handlers with the boss instance via `registerHandlers`.
 * Called from worker.ts (or inline from server.ts if RUN_WORKER_INLINE=true).
 *
 * pg-boss v10 passes a batch (array) of jobs to the handler. We iterate
 * and process each one. Stubs just log for now.
 */

export async function registerHandlers(): Promise<void> {
  const boss = await getBoss();

  await boss.work<JobPayloads['download-media']>('download-media', async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'download-media stub');
    }
    // TODO Phase 2 ticket 2.7:
    // 1. Fetch media from Twilio (twilioGateway.fetchMedia)
    // 2. Stream to MEDIA_STORAGE_PATH or S3
    // 3. Update Message.mediaUrl + mediaMime
    // 4. Emit outbox event 'message.updated'
  });

  await boss.work<JobPayloads['send-media']>('send-media', async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'send-media stub');
    }
    // TODO Phase 4 ticket 4.3
  });

  await boss.work<JobPayloads['send-voice']>('send-voice', async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'send-voice stub');
    }
    // TODO Phase 5 ticket 5.1:
    // 1. Validate src, run ffmpeg -> ogg/opus mono 16kHz
    // 2. twilioGateway.uploadMedia
    // 3. twilioGateway.sendMedia
    // 4. Update Message row, emit outbox event
    // 5. Cleanup temp files
  });

  await boss.work<JobPayloads['reconcile-status']>('reconcile-status', async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'reconcile-status stub');
    }
    // TODO: re-fetch message status from Twilio if a callback was missed.
  });

  logger.info('Job handlers registered.');
}

export type BossInstance = PgBoss;
