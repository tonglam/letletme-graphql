import type { GraphQLContext } from '../../graphql/context';

const LIVE_CACHE_TTL = 30; // 30 seconds for live data

export type LivePerformance = {
  eventId: number;
  playerId: number;
  minutes: number | null;
  goalsScored: number | null;
  assists: number | null;
  cleanSheets: number | null;
  goalsConceded: number | null;
  ownGoals: number | null;
  penaltiesSaved: number | null;
  penaltiesMissed: number | null;
  yellowCards: number | null;
  redCards: number | null;
  saves: number | null;
  bonus: number | null;
  bps: number | null;
  starts: boolean | null;
  defensiveContribution: number | null;
  expectedGoals: string | null;
  expectedAssists: string | null;
  expectedGoalInvolvements: string | null;
  expectedGoalsConceded: string | null;
  inDreamTeam: boolean | null;
  totalPoints: number;
};

export type LiveExplainStatContribution = {
  identifier: string;
  points: number;
  value: number | null;
  pointsModification: number | null;
};

export type LiveExplainBreakdown = {
  fixtureId: number;
  stats: LiveExplainStatContribution[];
};

export type LiveExplainStats = {
  minutes: number | null;
  goalsScored: number | null;
  assists: number | null;
  cleanSheets: number | null;
  goalsConceded: number | null;
  ownGoals: number | null;
  penaltiesSaved: number | null;
  penaltiesMissed: number | null;
  yellowCards: number | null;
  redCards: number | null;
  saves: number | null;
  bonus: number | null;
  bps: number | null;
  influence: number | null;
  creativity: number | null;
  threat: number | null;
  ictIndex: number | null;
  clearancesBlocksInterceptions: number | null;
  recoveries: number | null;
  tackles: number | null;
  defensiveContribution: number | null;
  starts: number | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  expectedGoalInvolvements: number | null;
  expectedGoalsConceded: number | null;
  totalPoints: number | null;
  inDreamTeam: boolean | null;
};

export type LiveExplain = {
  eventId: number;
  elementId: number;
  modified: boolean | null;
  stats: LiveExplainStats;
  breakdown: LiveExplainBreakdown[];
  selectedBy: number | null;
};

type DbLiveRow = {
  event_id: number;
  element_id: number;
  minutes: number | null;
  goals_scored: number | null;
  assists: number | null;
  clean_sheets: number | null;
  goals_conceded: number | null;
  own_goals: number | null;
  penalties_saved: number | null;
  penalties_missed: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  saves: number | null;
  bonus: number | null;
  bps: number | null;
  starts: boolean | null;
  defensive_contribution: number | null;
  expected_goals: string | null;
  expected_assists: string | null;
  expected_goal_involvements: string | null;
  expected_goals_conceded: string | null;
  in_dream_team: boolean | null;
  total_points: number;
};

type JsonRecord = Record<string, unknown>;

type DbLiveExplainStats = JsonRecord;

type DbLiveExplainBreakdownStat = JsonRecord;

type DbLiveExplainBreakdown = JsonRecord & {
  stats?: DbLiveExplainBreakdownStat[] | string | null;
};

type DbLiveExplainRow = {
  event_id: number;
  element_id?: number | null;
  element?: number | null;
  stats?: DbLiveExplainStats | string | null;
  explain?: DbLiveExplainBreakdown[] | string | null;
  modified?: boolean | number | string | null;
};

type DbPlayerStatsSelectedByRow = {
  selected_by?: number | string | null;
  selected_by_percent?: number | string | null;
};

const mapLivePerformance = (row: DbLiveRow): LivePerformance => ({
  eventId: row.event_id,
  playerId: row.element_id,
  minutes: row.minutes,
  goalsScored: row.goals_scored,
  assists: row.assists,
  cleanSheets: row.clean_sheets,
  goalsConceded: row.goals_conceded,
  ownGoals: row.own_goals,
  penaltiesSaved: row.penalties_saved,
  penaltiesMissed: row.penalties_missed,
  yellowCards: row.yellow_cards,
  redCards: row.red_cards,
  saves: row.saves,
  bonus: row.bonus,
  bps: row.bps,
  starts: row.starts,
  defensiveContribution: row.defensive_contribution,
  expectedGoals: row.expected_goals,
  expectedAssists: row.expected_assists,
  expectedGoalInvolvements: row.expected_goal_involvements,
  expectedGoalsConceded: row.expected_goals_conceded,
  inDreamTeam: row.in_dream_team,
  totalPoints: row.total_points,
});

