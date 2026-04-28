#!/usr/bin/env bun

/**
 * Seeds Redis hash `MiniProgram::Notice` with test `switch` + `content` fields
 * (same shape as the legacy Java `qryMiniProgramNotice` reader).
 *
 * Requires REDIS_HOST, REDIS_PORT, REDIS_PASSWORD (optional) — see .env.example.
 *
 * Usage:
 *   bun scripts/seed-mini-program-notice-redis.ts
 *   bun scripts/seed-mini-program-notice-redis.ts --off   # set switch OFF (empty notice via API)
 */

import { MINI_PROGRAM_NOTICE_REDIS_KEY } from '../src/domains/mini-program/repository';
import { connectRedis } from '../src/infra/redis';

const DEFAULT_CONTENT =
  '[test] Mini program notice from seed script — safe to delete or overwrite this key.';

async function main(): Promise<void> {
  const turnOff = process.argv.includes('--off');
  const redis = await connectRedis();

  try {
    if (turnOff) {
      await redis.hset(MINI_PROGRAM_NOTICE_REDIS_KEY, {
        switch: 'OFF',
        content: '',
      });
      console.log(`Set ${MINI_PROGRAM_NOTICE_REDIS_KEY} switch=OFF (notice disabled).`);
    } else {
      await redis.hset(MINI_PROGRAM_NOTICE_REDIS_KEY, {
        switch: 'ON',
        content: DEFAULT_CONTENT,
      });
      console.log(`Set ${MINI_PROGRAM_NOTICE_REDIS_KEY} with test content.`);
    }

    const snapshot = await redis.hgetall(MINI_PROGRAM_NOTICE_REDIS_KEY);
    console.log('Current hash:', snapshot);
  } finally {
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
