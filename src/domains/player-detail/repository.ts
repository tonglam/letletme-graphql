import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';
import { getCurrentSeason } from '../../infra/season';

export type PlayerDetail = {
  id: number;
  webName: string;
  teamShortName: string;
  elementType: number;
  elementTypeName: string;
  price: number;
  startPrice: number;
  totalPoints: number;

  selectedByPercent: number | null;
  form: number | null;
  seasonTransfersIn: number;
  seasonTransfersOut: number;
  transfersInEvent: number;
  transfersOutEvent: number;

  eventPoints: number | null;
  minutes: number | null;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  bps: number;

  influence: number | null;
  creativity: number | null;
  threat: number | null;
  ictIndex: number | null;

  fixtures: PlayerFixture[];
};

export type PlayerFixture = {
  event: number;
  againstTeamShortName: string;
  wasHome: boolean;
  finished: boolean;
  kickoffTime: string | null;
  score: string | null;
  difficulty: number;
  bgw: boolean;
};

const elementTypeToName = (type: number): string => {
  switch (type) {
    case 1: return 'GOALKEEPER';
    case 2: return 'DEFENDER';
    case 3: return 'MIDFIELDER';
    case 4: return 'FORWARD';
    default: return '';
  }
};

const parseNum = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const p = Number.parseFloat(value.trim());
    return Number.isFinite(p) ? p : null;
  }
  return null;
};

const parseInt_ = (value: unknown): number | null => {
  const n = parseNum(value);
  return n === null ? null : Math.trunc(n);
};

const parseBool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1';
  }
  return false;
};

const parseJson = (value: string): Record<string, unknown> | null => {
  try {
    const p: unknown = JSON.parse(value);
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
    return p as Record<string, unknown>;
  } catch { return null; }
};

const pickValue = (source: Record<string, unknown>, primary: string, ...aliases: string[]): unknown => {
  if (Object.prototype.hasOwnProperty.call(source, primary) && source[primary] !== undefined) {
    return source[primary];
  }
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias) && source[alias] !== undefined) {
      return source[alias];
    }
  }
  return null;
};

async function loadPlayerFromRedis(
  context: GraphQLContext,
  season: string,
  playerId: number,
): Promise<{ webName: string; elementType: number; teamId: number; teamShortName: string; price: number; startPrice: number; totalPoints: number } | null> {
  const hashKey = `Player:${season}`;
  const raw = await context.redis.hget(hashKey, String(playerId));
  if (!raw) return null;

  const p = parseJson(raw);
  if (!p) return null;

  const teamId = parseInt_(p.teamId ?? p.team_id) ?? 0;

  const teamRaw = await context.redis.hget(`Team:${season}`, String(teamId));
  const team = teamRaw ? parseJson(teamRaw) : null;
  const teamShortName = team ? String(team.shortName ?? team.short_name ?? '') : '';

  return {
    webName: String(p.webName ?? ''),
    elementType: parseInt_(p.type ?? p.elementType) ?? 0,
    teamId,
    teamShortName,
    price: parseInt_(p.price ?? p.nowCost) ?? 0,
    startPrice: parseInt_(p.startPrice ?? p.start_price) ?? 0,
    totalPoints: parseInt_(p.totalPoints ?? p.total_points) ?? 0,
  };
}

