import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';
import { getCurrentSeason } from '../../infra/season';

export type Fixture = {
  id: number;
  code: number;
  eventId: number | null;
  finished: boolean;
  finishedProvisional: boolean;
  kickoffTime: string | null;
  minutes: number;
  started: boolean | null;
  teamHId: number;
  teamAId: number;
  teamHScore: number | null;
  teamAScore: number | null;
  teamHDifficulty: number | null;
  teamADifficulty: number | null;
};

export type FixturesFilter = {
  eventId?: number | null;
  teamId?: number | null;
  finished?: boolean | null;
};

type DbFixtureRow = {
  id: number;
  code: number;
  event_id: number | null;
  finished: boolean;
  finished_provisional: boolean;
  kickoff_time: string | null;
  minutes: number;
  started: boolean | null;
  team_h_id: number;
  team_a_id: number;
  team_h_score: number | null;
  team_a_score: number | null;
  team_h_difficulty: number | null;
  team_a_difficulty: number | null;
};

const toIso = (value: string | Date | null): string | null => {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString();
};

const mapFixture = (row: DbFixtureRow): Fixture => ({
  id: row.id,
  code: row.code,
  eventId: row.event_id,
  finished: row.finished,
  finishedProvisional: row.finished_provisional,
  kickoffTime: toIso(row.kickoff_time),
  minutes: row.minutes,
  started: row.started,
  teamHId: row.team_h_id,
  teamAId: row.team_a_id,
  teamHScore: row.team_h_score,
  teamAScore: row.team_a_score,
  teamHDifficulty: row.team_h_difficulty,
  teamADifficulty: row.team_a_difficulty,
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

const normalizeFilter = (filter?: FixturesFilter | null): FixturesFilter | undefined => {
  if (!filter) {
    return undefined;
  }
  return {
    eventId: filter.eventId ?? undefined,
    teamId: filter.teamId ?? undefined,
    finished: filter.finished ?? undefined,
  };
};

const clampLimit = (limit: number): number => {
  const safeLimit = Number.isFinite(limit) ? limit : 50;
  return Math.min(Math.max(safeLimit, 1), 200);
};

const asNum = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const asBool = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1 ? true : value === 0 ? false : null;
  }
  if (typeof value === 'string') {
    const n = value.trim().toLowerCase();
    if (n === 'true' || n === '1') return true;
    if (n === 'false' || n === '0') return false;
  }
  return null;
};

const asStr = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const NULL_SENTINEL = '__fixtures:null__';

const parseJsonUnknown = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const mapSyncJobFixture = (raw: unknown): Fixture | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;

  const id = asNum(row.id);
  const code = asNum(row.code);
  const eventId = asNum(row.event ?? row.event_id);
  const teamH = asNum(row.teamH ?? row.team_h ?? row.teamHId ?? row.team_h_id);
  const teamA = asNum(row.teamA ?? row.team_a ?? row.teamAId ?? row.team_a_id);

  if (id === null || eventId === null || teamH === null || teamA === null) {
    return null;
  }

  const finished = asBool(row.finished) ?? false;
  const finishedProvisional = asBool(row.finishedProvisional ?? row.finished_provisional) ?? false;
  const kickoffTime = asStr(row.kickoffTime ?? row.kickoff_time);
  const minutes = asNum(row.minutes) ?? 0;
  const started = asBool(row.started);

  const teamHScore = asNum(row.teamHScore ?? row.team_h_score ?? row.teamHScore);
  const teamAScore = asNum(row.teamAScore ?? row.team_a_score ?? row.teamAScore);
  const teamHDifficulty = asNum(row.teamHDifficulty ?? row.team_h_difficulty);
  const teamADifficulty = asNum(row.teamADifficulty ?? row.team_a_difficulty);

  return {
    id: Math.trunc(id),
    code: Math.trunc(code ?? 0),
    eventId: Math.trunc(eventId),
    finished,
    finishedProvisional,
    kickoffTime: toIso(kickoffTime),
    minutes: Math.trunc(minutes),
    started,
    teamHId: Math.trunc(teamH),
    teamAId: Math.trunc(teamA),
    teamHScore: teamHScore !== null ? Math.trunc(teamHScore) : null,
    teamAScore: teamAScore !== null ? Math.trunc(teamAScore) : null,
    teamHDifficulty: teamHDifficulty !== null ? Math.trunc(teamHDifficulty) : null,
    teamADifficulty: teamADifficulty !== null ? Math.trunc(teamADifficulty) : null,
  };
};

const loadEventFixturesFromRedis = async (
  context: GraphQLContext,
  eventId: number
): Promise<Fixture[] | null> => {
  const season = await getCurrentSeason(context);
  const hashKey = `Fixtures:${season}:${eventId}`;

  let hashEntries: Record<string, string>;
  try {
    hashEntries = await context.redis.hgetall(hashKey);
  } catch (error) {
    context.logger.warn(
      { err: error, hashKey },
      'Failed to read Fixtures hash from Redis'
    );
    return null;
  }

  const fields = Object.values(hashEntries);
  if (fields.length === 0) {
    return null;
  }

  const fixtures: Fixture[] = [];
  for (const fieldValue of fields) {
    const parsed = parseJsonUnknown(fieldValue);
    const fixture = mapSyncJobFixture(parsed);
    if (fixture) {
      fixtures.push(fixture);
    }
  }

  fixtures.sort((a, b) => {
    if (!a.kickoffTime && !b.kickoffTime) return 0;
    if (!a.kickoffTime) return 1;
    if (!b.kickoffTime) return -1;
    return a.kickoffTime.localeCompare(b.kickoffTime);
  });

  return fixtures.length > 0 ? fixtures : null;
};

