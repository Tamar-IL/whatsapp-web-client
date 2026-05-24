import { logger } from './config/logger';
import { registerHandlers } from './jobs/handlers';
import { prisma } from './db/prisma';

async function main() {
  await registerHandlers();
  logger.info('Worker started. Consuming jobs...');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutting down...');
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start.');
  process.exit(1);
});
