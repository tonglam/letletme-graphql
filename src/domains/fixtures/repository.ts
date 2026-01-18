import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

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
    const cacheKey = `fixtures:id:${id}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
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
    const cacheKey = `fixtures:event:${eventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Fixture[];
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