const parseNumericValue = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseIntegerValue = (value: unknown): number | null => {
  const parsed = parseNumericValue(value);
  return parsed === null ? null : Math.trunc(parsed);
};

const parseBooleanValue = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 't') {
      return true;
    }
    if (normalized === 'false' || normalized === 'f') {
      return false;
    }
    if (normalized === '1') {
      return true;
    }
    if (normalized === '0') {
      return false;
    }
  }
  return null;
};

const parseObjectValue = <T extends object>(value: unknown): T | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') {
    return value as T;
  }
  return null;
};

const parseArrayValue = <T>(value: unknown): T[] | null => {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : null;
    } catch {
      return null;
    }
  }
  return null;
};

const pickRecordValue = (
  source: Record<string, unknown> | null | undefined,
  ...keys: string[]
): unknown => {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined) {
        return value;
      }
    }
  }
  return null;
};

const mapLiveExplainStats = (statsValue: DbLiveExplainStats | null): LiveExplainStats => {
  const stats: DbLiveExplainStats = statsValue ?? {};
  return {
    minutes: parseIntegerValue(pickRecordValue(stats, 'minutes')),
    goalsScored: parseIntegerValue(pickRecordValue(stats, 'goals_scored', 'goalsScored')),
    assists: parseIntegerValue(pickRecordValue(stats, 'assists')),
    cleanSheets: parseIntegerValue(pickRecordValue(stats, 'clean_sheets', 'cleanSheets')),
    goalsConceded: parseIntegerValue(pickRecordValue(stats, 'goals_conceded', 'goalsConceded')),
    ownGoals: parseIntegerValue(pickRecordValue(stats, 'own_goals', 'ownGoals')),
    penaltiesSaved: parseIntegerValue(pickRecordValue(stats, 'penalties_saved', 'penaltiesSaved')),
    penaltiesMissed: parseIntegerValue(pickRecordValue(stats, 'penalties_missed', 'penaltiesMissed')),
    yellowCards: parseIntegerValue(pickRecordValue(stats, 'yellow_cards', 'yellowCards')),
    redCards: parseIntegerValue(pickRecordValue(stats, 'red_cards', 'redCards')),
    saves: parseIntegerValue(pickRecordValue(stats, 'saves')),
    bonus: parseIntegerValue(pickRecordValue(stats, 'bonus')),
    bps: parseIntegerValue(pickRecordValue(stats, 'bps')),
    influence: parseNumericValue(pickRecordValue(stats, 'influence')),
    creativity: parseNumericValue(pickRecordValue(stats, 'creativity')),
    threat: parseNumericValue(pickRecordValue(stats, 'threat')),
    ictIndex: parseNumericValue(pickRecordValue(stats, 'ict_index', 'ictIndex')),
    clearancesBlocksInterceptions: parseIntegerValue(
      pickRecordValue(stats, 'clearances_blocks_interceptions', 'clearancesBlocksInterceptions')
    ),
    recoveries: parseIntegerValue(pickRecordValue(stats, 'recoveries')),
    tackles: parseIntegerValue(pickRecordValue(stats, 'tackles')),
    defensiveContribution: parseIntegerValue(
      pickRecordValue(stats, 'defensive_contribution', 'defensiveContribution')
    ),
    starts: parseIntegerValue(pickRecordValue(stats, 'starts')),
    expectedGoals: parseNumericValue(pickRecordValue(stats, 'expected_goals', 'expectedGoals')),
    expectedAssists: parseNumericValue(pickRecordValue(stats, 'expected_assists', 'expectedAssists')),
    expectedGoalInvolvements: parseNumericValue(
      pickRecordValue(stats, 'expected_goal_involvements', 'expectedGoalInvolvements')
    ),
    expectedGoalsConceded: parseNumericValue(
      pickRecordValue(stats, 'expected_goals_conceded', 'expectedGoalsConceded')
    ),
    totalPoints: parseIntegerValue(pickRecordValue(stats, 'total_points', 'totalPoints')),
    inDreamTeam: parseBooleanValue(pickRecordValue(stats, 'in_dreamteam', 'inDreamTeam')),
  };
};

