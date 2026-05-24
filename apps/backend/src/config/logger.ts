import pino, { type Logger } from 'pino';
import { env, isProd } from './env';

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-twilio-signature"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
});
