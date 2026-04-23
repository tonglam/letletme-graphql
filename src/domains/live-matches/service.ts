import type { GraphQLContext } from '../../graphql/context';
import { MAX_EVENT_ID } from '../../infra/config';
import { getCurrentSeason } from '../../infra/season';
import { calcElementLivePoints } from '../entry-live/calc-service';
import type { ElementEventResultData } from '../entry-live/calc-service';
import { eventsService } from '../events/service';
import type { Fixture } from '../fixtures/repository';
import { fixturesRepository } from '../fixtures/repository';
import type { LivePerformance } from '../live/repository';
import { liveRepository } from '../live/repository';
import type { Player, Team } from '../players/repository';
import { playersRepository } from '../players/repository';

/**
 * Helper to safely get event fixtures with proper type assertion.
 * Supabase client types surface `any` internally; we contain it here.
 */
const getEventFixturesSafe = async (
  context: GraphQLContext,
  eventId: number,
): Promise<Fixture[]> => {
  const fixtures = await fixturesRepository.getEventFixtures(context, eventId);
  return fixtures as Fixture[];
};

/**
 * Helper to safely get teams with proper type assertion.
 * Supabase client types surface `any` internally; we contain it here.
 */
const getTeamsSafe = async (context: GraphQLContext): Promise<Team[]> => {
   
  const teams = await playersRepository.listTeams(context);
  return teams as Team[];
};

/**
 * Helper to safely get players by IDs with proper type assertion.
 * Supabase client types surface `any` internally; we contain it here.
 */
const getPlayersByIdsSafe = async (
  context: GraphQLContext,
  ids: number[],
): Promise<Player[]> => {
  const players = await playersRepository.getPlayersByIds(context, ids);
  return players as Player[];
};

export type LiveMatchData = {
  matchId: number;
  minutes: number;
  homeTeamId: number;
  homeTeamName: string;
  homeTeamShortName: string;
  homePosition: number;
  homeScore: number;
  homeTeamDataList: ElementEventResultData[];
  awayTeamId: number;
  awayTeamName: string;
  awayTeamShortName: string;
  awayPosition: number;
  awayScore: number;
  awayTeamDataList: ElementEventResultData[];
  kickoffTime: string | null;
  playStatus: 'NEXT_EVENT' | 'NOT_STARTED' | 'PLAYING' | 'FINISHED';
};

export type LiveMatches = {
  nextEvent: LiveMatchData[];
  notStarted: LiveMatchData[];
  playing: LiveMatchData[];
  finished: LiveMatchData[];
};

type MatchBucketStatus = Exclude<LiveMatchData['playStatus'], 'NEXT_EVENT'>;

type LiveFixtureRedisRow = {
  teamId: number;
  teamName: string;
  teamShortName: string;
  teamScore: number;
  againstId: number;
  againstName: string;
  againstShortName: string;
  againstTeamScore: number;
  kickoffTime: string | null;
  wasHome: boolean;
};

type MatchBucketsFromRedis = {
  notStarted: LiveFixtureRedisRow[];
  playing: LiveFixtureRedisRow[];
  finished: LiveFixtureRedisRow[];
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

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
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }
  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
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

const normalizeLiveFixtureStatus = (rawStatus: string): MatchBucketStatus | null => {
  const normalized = rawStatus.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'NOT_STARTED' || normalized === 'NOT_START') {
    return 'NOT_STARTED';
  }
  if (normalized === 'PLAYING' || normalized === 'EVENT_NOT_FINISHED') {
    return 'PLAYING';
  }
  if (normalized === 'FINISHED') {
    return 'FINISHED';
  }
  return null;
};

const parseLiveFixtureRow = (value: unknown): LiveFixtureRedisRow | null => {
  const row = asRecord(value);
  if (!row) {
    return null;
  }

  const teamId = asNumber(row.teamId ?? row.team_id);
  const againstId = asNumber(row.againstId ?? row.against_id);
  if (teamId === null || againstId === null) {
    return null;
  }

  return {
    teamId: Math.trunc(teamId),
    teamName: asString(row.teamName ?? row.team_name) ?? '',
    teamShortName: asString(row.teamShortName ?? row.team_short_name) ?? '',
    teamScore: Math.trunc(asNumber(row.teamScore ?? row.team_score) ?? 0),
    againstId: Math.trunc(againstId),
    againstName: asString(row.againstName ?? row.against_name) ?? '',
    againstShortName: asString(row.againstShortName ?? row.against_short_name) ?? '',
    againstTeamScore: Math.trunc(
      asNumber(row.againstTeamScore ?? row.against_team_score) ?? 0,
    ),
    kickoffTime: asString(row.kickoffTime ?? row.kickoff_time),
    wasHome: asBoolean(row.wasHome ?? row.was_home) ?? false,
  };
};

