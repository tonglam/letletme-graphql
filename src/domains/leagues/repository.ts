import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

export enum LeagueType {
  CLASSIC = 'classic',
  H2H = 'h2h',
}

export type League = {
  id: number;
  name: string;
  type: LeagueType;
  startedEvent: number | null;
};

export type LeagueStanding = {
  leagueId: number;
  leagueName: string;
  leagueType: LeagueType;
  entryId: number;
  entryName: string | null;
  playerName: string | null;
  rank: number | null;
  lastRank: number | null;
  overallPoints: number;
  startedEvent: number | null;
};

export type LeagueEventResult = {
  leagueId: number;
  leagueType: LeagueType;
  eventId: number;
  entryId: number;
  entryName: string | null;
  playerName: string | null;
  eventPoints: number;
  eventRank: number | null;
  overallPoints: number;
  overallRank: number;
};

type DbEntryLeagueRow = {
  league_id: number;
  league_name: string;
  league_type: string;
  entry_id: number;
  entry_rank: number | null;
  entry_last_rank: number | null;
  started_event: number | null;
};

type DbLeagueEventResultRow = {
  league_id: number;
  league_type: string;
  event_id: number;
  entry_id: number;
  entry_name: string | null;
  player_name: string | null;
  event_points: number;
  event_rank: number | null;
  overall_points: number;
  overall_rank: number;
};

const mapLeagueType = (type: string): LeagueType => {
  return type === 'h2h' ? LeagueType.H2H : LeagueType.CLASSIC;
};

const mapLeague = (row: DbEntryLeagueRow): League => ({
  id: row.league_id,
  name: row.league_name,
  type: mapLeagueType(row.league_type),
  startedEvent: row.started_event,
});

const mapLeagueStanding = (row: DbEntryLeagueRow): LeagueStanding => ({
  leagueId: row.league_id,
  leagueName: row.league_name,
  leagueType: mapLeagueType(row.league_type),
  entryId: row.entry_id,
  entryName: null, // Will be enriched from entry_infos if needed
  playerName: null,
  rank: row.entry_rank,
  lastRank: row.entry_last_rank,
  overallPoints: 0, // Would need to join with entry_infos
  startedEvent: row.started_event,
});

const mapLeagueEventResult = (row: DbLeagueEventResultRow): LeagueEventResult => ({
  leagueId: row.league_id,
  leagueType: mapLeagueType(row.league_type),
  eventId: row.event_id,
  entryId: row.entry_id,
  entryName: row.entry_name,
  playerName: row.player_name,
  eventPoints: row.event_points,
  eventRank: row.event_rank,
  overallPoints: row.overall_points,
  overallRank: row.overall_rank,
});

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

const clampLimit = (limit: number): number => {
  const safeLimit = Number.isFinite(limit) ? limit : 50;
  return Math.min(Math.max(safeLimit, 1), 200);
};

interface LeaguesRepository {
  getEntryLeagues(context: GraphQLContext, entryId: number): Promise<League[]>;
  getLeagueStandings(
    context: GraphQLContext,
    leagueId: number,
    limit: number
  ): Promise<LeagueStanding[]>;
  getLeagueEventResults(
    context: GraphQLContext,
    leagueId: number,
    eventId: number
  ): Promise<LeagueEventResult[]>;
}

export const leaguesRepository: LeaguesRepository = {
  async getEntryLeagues(context: GraphQLContext, entryId: number): Promise<League[]> {
    const cacheKey = `leagues:entry:${entryId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as League[];
    }

    const { data, error } = await context.supabase
      .from('entry_league_infos')
      .select('*')
      .eq('entry_id', entryId)
      .order('league_id', { ascending: true });

    if (error) {
      context.logger.error({ err: error, entryId }, 'Failed to fetch entry leagues');
      throw new Error('Failed to fetch entry leagues');
    }

    const leagues = (data as DbEntryLeagueRow[] | null)?.map(mapLeague) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(leagues), 'EX', env.CACHE_TTL_SECONDS);
    return leagues;
  },

  async getLeagueStandings(
    context: GraphQLContext,
    leagueId: number,
    limit: number
  ): Promise<LeagueStanding[]> {
    const safeLimit = clampLimit(limit);
    const cacheKey = `leagues:standings:${stableStringify({ leagueId, limit: safeLimit })}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as LeagueStanding[];
    }

    const { data, error } = await context.supabase
      .from('entry_league_infos')
      .select('*')
      .eq('league_id', leagueId)
      .order('entry_rank', { ascending: true })
      .limit(safeLimit);

    if (error) {
      context.logger.error({ err: error, leagueId }, 'Failed to fetch league standings');
      throw new Error('Failed to fetch league standings');
    }

    const standings = (data as DbEntryLeagueRow[] | null)?.map(mapLeagueStanding) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(standings), 'EX', env.CACHE_TTL_SECONDS);
    return standings;
  },

  async getLeagueEventResults(
    context: GraphQLContext,
    leagueId: number,
    eventId: number
  ): Promise<LeagueEventResult[]> {
    const cacheKey = `leagues:results:${stableStringify({ leagueId, eventId })}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as LeagueEventResult[];
    }

    const { data, error } = await context.supabase
      .from('league_event_results')
      .select('*')
      .eq('league_id', leagueId)
      .eq('event_id', eventId)
      .order('event_rank', { ascending: true });

    if (error) {
      context.logger.error(
        { err: error, leagueId, eventId },
        'Failed to fetch league event results'
      );
      throw new Error('Failed to fetch league event results');
    }

    const results = (data as DbLeagueEventResultRow[] | null)?.map(mapLeagueEventResult) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(results), 'EX', env.CACHE_TTL_SECONDS);
    return results;
  },
};
