import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { env, isProd } from './config/env';
import { logger } from './config/logger';
import { createApp } from './app';
import { attachSocketIO } from './realtime/io';
import { bootstrapAdminUser } from './auth/bootstrap';
import { prisma } from './db/prisma';

async function main() {
  await bootstrapAdminUser();

  const app = createApp();

  // In production serve the built frontend from the same origin (single approved domain).
  if (isProd) {
    const frontendDist = path.resolve(__dirname, '../../frontend/dist');
    app.use(express.static(frontendDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/webhooks')) return next();
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  const server = http.createServer(app);
  attachSocketIO(server);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Backend listening.');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Server failed to start.');
  process.exit(1);
});
