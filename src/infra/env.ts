type EnvKey =
  | 'SUPABASE_URL'
  | 'SUPABASE_KEY'
  | 'REDIS_HOST'
  | 'REDIS_PORT'
  | 'REDIS_PASSWORD'
  | 'PORT'
  | 'LOG_LEVEL'
  | 'CACHE_TTL_SECONDS';

const readEnv = (key: EnvKey): string | undefined => {
  const value = Bun.env[key];
  if (value !== undefined) {
    return value;
  }
  return process.env[key];
};

const requireEnv = (key: EnvKey): string => {
  const value = readEnv(key);
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
};

const readNumber = (key: EnvKey, fallback: number): number => {
  const raw = readEnv(key);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for env: ${key}`);
  }
  return parsed;
};

export const env = {
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_KEY: requireEnv('SUPABASE_KEY'),
  REDIS_HOST: requireEnv('REDIS_HOST'),
  REDIS_PORT: readNumber('REDIS_PORT', 6379),
  REDIS_PASSWORD: readEnv('REDIS_PASSWORD') ?? '',
  PORT: readNumber('PORT', 4000),
  LOG_LEVEL: readEnv('LOG_LEVEL') ?? 'info',
  CACHE_TTL_SECONDS: readNumber('CACHE_TTL_SECONDS', 60),
} as const;