async function loadEventStatsFromDb(
  context: GraphQLContext,
  playerId: number,
  eventId: number,
  season: string,
): Promise<{
  rawStats: Record<string, unknown> | null;
  eventPoints: number | null;
  totalPoints: number | null;
}> {
  const cacheKey = `player_detail:event_stats:v2:${season}:${eventId}:${playerId}`;
  const cached = await context.redis.get(cacheKey);
  if (cached !== null) {
    if (cached === '__null__') return { rawStats: null, eventPoints: null, totalPoints: null };
    const parsed = JSON.parse(cached) as { rawStats: Record<string, unknown> | null; eventPoints: number | null; totalPoints: number | null };
    return parsed;
  }

  const { data, error } = await context.supabase
    .from('player_stats')
    .select('*')
    .eq('event_id', eventId)
    .eq('element_id', playerId)
    .limit(1);

  if (error) {
    context.logger.warn({ err: error, playerId, eventId }, 'Failed to fetch player_stats');
    return { rawStats: null, eventPoints: null, totalPoints: null };
  }

  const row = (data?.[0] ?? null) as Record<string, unknown> | null;
  if (!row) {
    await context.redis.set(cacheKey, '__null__', 'EX', env.CACHE_TTL_SECONDS);
    return { rawStats: null, eventPoints: null, totalPoints: null };
  }

  const cumulativeTotalPoints = parseInt_(pickValue(row, 'total_points', 'totalPoints')) ?? null;

  let eventPoints: number | null = null;
  if (cumulativeTotalPoints !== null && eventId > 1) {
    const prevKey = `player_detail:event_stats:${season}:${eventId - 1}:${playerId}`;
    const prevCached = await context.redis.get(prevKey);
    let prevTotal: number | null = null;

    if (prevCached && prevCached !== '__null__') {
      const prevParsed = JSON.parse(prevCached) as { rawStats: Record<string, unknown> | null; eventPoints: number | null; totalPoints: number | null };
      prevTotal = prevParsed.totalPoints;
    } else {
      const { data: prevData } = await context.supabase
        .from('player_stats')
        .select('total_points')
        .eq('event_id', eventId - 1)
        .eq('element_id', playerId)
        .limit(1);

      const prevRow = (prevData?.[0] ?? null) as { total_points?: number } | null;
      if (prevRow && prevRow.total_points !== null && prevRow.total_points !== undefined) {
        prevTotal = prevRow.total_points;
      }
    }

    if (prevTotal !== null) {
      eventPoints = cumulativeTotalPoints - prevTotal;
    }
  }

  const result = { rawStats: row, eventPoints, totalPoints: cumulativeTotalPoints };
  await context.redis.set(cacheKey, JSON.stringify(result), 'EX', env.CACHE_TTL_SECONDS);
  return result;
}

async function loadSeasonStats(_context: GraphQLContext, _playerId: number): Promise<{
  form: null;
  seasonTransfersIn: 0;
  seasonTransfersOut: 0;
  selectedByPercent: null;
  eventPoints: null;
  totalPoints: null;
}> {
  return { form: null, seasonTransfersIn: 0, seasonTransfersOut: 0, selectedByPercent: null, eventPoints: null, totalPoints: null };
}

async function loadTeamFixtures(
  context: GraphQLContext,
  season: string,
  teamId: number,
): Promise<PlayerFixture[]> {
  const hashKey = `FixturesByTeam:${season}:${teamId}`;
  const hash = await context.redis.hgetall(hashKey);

  const fixtures: PlayerFixture[] = [];

  for (const [eventStr, rawValue] of Object.entries(hash)) {
    const f = parseJson(rawValue);
    if (!f) continue;

    const event = parseInt_(f.event ?? eventStr) ?? 0;
    if (event <= 0) continue;

    fixtures.push({
      event,
      againstTeamShortName: String(f.againstTeamShortName ?? f.against_team_short_name ?? ''),
      wasHome: parseBool(f.wasHome ?? f.was_home),
      finished: parseBool(f.finished),
      kickoffTime: String(f.kickoffTime ?? f.kickoff_time ?? '') || null,
      score: f.score ? String(f.score) : null,
      difficulty: parseInt_(f.difficulty) ?? 0,
      bgw: parseBool(f.bgw),
    });
  }

  fixtures.sort((a, b) => a.event - b.event);
  return fixtures;
}