const mapLiveExplainBreakdownStat = (
  stat: DbLiveExplainBreakdownStat | null
): LiveExplainStatContribution | null => {
  if (!stat || typeof stat !== 'object' || Array.isArray(stat)) {
    return null;
  }
  const identifierValue = pickRecordValue(stat, 'identifier');
  const identifier = typeof identifierValue === 'string' ? identifierValue : null;
  if (!identifier || identifier.trim().length === 0) {
    return null;
  }
  return {
    identifier,
    points: parseIntegerValue(pickRecordValue(stat, 'points')) ?? 0,
    value: parseNumericValue(pickRecordValue(stat, 'value')),
    pointsModification: parseIntegerValue(
      pickRecordValue(stat, 'points_modification', 'pointsModification')
    ),
  };
};

const mapLiveExplainBreakdown = (
  explainValue: DbLiveExplainBreakdown[] | null
): LiveExplainBreakdown[] => {
  if (!explainValue) {
    return [];
  }

  const breakdowns: LiveExplainBreakdown[] = [];

  for (const entry of explainValue) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const fixtureId = parseIntegerValue(pickRecordValue(entry, 'fixture', 'fixtureId'));
    if (fixtureId === null) {
      continue;
    }

    const rawStats = Array.isArray(entry.stats)
      ? entry.stats
      : parseArrayValue<DbLiveExplainBreakdownStat>(entry.stats ?? null);

    const statsList = (rawStats ?? [])
      .map((stat) => mapLiveExplainBreakdownStat(stat ?? null))
      .filter((stat): stat is LiveExplainStatContribution => stat !== null);

    breakdowns.push({ fixtureId, stats: statsList });
  }

  return breakdowns;
};

const resolveElementId = (row: DbLiveExplainRow): number => {
  const elementId = row.element_id ?? row.element;
  if (typeof elementId === 'number') {
    return elementId;
  }
  throw new Error('Event live explain row missing element identifier');
};

const mapLiveExplainRow = (
  row: DbLiveExplainRow,
  elementId: number,
  selectedBy: number | null
): LiveExplain => {
  const statsObject = parseObjectValue<DbLiveExplainStats>(row.stats ?? null);
  const breakdownArray = parseArrayValue<DbLiveExplainBreakdown>(row.explain ?? null);
  return {
    eventId: row.event_id,
    elementId,
    modified: parseBooleanValue(row.modified),
    stats: mapLiveExplainStats(statsObject),
    breakdown: mapLiveExplainBreakdown(breakdownArray),
    selectedBy,
  };
};

export type LiveScoresFilter = {
  inDreamTeam?: boolean | null;
  minTotalPoints?: number | null;
  maxTotalPoints?: number | null;
};

export type EventLive = {
  eventId: number;
  performances: LivePerformance[];
};

interface LiveRepository {
  getLiveScores(
    context: GraphQLContext,
    eventId?: number,
    filter?: LiveScoresFilter | null
  ): Promise<LivePerformance[]>;
  getPlayerLive(
    context: GraphQLContext,
    playerId: number,
    eventId?: number
  ): Promise<LivePerformance | null>;
  getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive>;
  getEventLiveExplain(
    context: GraphQLContext,
    eventId: number,
    elementId: number
  ): Promise<LiveExplain | null>;
  getLivePerformancesByPlayerIds(
    context: GraphQLContext,
    eventId: number,
    playerIds: number[]
  ): Promise<LivePerformance[]>;
}

const fetchEventLiveExplainRow = async (
  context: GraphQLContext,
  eventId: number,
  elementId: number
): Promise<DbLiveExplainRow | null> => {
  const cacheKey = `live:explain:event:${eventId}`;
  const field = String(elementId);
  const cached = await context.redis.hget(cacheKey, field);
  if (cached) {
    try {
      return JSON.parse(cached) as DbLiveExplainRow;
    } catch (error) {
      context.logger.warn(
        { err: error, cacheKey, field },
        'Failed to parse cached event live explain row'
      );
    }
  }

  let { data, error } = await context.supabase
    .from('event_live_explains')
    .select('*')
    .eq('event_id', eventId)
    .eq('element_id', elementId)
    .limit(1);

  if (error && error.message && error.message.includes('element_id')) {
    ({ data, error } = await context.supabase
      .from('event_live_explains')
      .select('*')
      .eq('event_id', eventId)
      .eq('element', elementId)
      .limit(1));
  }

  if (error) {
    context.logger.error(
      { err: error, eventId, elementId },
      'Failed to fetch event live explain row'
    );
    throw new Error('Failed to fetch event live explain');
  }

  const row = data?.[0] as DbLiveExplainRow | undefined;
  if (!row) {
    return null;
  }

  await context.redis.hset(cacheKey, field, JSON.stringify(row));
  await context.redis.expire(cacheKey, LIVE_CACHE_TTL);
  return row;
};

