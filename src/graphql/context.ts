import type { SupabaseClient } from '@supabase/supabase-js';
import type Redis from 'ioredis';
import type { Logger } from '../infra/logger';

export type GraphQLContext = {
  supabase: SupabaseClient;
  redis: Redis;
  logger: Logger;
};
