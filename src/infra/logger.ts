import pino from 'pino';
import { env } from './env';

export type Logger = pino.Logger;

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'letletme-graphql',
  },
});