const parseLiveFixtureList = (value: unknown): LiveFixtureRedisRow[] => {
  let list: unknown[] | null = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string') {
    const parsed = parseJsonUnknown(value);
    if (Array.isArray(parsed)) {
      list = parsed;
    }
  }
  if (!list) {
    return [];
  }
  return list
    .map((item) => parseLiveFixtureRow(item))
    .filter((row): row is LiveFixtureRedisRow => row !== null);
};

const parseLiveFixtureHashFieldValue = (value: string): MatchBucketsFromRedis => {
  const parsed = parseJsonUnknown(value);
  const statusMap = asRecord(parsed);
  const buckets: MatchBucketsFromRedis = {
    notStarted: [],
    playing: [],
    finished: [],
  };

  if (!statusMap) {
    return buckets;
  }

  Object.entries(statusMap).forEach(([rawStatus, rawList]) => {
    const status = normalizeLiveFixtureStatus(rawStatus);
    if (!status) {
      return;
    }
    const fixtures = parseLiveFixtureList(rawList).filter((row) => row.wasHome);
    if (status === 'NOT_STARTED') {
      buckets.notStarted.push(...fixtures);
      return;
    }
    if (status === 'PLAYING') {
      buckets.playing.push(...fixtures);
      return;
    }
    buckets.finished.push(...fixtures);
  });

  return buckets;
};

const mergeMatchBuckets = (
  target: MatchBucketsFromRedis,
  source: MatchBucketsFromRedis,
): MatchBucketsFromRedis => ({
  notStarted: [...target.notStarted, ...source.notStarted],
  playing: [...target.playing, ...source.playing],
  finished: [...target.finished, ...source.finished],
});

const loadLiveFixtureBucketsFromRedis = async (
  context: GraphQLContext,
  eventId: number,
): Promise<MatchBucketsFromRedis | null> => {
  const season = await getCurrentSeason(context);
  const redisKey = `LiveFixture:${season}:${eventId}`;

  const hashEntries = await context.redis.hgetall(redisKey);
  const fields = Object.values(hashEntries);
  if (fields.length === 0) {
    return null;
  }

  const buckets = fields.reduce<MatchBucketsFromRedis>(
    (acc, fieldValue) => mergeMatchBuckets(acc, parseLiveFixtureHashFieldValue(fieldValue)),
    { notStarted: [], playing: [], finished: [] },
  );

  if (
    buckets.notStarted.length > 0 ||
    buckets.playing.length > 0 ||
    buckets.finished.length > 0
  ) {
    return buckets;
  }

  return null;
};

const elementTypeName = (position: number): string => {
  switch (position) {
    case 1:
      return 'GKP';
    case 2:
      return 'DEF';
    case 3:
      return 'MID';
    case 4:
      return 'FWD';
    default:
      return '';
  }
};

/**
 * Pre-builds team data maps grouped by teamId for O(1) lookup.
 * This avoids iterating through all performances for each match.
 */