const fetchSelectedByPercent = async (
  context: GraphQLContext,
  eventId: number,
  elementId: number
): Promise<number | null> => {
  const cacheKey = `live:explain:playerstats:${eventId}`;
  const field = String(elementId);
  const cached = await context.redis.hget(cacheKey, field);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as DbPlayerStatsSelectedByRow;
      return parseNumericValue(parsed.selected_by ?? parsed.selected_by_percent ?? null);
    } catch (error) {
      context.logger.warn(
        { err: error, cacheKey, field },
        'Failed to parse cached player stats for selected_by'
      );
    }
  }

  const { data, error } = await context.supabase
    .from('player_stats')
    .select('selected_by, selected_by_percent')
    .eq('event_id', eventId)
    .eq('element_id', elementId)
    .limit(1);

  if (error) {
    context.logger.warn(
      { err: error, eventId, elementId },
      'Failed to fetch selected_by for event live explain'
    );
    return null;
  }

  const row = data?.[0] as DbPlayerStatsSelectedByRow | undefined;
  if (!row) {
    return null;
  }

  await context.redis.hset(cacheKey, field, JSON.stringify(row));
  await context.redis.expire(cacheKey, LIVE_CACHE_TTL);
  return parseNumericValue(row.selected_by ?? row.selected_by_percent ?? null);
};