interface FixturesRepository {
  getFixtureById(context: GraphQLContext, id: number): Promise<Fixture | null>;
  listFixtures(
    context: GraphQLContext,
    filter: FixturesFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Fixture[]>;
  getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]>;
  getEventFixtures(context: GraphQLContext, eventId: number): Promise<Fixture[]>;
}

export const fixturesRepository: FixturesRepository = {
  async getFixtureById(context: GraphQLContext, id: number): Promise<Fixture | null> {
    if (!Number.isFinite(id) || id <= 0) {
      return null;
    }

    const cacheKey = `fixtures:id:${id}`;
    const cached = await context.redis.get(cacheKey);
    if (cached !== null) {
      if (cached === NULL_SENTINEL) {
        return null;
      }
      return JSON.parse(cached) as Fixture;
    }

    const { data, error } = await context.supabase
      .from('event_fixtures')
      .select('*')
      .eq('id', id)
      .limit(1);

    if (error) {
      context.logger.error({ err: error, id }, 'Failed to fetch fixture');
      throw new Error('Failed to fetch fixture');
    }

    const row = data?.[0] as DbFixtureRow | undefined;
    if (!row) {
      await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', env.CACHE_TTL_SECONDS);
      return null;
    }

    const fixture = mapFixture(row);
    await context.redis.set(cacheKey, JSON.stringify(fixture), 'EX', env.CACHE_TTL_SECONDS);
    return fixture;
  },

  async listFixtures(
    context: GraphQLContext,
    filter: FixturesFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Fixture[]> {
    const normalizedFilter = normalizeFilter(filter);
    const safeLimit = clampLimit(limit);
    const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);
    const cacheKey = `fixtures:list:${stableStringify({
      filter: normalizedFilter ?? null,
      limit: safeLimit,
      offset: safeOffset,
    })}`;

    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Fixture[];
    }

    let query = context.supabase.from('event_fixtures').select('*');

    if (normalizedFilter?.eventId !== undefined) {
      query = query.eq('event_id', normalizedFilter.eventId);
    }
    if (normalizedFilter?.finished !== undefined) {
      query = query.eq('finished', normalizedFilter.finished);
    }
    if (normalizedFilter?.teamId !== undefined) {
      query = query.or(
        `team_h_id.eq.${normalizedFilter.teamId},team_a_id.eq.${normalizedFilter.teamId}`
      );
    }

    const { data, error } = await query
      .order('kickoff_time', { ascending: true })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (error) {
      context.logger.error({ err: error, filter: normalizedFilter }, 'Failed to fetch fixtures');
      throw new Error('Failed to fetch fixtures');
    }

    const fixtures = (data as DbFixtureRow[] | null)?.map(mapFixture) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(fixtures), 'EX', env.CACHE_TTL_SECONDS);
    return fixtures;
  },

  async getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]> {
    const cacheKey = 'fixtures:current';
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Fixture[];
    }

    // Get current event
    const { data: currentData, error: currentError } = await context.supabase
      .from('events')
      .select('id')
      .eq('is_current', true)
      .limit(1);

    if (currentError) {
      context.logger.error({ err: currentError }, 'Failed to fetch current event');
      throw new Error('Failed to fetch current event');
    }

    const currentEventId = (currentData?.[0] as { id: number } | undefined)?.id;
    if (!currentEventId) {
      return [];
    }

    const { data, error } = await context.supabase
      .from('event_fixtures')
      .select('*')
      .eq('event_id', currentEventId)
      .order('kickoff_time', { ascending: true });

    if (error) {
      context.logger.error(
        { err: error, eventId: currentEventId },
        'Failed to fetch current fixtures'
      );
      throw new Error('Failed to fetch current fixtures');
    }

    const fixtures = (data as DbFixtureRow[] | null)?.map(mapFixture) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(fixtures), 'EX', env.CACHE_TTL_SECONDS);
    return fixtures;
  },

  async getEventFixtures(context: GraphQLContext, eventId: number): Promise<Fixture[]> {
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return [];
    }

    const cacheKey = `fixtures:event:${eventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Fixture[];
    }

    const fromRedis = await loadEventFixturesFromRedis(context, eventId);
    if (fromRedis) {
      await context.redis.set(cacheKey, JSON.stringify(fromRedis), 'EX', env.CACHE_TTL_SECONDS);
      return fromRedis;
    }

    const { data, error } = await context.supabase
      .from('event_fixtures')
      .select('*')
      .eq('event_id', eventId)
      .order('kickoff_time', { ascending: true });

    if (error) {
      context.logger.error({ err: error, eventId }, 'Failed to fetch event fixtures');
      throw new Error('Failed to fetch event fixtures');
    }

    const fixtures = (data as DbFixtureRow[] | null)?.map(mapFixture) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(fixtures), 'EX', env.CACHE_TTL_SECONDS);
    return fixtures;
  },
};