const buildTeamDataMap = (
  eventId: number,
  livePerformances: LivePerformance[],
  playersById: Map<number, Player>,
  teamsById: Map<number, Team>,
): Map<number, ElementEventResultData[]> => {
  const teamDataMap = new Map<number, ElementEventResultData[]>();

  for (const perf of livePerformances) {
    // Filter: must have minutes > 0 and player must exist
    if (!perf.playerId || perf.minutes === null || perf.minutes <= 0) {
      continue;
    }

    const player = playersById.get(perf.playerId);
    if (!player) {
      continue;
    }

    const team = teamsById.get(player.teamId);
    const bonus = perf.bonus ?? 0;
    const totalPoints = calcElementLivePoints(player.position, perf);

    // Extract defensive contribution with proper type handling
    const defensiveContribution: number = perf.defensiveContribution ?? 0;

    const elementData: ElementEventResultData = {
      season: null,
      event: eventId,
      element: perf.playerId,
      code: player.code,
      webName: player.webName,
      price: player.price / 10,
      elementType: player.position,
      elementTypeName: elementTypeName(player.position),
      teamId: player.teamId,
      teamCode: team?.code ?? 0,
      teamName: team?.name ?? '',
      teamShortName: team?.shortName ?? '',
      againstId: 0,
      againstName: '',
      againstShortName: '',
      wasHome: '',
      score: '',
      position: 0,
      multiplier: 1,
      isCaptain: false,
      isViceCaptain: false,
      isGwStarted: true,
      isGwFinished: false,
      isPlayed: true,
      playStatus: 2, // PLAYING
      minutes: perf.minutes ?? 0,
      goalsScored: perf.goalsScored ?? 0,
      assists: perf.assists ?? 0,
      cleanSheets: perf.cleanSheets ?? 0,
      goalsConceded: perf.goalsConceded ?? 0,
      defensiveContribution,
      ownGoals: perf.ownGoals ?? 0,
      penaltiesSaved: perf.penaltiesSaved ?? 0,
      penaltiesMissed: perf.penaltiesMissed ?? 0,
      yellowCards: perf.yellowCards ?? 0,
      redCards: perf.redCards ?? 0,
      saves: perf.saves ?? 0,
      bonus,
      bps: perf.bps ?? 0,
      totalPoints,
      starts: perf.starts ?? null,
      expectedGoals: perf.expectedGoals ? Number.parseFloat(perf.expectedGoals) : null,
      expectedAssists: perf.expectedAssists ? Number.parseFloat(perf.expectedAssists) : null,
      expectedGoalInvolvements: perf.expectedGoalInvolvements
        ? Number.parseFloat(perf.expectedGoalInvolvements)
        : null,
      expectedGoalsConceded: perf.expectedGoalsConceded
        ? Number.parseFloat(perf.expectedGoalsConceded)
        : null,
      inDreamTeam: perf.inDreamTeam ?? null,
      pickActive: false,
      autoSub: false,
      bgw: false,
      dgw: false,
    };

    const teamId = player.teamId;
    const existing = teamDataMap.get(teamId) ?? [];
    existing.push(elementData);
    teamDataMap.set(teamId, existing);
  }

  // Sort each team's data by total points descending
  for (const [teamId, data] of teamDataMap.entries()) {
    teamDataMap.set(teamId, data.sort((a, b) => b.totalPoints - a.totalPoints));
  }

  return teamDataMap;
};

/**
 * Gets the maximum minutes from team data list (for match minutes).
 */
const getMaxMinutes = (teamDataList: ElementEventResultData[]): number => {
  if (teamDataList.length === 0) {
    return 0;
  }
  return Math.max(...teamDataList.map((d) => d.minutes));
};

/**
 * Builds a single match from a fixture using pre-built team data map.
 */
const buildMatch = (
  fixture: Fixture,
  matchId: number,
  playStatus: 'NEXT_EVENT' | 'NOT_STARTED' | 'PLAYING' | 'FINISHED',
  teamDataMap: Map<number, ElementEventResultData[]>,
  teamsById: Map<number, Team>,
): LiveMatchData => {
  const homeTeam = teamsById.get(fixture.teamHId);
  const awayTeam = teamsById.get(fixture.teamAId);

  // Get team data lists from pre-built map (empty for NEXT_EVENT)
  const homeTeamDataList =
    playStatus === 'NEXT_EVENT' ? [] : teamDataMap.get(fixture.teamHId) ?? [];
  const awayTeamDataList =
    playStatus === 'NEXT_EVENT' ? [] : teamDataMap.get(fixture.teamAId) ?? [];

  const minutes =
    playStatus === 'NEXT_EVENT'
      ? 0
      : Math.max(getMaxMinutes(homeTeamDataList), getMaxMinutes(awayTeamDataList));

  return {
    matchId,
    minutes,
    homeTeamId: fixture.teamHId,
    homeTeamName: homeTeam?.name ?? '',
    homeTeamShortName: homeTeam?.shortName ?? '',
    homePosition: homeTeam?.position ?? 0,
    homeScore: fixture.teamHScore ?? 0,
    homeTeamDataList,
    awayTeamId: fixture.teamAId,
    awayTeamName: awayTeam?.name ?? '',
    awayTeamShortName: awayTeam?.shortName ?? '',
    awayPosition: awayTeam?.position ?? 0,
    awayScore: fixture.teamAScore ?? 0,
    awayTeamDataList,
    kickoffTime: fixture.kickoffTime,
    playStatus,
  };
};

