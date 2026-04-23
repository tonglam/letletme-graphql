import type { GraphQLContext } from '../graphql/context';

const SEASON_CURRENT_KEY = 'season:current';
const DEFAULT_SEASON = '2526';

const parseSeason = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4}$/.test(trimmed) ? trimmed : null;
};

export const getCurrentSeason = async (context: GraphQLContext): Promise<string> => {
  const raw = await context.redis.get(SEASON_CURRENT_KEY);
  const parsed = parseSeason(raw);
  if (parsed) {
    return parsed;
  }
  return DEFAULT_SEASON;
};