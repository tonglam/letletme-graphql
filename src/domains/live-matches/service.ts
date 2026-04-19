import type { GraphQLContext } from '../../graphql/context';
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
    // Apply bonus: if bonus > 0, use it; otherwise add from liveBonusMap (not implemented yet, defaulting to 0)
    const bonus = perf.bonus ?? 0;
    const totalPoints = (perf.totalPoints ?? 0) + bonus;

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

/**
 * Sorts matches by kickoff time.
 */
const sortByKickoffTime = (matches: LiveMatchData[]): LiveMatchData[] => {
  return matches.sort((a, b) => {
    if (!a.kickoffTime || !b.kickoffTime) {
      return 0;
    }
    return new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
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

    // Fetch fixtures and teams in parallel (don't fetch live data yet - only if needed)
    const [currentFixtures, nextFixtures, teams] = await Promise.all([
      getEventFixturesSafe(context, currentEventId),
      currentEventId <= 38
        ? getEventFixturesSafe(context, currentEventId + 1)
        : Promise.resolve<Fixture[]>([]),
      getTeamsSafe(context),
    ]);

    const teamsById = new Map<number, Team>(teams.map((t) => [t.id, t]));

    // Group fixtures by status first (to determine if we need live data)
    const notStartedFixtures: Fixture[] = [];
    const playingFixtures: Fixture[] = [];
    const finishedFixtures: Fixture[] = [];

    for (const fixture of currentFixtures) {
      if (fixture.finished) {
        finishedFixtures.push(fixture);
      } else if (fixture.started === true) {
        playingFixtures.push(fixture);
      } else {
        notStartedFixtures.push(fixture);
      }
    }

    // Only fetch live data and players if we have PLAYING or FINISHED matches
    const needsLiveData = playingFixtures.length > 0 || finishedFixtures.length > 0;
    
    let teamDataMap = new Map<number, ElementEventResultData[]>();
    if (needsLiveData) {
      // Collect team IDs that need live data (only from PLAYING and FINISHED matches)
      const relevantTeamIds = new Set<number>();
      playingFixtures.forEach((f) => {
        relevantTeamIds.add(f.teamHId);
        relevantTeamIds.add(f.teamAId);
      });
      finishedFixtures.forEach((f) => {
        relevantTeamIds.add(f.teamHId);
        relevantTeamIds.add(f.teamAId);
      });

      // Fetch live data first
      const livePerformances: LivePerformance[] = await liveRepository.getLiveScores(
        context,
        currentEventId,
      );

      // Filter live performances to only relevant teams (reduces processing)
      const relevantPerformances: LivePerformance[] = livePerformances.filter((p) => {
        if (!p.playerId) return false;
        // We'll check team membership after loading players
        return true;
      });

      // Collect player IDs from relevant performances
      const playerIds = new Set<number>();
      relevantPerformances.forEach((p) => {
        if (p.playerId) {
          playerIds.add(p.playerId);
        }
      });

      // Batch load all players
       
      const players: Player[] =
        playerIds.size > 0
          ? await getPlayersByIdsSafe(context, Array.from(playerIds))
          : [];
      const playersById = new Map<number, Player>(players.map((p) => [p.id, p]));

      // Filter performances to only players from relevant teams
      const filteredPerformances = relevantPerformances.filter((p) => {
        const player = playersById.get(p.playerId ?? 0);
        return player && relevantTeamIds.has(player.teamId);
      });

      // Pre-build team data map only for relevant teams
      teamDataMap = buildTeamDataMap(
        currentEventId,
        filteredPerformances,
        playersById,
        teamsById,
      );
    }

    // Build matches (no live data needed for NEXT_EVENT and NOT_STARTED)
    const nextEventMatches: LiveMatchData[] = nextFixtures.map((fixture, i) =>
      buildMatch(fixture, i + 1, 'NEXT_EVENT', teamDataMap, teamsById),
    );

    const notStartedMatches: LiveMatchData[] = notStartedFixtures.map((fixture, i) =>
      buildMatch(fixture, i + 1, 'NOT_STARTED', teamDataMap, teamsById),
    );

    const playingMatches: LiveMatchData[] = playingFixtures.map((fixture, i) =>
      buildMatch(fixture, i + 1, 'PLAYING', teamDataMap, teamsById),
    );

    const finishedMatches: LiveMatchData[] = finishedFixtures.map((fixture, i) =>
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