const buildMatchFromRedis = (
  fixture: LiveFixtureRedisRow,
  matchId: number,
  playStatus: MatchBucketStatus,
  teamDataMap: Map<number, ElementEventResultData[]>,
  teamsById: Map<number, Team>,
): LiveMatchData => {
  const homeTeam = teamsById.get(fixture.teamId);
  const awayTeam = teamsById.get(fixture.againstId);
  const homeTeamDataList = teamDataMap.get(fixture.teamId) ?? [];
  const awayTeamDataList = teamDataMap.get(fixture.againstId) ?? [];
  const minutes = Math.max(
    getMaxMinutes(homeTeamDataList),
    getMaxMinutes(awayTeamDataList),
  );

  return {
    matchId,
    minutes,
    homeTeamId: fixture.teamId,
    homeTeamName: fixture.teamName || homeTeam?.name || '',
    homeTeamShortName: fixture.teamShortName || homeTeam?.shortName || '',
    homePosition: homeTeam?.position ?? 0,
    homeScore: fixture.teamScore,
    homeTeamDataList,
    awayTeamId: fixture.againstId,
    awayTeamName: fixture.againstName || awayTeam?.name || '',
    awayTeamShortName: fixture.againstShortName || awayTeam?.shortName || '',
    awayPosition: awayTeam?.position ?? 0,
    awayScore: fixture.againstTeamScore,
    awayTeamDataList,
    kickoffTime: fixture.kickoffTime,
    playStatus,
  };
};

const kickoffTimestamp = (value: string | null): number | null => {
  if (!value) {
    return null;
  }
  const normalized = value.includes(' ') ? value.replace(' ', 'T') : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
};

/**
 * Sorts matches by kickoff time.
 */
const sortByKickoffTime = (matches: LiveMatchData[]): LiveMatchData[] => {
  return matches.sort((a, b) => {
    const aTs = kickoffTimestamp(a.kickoffTime);
    const bTs = kickoffTimestamp(b.kickoffTime);
    if (aTs === null || bTs === null) {
      return 0;
    }
    return aTs - bTs;
  });
};

