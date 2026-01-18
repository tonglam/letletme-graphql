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
  expectedGoals: string | null;
  expectedAssists: string | null;
  expectedGoalInvolvements: string | null;
  expectedGoalsConceded: string | null;
  inDreamTeam: boolean | null;
  totalPoints: number;
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
  expected_goals: string | null;
  expected_assists: string | null;
  expected_goal_involvements: string | null;
  expected_goals_conceded: string | null;
  in_dream_team: boolean | null;
  total_points: number;
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
  expectedGoals: row.expected_goals,
  expectedAssists: row.expected_assists,
  expectedGoalInvolvements: row.expected_goal_involvements,
  expectedGoalsConceded: row.expected_goals_conceded,
  inDreamTeam: row.in_dream_team,
  totalPoints: row.total_points,
});

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
}

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
};
