import Redis from 'ioredis';
import { env } from './env';

let client: Redis | null = null;

export const getRedis = (): Redis => {
  if (!client) {
    client = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
  }
  return client;
};

export const connectRedis = async (): Promise<Redis> => {
  const redis = getRedis();
  if (redis.status === 'end' || redis.status === 'wait') {
    await redis.connect();
  }
  return redis;
};