export const liveMatchesService = {
  async getAllLiveMatches(context: GraphQLContext): Promise<LiveMatches> {
    // Get current event ID (uses cached getCurrentEventInfo)
    const currentEventInfo = await eventsService.getCurrentEventInfo(context);
    const currentEventId = currentEventInfo?.currentEvent ?? null;

    if (!currentEventId) {
      return {
        nextEvent: [],
        notStarted: [],
        playing: [],
        finished: [],
      };
    }

    // Fetch static dependencies and try Redis LiveFixture source first.
    const [nextFixtures, teams, redisBuckets] = await Promise.all([
      currentEventId <= MAX_EVENT_ID
        ? getEventFixturesSafe(context, currentEventId + 1)
        : Promise.resolve<Fixture[]>([]),
      getTeamsSafe(context),
      loadLiveFixtureBucketsFromRedis(context, currentEventId),
    ]);

    const teamsById = new Map<number, Team>(teams.map((t) => [t.id, t]));

    const notStartedFixturesFromRedis = redisBuckets?.notStarted ?? [];
    const playingFixturesFromRedis = redisBuckets?.playing ?? [];
    const finishedFixturesFromRedis = redisBuckets?.finished ?? [];

    const notStartedFixturesFromDb: Fixture[] = [];
    const playingFixturesFromDb: Fixture[] = [];
    const finishedFixturesFromDb: Fixture[] = [];
    const usingRedisBuckets =
      notStartedFixturesFromRedis.length > 0 ||
      playingFixturesFromRedis.length > 0 ||
      finishedFixturesFromRedis.length > 0;

    if (!usingRedisBuckets) {
      context.logger.warn(
        { currentEventId },
        'LiveFixture redis map missing or empty, falling back to DB fixture grouping',
      );
      const currentFixtures = await getEventFixturesSafe(context, currentEventId);
      for (const fixture of currentFixtures) {
        if (fixture.finished) {
          finishedFixturesFromDb.push(fixture);
        } else if (fixture.started === true) {
          playingFixturesFromDb.push(fixture);
        } else {
          notStartedFixturesFromDb.push(fixture);
        }
      }
    }

    // Only fetch live data and players if we have PLAYING or FINISHED matches
    const needsLiveData = usingRedisBuckets
      ? playingFixturesFromRedis.length > 0 || finishedFixturesFromRedis.length > 0
      : playingFixturesFromDb.length > 0 || finishedFixturesFromDb.length > 0;

    let teamDataMap = new Map<number, ElementEventResultData[]>();
    if (needsLiveData) {
      const relevantTeamIds = new Set<number>();
      if (usingRedisBuckets) {
        [...playingFixturesFromRedis, ...finishedFixturesFromRedis].forEach((fixture) => {
          relevantTeamIds.add(fixture.teamId);
          relevantTeamIds.add(fixture.againstId);
        });
      } else {
        [...playingFixturesFromDb, ...finishedFixturesFromDb].forEach((fixture) => {
          relevantTeamIds.add(fixture.teamHId);
          relevantTeamIds.add(fixture.teamAId);
        });
      }

      const livePerformances: LivePerformance[] = await liveRepository.getLiveScores(
        context,
        currentEventId,
      );

      const relevantPerformances: LivePerformance[] = livePerformances.filter((p) => {
        if (!p.playerId) {
          return false;
        }
        return true;
      });

      const playerIds = new Set<number>();
      relevantPerformances.forEach((p) => {
        if (p.playerId) {
          playerIds.add(p.playerId);
        }
      });

      const players: Player[] =
        playerIds.size > 0
          ? await getPlayersByIdsSafe(context, Array.from(playerIds))
          : [];
      const playersById = new Map<number, Player>(players.map((p) => [p.id, p]));

      const filteredPerformances = relevantPerformances.filter((p) => {
        const player = playersById.get(p.playerId ?? 0);
        return player && relevantTeamIds.has(player.teamId);
      });

      teamDataMap = buildTeamDataMap(
        currentEventId,
        filteredPerformances,
        playersById,
        teamsById,
      );
    }

    const nextEventMatches: LiveMatchData[] = nextFixtures.map((fixture, i) =>
      buildMatch(fixture, i + 1, 'NEXT_EVENT', teamDataMap, teamsById),
    );

    const notStartedMatches: LiveMatchData[] = usingRedisBuckets
      ? notStartedFixturesFromRedis.map((fixture, i) =>
          buildMatchFromRedis(fixture, i + 1, 'NOT_STARTED', teamDataMap, teamsById),
        )
      : notStartedFixturesFromDb.map((fixture, i) =>
          buildMatch(fixture, i + 1, 'NOT_STARTED', teamDataMap, teamsById),
        );

    const playingMatches: LiveMatchData[] = usingRedisBuckets
      ? playingFixturesFromRedis.map((fixture, i) =>
          buildMatchFromRedis(fixture, i + 1, 'PLAYING', teamDataMap, teamsById),
        )
      : playingFixturesFromDb.map((fixture, i) =>
          buildMatch(fixture, i + 1, 'PLAYING', teamDataMap, teamsById),
        );

    const finishedMatches: LiveMatchData[] = usingRedisBuckets
      ? finishedFixturesFromRedis.map((fixture, i) =>
          buildMatchFromRedis(fixture, i + 1, 'FINISHED', teamDataMap, teamsById),
        )
      : finishedFixturesFromDb.map((fixture, i) =>
          buildMatch(fixture, i + 1, 'FINISHED', teamDataMap, teamsById),
        );

    return {
      nextEvent: sortByKickoffTime(nextEventMatches),
      notStarted: sortByKickoffTime(notStartedMatches),
      playing: sortByKickoffTime(playingMatches),
      finished: sortByKickoffTime(finishedMatches),
    };
  },
};
