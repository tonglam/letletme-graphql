import type { SupabaseClient } from '@supabase/supabase-js';
import type Redis from 'ioredis';
import type { Logger } from '../infra/logger';
import type { AuthUser } from '../infra/auth';

export type GraphQLContext = {
  supabase: SupabaseClient;
  redis: Redis;
  logger: Logger;
  user?: AuthUser; // Authenticated user (web or mobile)
};