function mapEventStats(rawStats: Record<string, unknown> | null): {
  form: number | null;
  seasonTransfersIn: number;
  seasonTransfersOut: number;
  transfersInEvent: number;
  transfersOutEvent: number;
  minutes: number | null;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  bps: number;
  influence: number | null;
  creativity: number | null;
  threat: number | null;
  ictIndex: number | null;
  selectedByPercent: number | null;
} {
  if (!rawStats) {
    return {
      form: null, seasonTransfersIn: 0, seasonTransfersOut: 0,
      transfersInEvent: 0, transfersOutEvent: 0,
      minutes: null, goalsScored: 0, assists: 0, cleanSheets: 0,
      goalsConceded: 0, ownGoals: 0, penaltiesSaved: 0,
      yellowCards: 0, redCards: 0, saves: 0, bonus: 0, bps: 0,
      influence: null, creativity: null, threat: null, ictIndex: null,
      selectedByPercent: null,
    };
  }

  const iv = (key: string, ...aliases: string[]): number =>
    parseInt_(pickValue(rawStats, key, ...aliases)) ?? 0;

  const nv = (key: string, ...aliases: string[]): number | null =>
    parseNum(pickValue(rawStats, key, ...aliases));

  return {
    form: nv('form'),
    seasonTransfersIn: iv('transfers_in'),
    seasonTransfersOut: iv('transfers_out'),
    transfersInEvent: iv('transfers_in_event', 'transfersInEvent'),
    transfersOutEvent: iv('transfers_out_event', 'transfersOutEvent'),
    minutes: parseInt_(pickValue(rawStats, 'minutes')),
    goalsScored: iv('goals_scored', 'goalsScored'),
    assists: iv('assists'),
    cleanSheets: iv('clean_sheets', 'cleanSheets'),
    goalsConceded: iv('goals_conceded', 'goalsConceded'),
    ownGoals: iv('own_goals', 'ownGoals'),
    penaltiesSaved: iv('penalties_saved', 'penaltiesSaved'),
    yellowCards: iv('yellow_cards', 'yellowCards'),
    redCards: iv('red_cards', 'redCards'),
    saves: iv('saves'),
    bonus: iv('bonus'),
    bps: iv('bps'),
    influence: nv('influence'),
    creativity: nv('creativity'),
    threat: nv('threat'),
    ictIndex: nv('ict_index', 'ictIndex'),
    selectedByPercent: nv('selected_by_percent', 'selectedByPercent'),
  };
}

export interface PlayerDetailRepository {
  getPlayerDetail(
    context: GraphQLContext,
    playerId: number,
    eventId: number,
  ): Promise<PlayerDetail | null>;
}

export const playerDetailRepository: PlayerDetailRepository = {
  async getPlayerDetail(
    context: GraphQLContext,
    playerId: number,
    eventId: number,
  ): Promise<PlayerDetail | null> {
    if (!Number.isFinite(playerId) || playerId <= 0) return null;
    if (!Number.isFinite(eventId) || eventId <= 0) return null;

    const season = await getCurrentSeason(context);

    const player = await loadPlayerFromRedis(context, season, playerId);
    if (!player) {
      context.logger.warn({ playerId }, 'Player not found in Redis');
      return null;
    }

    const [stats, seasonStats, fixtures] = await Promise.all([
      loadEventStatsFromDb(context, playerId, eventId, season),
      loadSeasonStats(context, playerId),
      loadTeamFixtures(context, season, player.teamId),
    ]);

    const mapped = mapEventStats(stats.rawStats);

    return {
      id: playerId,
      webName: player.webName,
      teamShortName: player.teamShortName,
      elementType: player.elementType,
      elementTypeName: elementTypeToName(player.elementType),
      price: player.price,
      startPrice: player.startPrice,
      totalPoints: stats.totalPoints ?? seasonStats.totalPoints ?? player.totalPoints,

      selectedByPercent: mapped.selectedByPercent ?? seasonStats.selectedByPercent,
      form: mapped.form,
      seasonTransfersIn: mapped.seasonTransfersIn,
      seasonTransfersOut: mapped.seasonTransfersOut,
      transfersInEvent: mapped.transfersInEvent,
      transfersOutEvent: mapped.transfersOutEvent,

      eventPoints: stats.eventPoints,
      minutes: mapped.minutes,
      goalsScored: mapped.goalsScored,
      assists: mapped.assists,
      cleanSheets: mapped.cleanSheets,
      goalsConceded: mapped.goalsConceded,
      ownGoals: mapped.ownGoals,
      penaltiesSaved: mapped.penaltiesSaved,
      yellowCards: mapped.yellowCards,
      redCards: mapped.redCards,
      saves: mapped.saves,
      bonus: mapped.bonus,
      bps: mapped.bps,

      influence: mapped.influence,
      creativity: mapped.creativity,
      threat: mapped.threat,
      ictIndex: mapped.ictIndex,

      fixtures,
    };
  },
};
