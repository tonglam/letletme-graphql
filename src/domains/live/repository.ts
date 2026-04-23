import type { GraphQLContext } from '../../graphql/context';
import { getCurrentSeason } from '../../infra/season';

const NULL_SENTINEL = '__live:null__';

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

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1 ? true : value === 0 ? false : null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }
  return null;
};

const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const parseJsonUnknown = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const mapSyncJobLiveRow = (raw: unknown): LivePerformance | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;

  const eventId = asNumber(row.eventId ?? row.event_id);
  const elementId = asNumber(row.elementId ?? row.element_id);
  if (eventId === null || elementId === null) {
    return null;
  }

  const startsRaw = row.starts ?? row.starts;
  const startsValue = asBoolean(startsRaw);

  return {
    eventId: Math.trunc(eventId),
    playerId: Math.trunc(elementId),
    minutes: asNumber(row.minutes),
    goalsScored: asNumber(row.goalsScored ?? row.goals_scored),
    assists: asNumber(row.assists),
    cleanSheets: asNumber(row.cleanSheets ?? row.clean_sheets),
    goalsConceded: asNumber(row.goalsConceded ?? row.goals_conceded),
    ownGoals: asNumber(row.ownGoals ?? row.own_goals),
    penaltiesSaved: asNumber(row.penaltiesSaved ?? row.penalties_saved),
    penaltiesMissed: asNumber(row.penaltiesMissed ?? row.penalties_missed),
    yellowCards: asNumber(row.yellowCards ?? row.yellow_cards),
    redCards: asNumber(row.redCards ?? row.red_cards),
    saves: asNumber(row.saves),
    bonus: asNumber(row.bonus),
    bps: asNumber(row.bps),
    starts: startsValue,
    defensiveContribution: asNumber(row.defensiveContribution ?? row.defensive_contribution),
    expectedGoals: asString(row.expectedGoals ?? row.expected_goals) ?? null,
    expectedAssists: asString(row.expectedAssists ?? row.expected_assists) ?? null,
    expectedGoalInvolvements: asString(row.expectedGoalInvolvements ?? row.expected_goal_involvements) ?? null,
    expectedGoalsConceded: asString(row.expectedGoalsConceded ?? row.expected_goals_conceded) ?? null,
    inDreamTeam: asBoolean(row.inDreamTeam ?? row.in_dream_team),
    totalPoints: asNumber(row.totalPoints ?? row.total_points) ?? 0,
  };
};

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

const resolveElementId = (row: DbLiveExplainRow): number | null => {
  const elementId = row.element_id ?? row.element;
  if (typeof elementId === 'number') {
    return elementId;
  }
  return null;
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
  getAllLivePerformances(
    context: GraphQLContext,
    eventId: number
  ): Promise<Map<number, LivePerformance>>;
  getSelectedByPercent(
    context: GraphQLContext,
    eventId: number,
    elementId: number
  ): Promise<number | null>;
}

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
  await context.redis.expire(cacheKey, 30);
  return parseNumericValue(row.selected_by ?? row.selected_by_percent ?? null);
};

const _fetchLivePerformanceFromDbByPlayerIds = async (
  context: GraphQLContext,
  eventId: number,
  playerIds: number[]
): Promise<LivePerformance[]> => {
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
};

const fetchAllLivePerformanceFromDb = async (
  context: GraphQLContext,
  eventId: number
): Promise<LivePerformance[]> => {
  const { data, error } = await context.supabase
    .from('event_lives')
    .select('*')
    .eq('event_id', eventId);

  if (error) {
    context.logger.error(
      { err: error, eventId },
      'Failed to fetch all live performances from DB'
    );
    throw new Error('Failed to fetch live performances');
  }

  return (data as DbLiveRow[] | null)?.map(mapLivePerformance) ?? [];
};

