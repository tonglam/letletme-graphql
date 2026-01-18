import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

export type Event = {
  id: number;
  name: string;
  deadlineTime: string | null;
  averageEntryScore: number | null;
  finished: boolean;
  dataChecked: boolean;
  highestScoringEntry: number | null;
  deadlineTimeEpoch: number | null;
  deadlineTimeGameOffset: number | null;
  highestScore: number | null;
  isPrevious: boolean;
  isCurrent: boolean;
  isNext: boolean;
  cupLeagueCreate: boolean;
  h2hKoMatchesCreated: boolean;
  chipPlays: unknown[] | null;
  mostSelected: number | null;
  mostTransferredIn: number | null;
  topElement: number | null;
  topElementInfo: unknown | null;
  transfersMade: number | null;
  mostCaptained: number | null;
  mostViceCaptained: number | null;
};

export type EventsFilter = {
  isPrevious?: boolean | null;
  isCurrent?: boolean | null;
  isNext?: boolean | null;
  finished?: boolean | null;
  dataChecked?: boolean | null;
};

type DbEventRow = {
  id: number;
  name: string;
  deadline_time: string | null;
  average_entry_score: number | null;
  finished: boolean;
  data_checked: boolean;
  highest_scoring_entry: number | null;
  deadline_time_epoch: number | null;
  deadline_time_game_offset: number | null;
  highest_score: number | null;
  is_previous: boolean;
  is_current: boolean;
  is_next: boolean;
  cup_league_create: boolean;
  h2h_ko_matches_created: boolean;
  chip_plays: unknown[] | null;
  most_selected: number | null;
  most_transferred_in: number | null;
  top_element: number | null;
  top_element_info: unknown | null;
  transfers_made: number | null;
  most_captained: number | null;
  most_vice_captained: number | null;
};

const mapEvent = (row: DbEventRow): Event => ({
  id: row.id,
  name: row.name,
  deadlineTime: row.deadline_time, // Already ISO 8601 string from DB
  averageEntryScore: row.average_entry_score,
  finished: row.finished,
  dataChecked: row.data_checked,
  highestScoringEntry: row.highest_scoring_entry,
  deadlineTimeEpoch: row.deadline_time_epoch,
  deadlineTimeGameOffset: row.deadline_time_game_offset,
  highestScore: row.highest_score,
  isPrevious: row.is_previous,
  isCurrent: row.is_current,
  isNext: row.is_next,
  cupLeagueCreate: row.cup_league_create,
  h2hKoMatchesCreated: row.h2h_ko_matches_created,
  chipPlays: row.chip_plays,
  mostSelected: row.most_selected,
  mostTransferredIn: row.most_transferred_in,
  topElement: row.top_element,
  topElementInfo: row.top_element_info,
  transfersMade: row.transfers_made,
  mostCaptained: row.most_captained,
  mostViceCaptained: row.most_vice_captained,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

const normalizeFilter = (filter?: EventsFilter | null): EventsFilter | undefined => {
  if (!filter) {
    return undefined;
  }
  return {
    isPrevious: filter.isPrevious ?? undefined,
    isCurrent: filter.isCurrent ?? undefined,
    isNext: filter.isNext ?? undefined,
    finished: filter.finished ?? undefined,
    dataChecked: filter.dataChecked ?? undefined,
  };
};

const clampLimit = (limit: number): number => {
  const safeLimit = Number.isFinite(limit) ? limit : 50;
  return Math.min(Math.max(safeLimit, 1), 200);
};

export type CurrentEventInfo = {
  currentEvent: number;
  nextUtcDeadline: string | null;
};

interface EventsRepository {
  getEventById(context: GraphQLContext, id: number): Promise<Event | null>;
  listEvents(
    context: GraphQLContext,
    filter: EventsFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Event[]>;
  getCurrentEventInfo(context: GraphQLContext): Promise<CurrentEventInfo | null>;
}

export const eventsRepository: EventsRepository = {
  async getEventById(context: GraphQLContext, id: number): Promise<Event | null> {
    const cacheKey = `events:id:${id}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Event;
    }

    const { data, error } = await context.supabase.from('events').select('*').eq('id', id).limit(1);

    if (error) {
      context.logger.error({ err: error, id }, 'Failed to fetch event');
      throw new Error('Failed to fetch event');
    }

    const row = data?.[0] as DbEventRow | undefined;
    if (!row) {
      return null;
    }

    const event = mapEvent(row);
    await context.redis.set(cacheKey, JSON.stringify(event), 'EX', env.CACHE_TTL_SECONDS);
    return event;
  },

  async getCurrentEventInfo(context: GraphQLContext): Promise<CurrentEventInfo | null> {
    const cacheKey = 'events:currentEventInfo';
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as CurrentEventInfo;
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
      return null;
    }

    // Get next event deadline
    const { data: nextData, error: nextError } = await context.supabase
      .from('events')
      .select('deadline_time')
      .eq('is_next', true)
      .limit(1);

    if (nextError) {
      context.logger.error({ err: nextError }, 'Failed to fetch next event deadline');
      // Continue with null deadline if error occurs
    }

    const nextDeadline = (nextData?.[0] as { deadline_time: string | null } | undefined)
      ?.deadline_time ?? null;

    const result: CurrentEventInfo = {
      currentEvent: currentEventId,
      nextUtcDeadline: nextDeadline ?? null, // Already ISO 8601 string from DB
    };

    await context.redis.set(cacheKey, JSON.stringify(result), 'EX', env.CACHE_TTL_SECONDS);
    return result;
  },

  async listEvents(
    context: GraphQLContext,
    filter: EventsFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Event[]> {
    const normalizedFilter = normalizeFilter(filter);
    const safeLimit = clampLimit(limit);
    const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);
    const cacheKey = `events:list:${stableStringify({
      filter: normalizedFilter ?? null,
      limit: safeLimit,
      offset: safeOffset,
    })}`;

    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Event[];
    }

    let query = context.supabase.from('events').select('*');

    if (normalizedFilter?.isPrevious !== undefined) {
      query = query.eq('is_previous', normalizedFilter.isPrevious);
    }
    if (normalizedFilter?.isCurrent !== undefined) {
      query = query.eq('is_current', normalizedFilter.isCurrent);
    }
    if (normalizedFilter?.isNext !== undefined) {
      query = query.eq('is_next', normalizedFilter.isNext);
    }
    if (normalizedFilter?.finished !== undefined) {
      query = query.eq('finished', normalizedFilter.finished);
    }
    if (normalizedFilter?.dataChecked !== undefined) {
      query = query.eq('data_checked', normalizedFilter.dataChecked);
    }

    const { data, error } = await query
      .order('id', { ascending: true })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (error) {
      context.logger.error({ err: error, filter: normalizedFilter }, 'Failed to fetch events');
      throw new Error('Failed to fetch events');
    }

    const events = (data as DbEventRow[] | null)?.map(mapEvent) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(events), 'EX', env.CACHE_TTL_SECONDS);
    return events;
  },
};