export const liveRepository: LiveRepository = {
  async getLiveScores(
    context: GraphQLContext,
    eventId?: number,
    filter?: LiveScoresFilter | null
  ): Promise<LivePerformance[]> {
    let targetEventId = eventId;

    // If no eventId provided, get current event
    if (!targetEventId) {
      const { data: currentData, error: currentError } = await context.supabase
        .from('events')
        .select('id')
        .eq('is_current', true)
        .limit(1);

      if (currentError) {
        context.logger.error(
          { err: currentError },
          'Failed to fetch current event for live scores'
        );
        throw new Error('Failed to fetch current event');
      }

      targetEventId = (currentData?.[0] as { id: number } | undefined)?.id;
      if (!targetEventId) {
        return [];
      }
    }

    // Build cache key including filter
    const filterParts: string[] = [];
    if (filter?.inDreamTeam !== undefined && filter.inDreamTeam !== null) {
      filterParts.push(`dreamteam:${filter.inDreamTeam}`);
    }
    if (filter?.minTotalPoints !== undefined && filter.minTotalPoints !== null) {
      filterParts.push(`minPoints:${filter.minTotalPoints}`);
    }
    if (filter?.maxTotalPoints !== undefined && filter.maxTotalPoints !== null) {
      filterParts.push(`maxPoints:${filter.maxTotalPoints}`);
    }
    const filterKey = filterParts.length > 0 ? `:${filterParts.join(':')}` : '';
    const cacheKey = `live:scores:${targetEventId}${filterKey}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as LivePerformance[];
    }

    let query = context.supabase
      .from('event_lives')
      .select('*')
      .eq('event_id', targetEventId);

    // Apply filters if provided
    if (filter?.inDreamTeam !== undefined && filter.inDreamTeam !== null) {
      query = query.eq('in_dream_team', filter.inDreamTeam);
    }
    if (filter?.minTotalPoints !== undefined && filter.minTotalPoints !== null) {
      query = query.gte('total_points', filter.minTotalPoints);
    }
    if (filter?.maxTotalPoints !== undefined && filter.maxTotalPoints !== null) {
      query = query.lte('total_points', filter.maxTotalPoints);
    }

    const { data, error } = await query;

    if (error) {
      context.logger.error({ err: error, eventId: targetEventId, filter }, 'Failed to fetch live scores');
      throw new Error('Failed to fetch live scores');
    }

    const performances = (data as DbLiveRow[] | null)?.map(mapLivePerformance) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(performances), 'EX', LIVE_CACHE_TTL);
    return performances;
  },

  async getPlayerLive(
    context: GraphQLContext,
    playerId: number,
    eventId?: number
  ): Promise<LivePerformance | null> {
    let targetEventId = eventId;

    // If no eventId provided, get current event
    if (!targetEventId) {
      const { data: currentData, error: currentError } = await context.supabase
        .from('events')
        .select('id')
        .eq('is_current', true)
        .limit(1);

      if (currentError) {
        context.logger.error(
          { err: currentError },
          'Failed to fetch current event for player live'
        );
        throw new Error('Failed to fetch current event');
      }

      targetEventId = (currentData?.[0] as { id: number } | undefined)?.id;
      if (!targetEventId) {
        return null;
      }
    }

    const cacheKey = `live:player:${playerId}:${targetEventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as LivePerformance;
    }

    const { data, error } = await context.supabase
      .from('event_lives')
      .select('*')
      .eq('event_id', targetEventId)
      .eq('element_id', playerId)
      .limit(1);

    if (error) {
      context.logger.error(
        { err: error, playerId, eventId: targetEventId },
        'Failed to fetch player live'
      );
      throw new Error('Failed to fetch player live performance');
    }

    const row = data?.[0] as DbLiveRow | undefined;
    if (!row) {
      return null;
    }

    const performance = mapLivePerformance(row);
    await context.redis.set(cacheKey, JSON.stringify(performance), 'EX', LIVE_CACHE_TTL);
    return performance;
  },

  async getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive> {
    const cacheKey = `live:event:${eventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as EventLive;
    }

    const { data, error } = await context.supabase
      .from('event_lives')
      .select('*')
      .eq('event_id', eventId);

    if (error) {
      context.logger.error({ err: error, eventId }, 'Failed to fetch event live data');
      throw new Error('Failed to fetch event live data');
    }

    const performances = (data as DbLiveRow[] | null)?.map(mapLivePerformance) ?? [];

    const eventLive: EventLive = {
      eventId,
      performances,
    };

    await context.redis.set(cacheKey, JSON.stringify(eventLive), 'EX', LIVE_CACHE_TTL);
    return eventLive;
  },

  async getEventLiveExplain(
    context: GraphQLContext,
    eventId: number,
    elementId: number
  ): Promise<LiveExplain | null> {
    const cacheKey = `live:explain:${eventId}:${elementId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as LiveExplain;
    }

    const row = await fetchEventLiveExplainRow(context, eventId, elementId);
    if (!row) {
      return null;
    }

    let resolvedElementId: number;
    try {
      resolvedElementId = resolveElementId(row);
    } catch (err) {
      context.logger.error(
        { err, eventId, elementId },
        'Event live explain row missing element identifier'
      );
      throw new Error('Failed to parse event live explain data');
    }

    const selectedBy = await fetchSelectedByPercent(context, eventId, resolvedElementId);
    const liveExplain = mapLiveExplainRow(row, resolvedElementId, selectedBy);
    await context.redis.set(cacheKey, JSON.stringify(liveExplain), 'EX', LIVE_CACHE_TTL);
    return liveExplain;
  },

  async getLivePerformancesByPlayerIds(
    context: GraphQLContext,
    eventId: number,
    playerIds: number[]
  ): Promise<LivePerformance[]> {
    if (!eventId || !Number.isFinite(eventId) || eventId <= 0) {
      throw new Error('eventId is required to fetch live performances');
    }

    const uniqueIds = Array.from(new Set(playerIds.filter((id) => Number.isFinite(id) && id > 0)));
    if (uniqueIds.length === 0) {
      return [];
    }

    const { data, error } = await context.supabase
      .from('event_lives')
      .select('*')
      .eq('event_id', eventId)
      .in('element_id', uniqueIds);

    if (error) {
      context.logger.error(
        { err: error, eventId, playerIds: uniqueIds },
        'Failed to fetch live performances by player IDs'
      );
      throw new Error('Failed to fetch live performances');
    }

    return (data as DbLiveRow[] | null)?.map(mapLivePerformance) ?? [];
  },
};