const loadEventLiveFromRedis = async (
  context: GraphQLContext,
  eventId: number
): Promise<Map<number, LivePerformance> | null> => {
  const season = await getCurrentSeason(context);
  const hashKey = `EventLive:${season}:${eventId}`;

  let hashEntries: Record<string, string>;
  try {
    hashEntries = await context.redis.hgetall(hashKey);
  } catch (error) {
    context.logger.warn(
      { err: error, hashKey },
      'Failed to read EventLive hash from Redis, falling back to DB'
    );
    return null;
  }

  const fields = Object.values(hashEntries);
  if (fields.length === 0) {
    return null;
  }

  const performances = new Map<number, LivePerformance>();
  for (const fieldValue of fields) {
    const parsed = parseJsonUnknown(fieldValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const perf = mapSyncJobLiveRow(parsed);
    if (perf) {
      performances.set(perf.playerId, perf);
    }
  }

  return performances.size > 0 ? performances : null;
};

export const liveRepository: LiveRepository = {
  async getAllLivePerformances(
    context: GraphQLContext,
    eventId: number
  ): Promise<Map<number, LivePerformance>> {
    if (!eventId || !Number.isFinite(eventId) || eventId <= 0) {
      return new Map();
    }

    const fromRedis = await loadEventLiveFromRedis(context, eventId);
    if (fromRedis) {
      return fromRedis;
    }

    context.logger.info(
      { eventId },
      'EventLive hash missing or empty, falling back to DB for all live performances'
    );

    const dbPerformances = await fetchAllLivePerformanceFromDb(context, eventId);
    return new Map(dbPerformances.map((p) => [p.playerId, p]));
  },

  async getLiveScores(
    context: GraphQLContext,
    eventId?: number,
    filter?: LiveScoresFilter | null
  ): Promise<LivePerformance[]> {
    let targetEventId = eventId;

    if (!targetEventId) {
      const seasonKey = 'events:current:id';
      const cachedEventId = await context.redis.get(seasonKey);
      if (cachedEventId) {
        targetEventId = Number.parseInt(cachedEventId, 10);
        if (!Number.isFinite(targetEventId)) {
          targetEventId = undefined;
        }
      }
    }

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

    const allPerformances = await this.getAllLivePerformances(context, targetEventId);
    let results = Array.from(allPerformances.values());

    if (filter?.inDreamTeam !== undefined && filter.inDreamTeam !== null) {
      results = results.filter((p) => p.inDreamTeam === filter.inDreamTeam);
    }
    if (filter?.minTotalPoints !== undefined && filter.minTotalPoints !== null) {
      results = results.filter((p) => p.totalPoints >= filter.minTotalPoints!);
    }
    if (filter?.maxTotalPoints !== undefined && filter.maxTotalPoints !== null) {
      results = results.filter((p) => p.totalPoints <= filter.maxTotalPoints!);
    }

    return results;
  },

  async getPlayerLive(
    context: GraphQLContext,
    playerId: number,
    eventId?: number
  ): Promise<LivePerformance | null> {
    let targetEventId = eventId;

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

    const allPerformances = await this.getAllLivePerformances(context, targetEventId);
    return allPerformances.get(playerId) ?? null;
  },

  async getEventLive(context: GraphQLContext, eventId: number): Promise<EventLive> {
    const allPerformances = await this.getAllLivePerformances(context, eventId);
    return {
      eventId,
      performances: Array.from(allPerformances.values()),
    };
  },

  async getEventLiveExplain(
    context: GraphQLContext,
    eventId: number,
    elementId: number
  ): Promise<LiveExplain | null> {
    if (!Number.isFinite(eventId) || eventId <= 0 || !Number.isFinite(elementId) || elementId <= 0) {
      return null;
    }

    const cacheKey = `live:explain:${eventId}:${elementId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached !== null) {
      if (cached === NULL_SENTINEL) {
        return null;
      }
      return JSON.parse(cached) as LiveExplain;
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
      await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', 30);
      return null;
    }

    const resolvedElementId = resolveElementId(row);
    if (resolvedElementId === null) {
      context.logger.error(
        { eventId, elementId, row },
        'Event live explain row missing element identifier'
      );
      await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', 30);
      return null;
    }

    const liveExplain = mapLiveExplainRow(row, resolvedElementId, null);
    await context.redis.set(cacheKey, JSON.stringify(liveExplain), 'EX', 30);
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

    const allPerformances = await this.getAllLivePerformances(context, eventId);
    const results: LivePerformance[] = [];
    for (const playerId of uniqueIds) {
      const perf = allPerformances.get(playerId);
      if (perf) {
        results.push(perf);
      }
    }
    return results;
  },

  async getSelectedByPercent(
    context: GraphQLContext,
    eventId: number,
    elementId: number
  ): Promise<number | null> {
    if (!Number.isFinite(eventId) || eventId <= 0 || !Number.isFinite(elementId) || elementId <= 0) {
      return null;
    }
    return fetchSelectedByPercent(context, eventId, elementId);
  },
};