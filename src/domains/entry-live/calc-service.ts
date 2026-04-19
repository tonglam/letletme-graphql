import type { GraphQLContext } from '../../graphql/context';
import type { Entry, EntryEventResult } from '../entries/repository';
import { entriesService } from '../entries/service';
import type { Fixture } from '../fixtures/repository';
import { fixturesService } from '../fixtures/service';
import type { LivePerformance } from '../live/repository';
import { liveRepository } from '../live/repository';
import type { Player, Team } from '../players/repository';
import { playersRepository } from '../players/repository';
import type { EntryEventPick, Pick as EntryPick } from './repository';
import { entryLiveRepository } from './repository';

export type LiveCalcData = {
  rank: number;
  event: number;
  entry: number;
  entryName: string;
  playerName: string;
  region: string | null;
  startedEvent: number;
  overallPoints: number;
  overallRank: number;
  value: number;
  bank: number;
  teamValue: number;
  totalTransfers: number;
  lastOverallPoints: number;
  lastOverallRank: number;
  lastValue: number;
  chip: string;
  livePoints: number;
  transferCost: number;
  liveNetPoints: number;
  liveTotalPoints: number;
  played: number;
  toPlay: number;
  playedCaptain: number;
  captainName: string;
  pickList: ElementEventResultData[];
  transfersList: EntryEventTransfersData[];
};

export type ElementEventResultData = {
  season: string | null;
  event: number;
  element: number;
  code: number;
  webName: string;
  price: number;
  elementType: number;
  elementTypeName: string;
  teamId: number;
  teamCode: number;
  teamName: string;
  teamShortName: string;
  againstId: number;
  againstName: string;
  againstShortName: string;
  wasHome: string;
  score: string;
  position: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isGwStarted: boolean;
  isGwFinished: boolean;
  isPlayed: boolean;
  playStatus: number;
  minutes: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  defensiveContribution: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  bps: number;
  totalPoints: number;
  starts: boolean | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  expectedGoalInvolvements: number | null;
  expectedGoalsConceded: number | null;
  inDreamTeam: boolean | null;
  pickActive: boolean;
  autoSub: boolean;
  bgw: boolean;
  dgw: boolean;
};

export type EntryEventTransfersData = {
  event: number;
  entry: number;
  elementIn: number;
  elementInWebName: string;
  elementInType: number;
  elementInTypeName: string;
  elementInTeamId: number;
  elementInTeamName: string;
  elementInTeamShortName: string;
  elementInCost: number;
  elementInPoints: number;
  elementInPlayed: boolean;
  elementOut: number;
  elementOutWebName: string;
  elementOutTeamId: number;
  elementOutTeamName: string;
  elementOutTeamShortName: string;
  elementOutType: number;
  elementOutTypeName: string;
  elementOutCost: number;
  elementOutPoints: number;
  time: string;
};

const PLAY_STATUS = {
  BLANK: 0,
  NOT_STARTED: 1,
  PLAYING: 2,
  EVENT_NOT_FINISHED: 3,
  FINISHED: 4,
} as const;

const safeInt = (value: number | null | undefined): number => (typeof value === 'number' ? value : 0);

const asScaled = (value: number | null | undefined, divisor: number): number =>
  typeof value === 'number' ? value / divisor : 0;

const safeNull = <T>(value: T | null | undefined, defaultValue: T): T => value ?? defaultValue;

const teamMapById = (teams: Team[]): Map<number, Team> => new Map(teams.map((t) => [t.id, t]));

/**
 * Build fixture index optimized to avoid array spread operations.
 * Uses push instead of spread for better performance.
 */
const buildFixtureIndex = (fixtures: Fixture[]): Map<number, Fixture[]> => {
  const map = new Map<number, Fixture[]>();
  for (const fx of fixtures) {
    const home = fx.teamHId;
    const away = fx.teamAId;
    
    // Use push instead of spread to avoid array creation overhead
    const homeFixtures = map.get(home);
    if (homeFixtures) {
      homeFixtures.push(fx);
    } else {
      map.set(home, [fx]);
    }
    
    const awayFixtures = map.get(away);
    if (awayFixtures) {
      awayFixtures.push(fx);
    } else {
      map.set(away, [fx]);
    }
  }
  return map;
};

const getPlayStatusForTeam = (fixtures: Fixture[] | undefined): { started: boolean; finished: boolean; status: number } => {
  if (!fixtures || fixtures.length === 0) {
    return { started: true, finished: true, status: PLAY_STATUS.BLANK };
  }

  const anyStarted = fixtures.some((f) => f.started === true);
  const anyFinished = fixtures.some((f) => f.finished === true);
  const allFinished = fixtures.every((f) => f.finished === true);

  if (anyStarted && !allFinished) {
    return { started: true, finished: false, status: PLAY_STATUS.PLAYING };
  }
  if (!anyStarted && !anyFinished) {
    return { started: false, finished: false, status: PLAY_STATUS.NOT_STARTED };
  }
  if (anyFinished && !allFinished) {
    return { started: true, finished: false, status: PLAY_STATUS.EVENT_NOT_FINISHED };
  }
  return { started: true, finished: true, status: PLAY_STATUS.FINISHED };
};

const joinNonEmpty = (values: string[]): string => values.filter((s) => s.trim().length > 0).join(',');

const buildTeamMatchInfo = (params: {
  teamId: number;
  team: Team | undefined;
  fixtures: Fixture[] | undefined;
  teamsById: Map<number, Team>;
}): {
  teamCode: number;
  teamName: string;
  teamShortName: string;
  againstId: number;
  againstName: string;
  againstShortName: string;
  wasHome: string;
  score: string;
  bgw: boolean;
  dgw: boolean;
  isGwStarted: boolean;
  isGwFinished: boolean;
  playStatus: number;
} => {
  const { fixtures, teamId, team, teamsById } = params;
  const status = getPlayStatusForTeam(fixtures);

  if (!fixtures || fixtures.length === 0) {
    return {
      teamCode: team?.code ?? 0,
      teamName: team?.name ?? '',
      teamShortName: team?.shortName ?? '',
      againstId: 0,
      againstName: 'BLANK',
      againstShortName: 'BLANK',
      wasHome: '',
      score: '',
      bgw: true,
      dgw: false,
      isGwStarted: true,
      isGwFinished: true,
      playStatus: PLAY_STATUS.BLANK,
    };
  }

  const againstIds: number[] = [];
  const againstNames: string[] = [];
  const againstShortNames: string[] = [];
  const wasHomeList: string[] = [];
  const scores: string[] = [];

  for (const fx of fixtures) {
    const isHome = fx.teamHId === teamId;
    const againstId = isHome ? fx.teamAId : fx.teamHId;
    const againstTeam = teamsById.get(againstId);

    againstIds.push(againstId);
    againstNames.push(againstTeam?.name ?? '');
    againstShortNames.push(againstTeam?.shortName ?? '');
    wasHomeList.push(isHome ? 'H' : 'A');

    const teamScore = isHome ? fx.teamHScore : fx.teamAScore;
    const againstScore = isHome ? fx.teamAScore : fx.teamHScore;
    scores.push(
      teamScore === null || againstScore === null ? '' : `${teamScore}-${againstScore}`
    );
  }

  return {
    teamCode: team?.code ?? 0,
    teamName: team?.name ?? '',
    teamShortName: team?.shortName ?? '',
    againstId: againstIds.length === 1 ? againstIds[0] : 0,
    againstName: joinNonEmpty(againstNames),
    againstShortName: joinNonEmpty(againstShortNames),
    wasHome: joinNonEmpty(wasHomeList),
    score: joinNonEmpty(scores),
    bgw: false,
    dgw: fixtures.length > 1,
    isGwStarted: status.started,
    isGwFinished: status.finished,
    playStatus: status.status,
  };
};

const liveMapByPlayerId = (
  performances: LivePerformance[],
): Map<number, LivePerformance> =>
  new Map(performances.map((p: LivePerformance) => [p.playerId, p]));

const getEventFixtures = async (
  context: GraphQLContext,
  eventId: number,
): Promise<Fixture[]> => {
  const data = await fixturesService.getEventFixtures(
    context,
    eventId,
  );
  return data as Fixture[];
};

const parseNullableFloat = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const elementTypeName = (player: Player | null): string => {
  if (!player) return '';
  // playersRepository.Position is numeric enum: 1..4
  switch (player.position) {
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
 * Calculate total live points for an element based on all stats.
 * Optimized to reduce function call overhead by inlining all calculations.
 * 
 * Point calculation rules:
 * - Playing: 1pt if 0 < minutes < 60, 2pts if 60-90
 * - Goals: GKP/DEF=6pts, MID=5pts, FWD=4pts per goal
 * - Assists: 3pts per assist
 * - Clean sheets: GKP/DEF=4pts, MID=1pt per clean sheet
 * - Goals conceded: GKP/DEF=-1pt per 2 goals (rounded down)
 * - Penalties saved: 5pts per save
 * - Penalties missed: -2pts per miss
 * - Own goals: -2pts per own goal
 * - Yellow cards: -1pt per card
 * - Red cards: -3pts per card
 * - Saves: floor(saves / 3) points
 * - Bonus: bonus points as-is
 * - Defensive contribution: DEF>=10 adds 2pts, MID/FWD>=12 adds 2pts
 */
const calcElementLivePoints = (
  elementType: number,
  live: LivePerformance | undefined,
): number => {
  if (!live) {
    return 0;
  }

  // Extract values once to avoid repeated null checks
  const minutes = live.minutes ?? 0;
  const goalsScored = live.goalsScored ?? 0;
  const assists = live.assists ?? 0;
  const cleanSheets = live.cleanSheets ?? 0;
  const goalsConceded = live.goalsConceded ?? 0;
  const penaltiesSaved = live.penaltiesSaved ?? 0;
  const penaltiesMissed = live.penaltiesMissed ?? 0;
  const ownGoals = live.ownGoals ?? 0;
  const yellowCards = live.yellowCards ?? 0;
  const redCards = live.redCards ?? 0;
  const saves = live.saves ?? 0;
  const bonus = live.bonus ?? 0;
  // Extract defensive contribution with proper type handling
   
  const defensiveContributionValue = live.defensiveContribution as number | null | undefined;
  const defensiveContribution: number = defensiveContributionValue ?? 0;

  // Playing points (inlined)
  let points = 0;
  if (minutes > 0 && minutes < 60) {
    points += 1;
  } else if (minutes >= 60 && minutes <= 90) {
    points += 2;
  }

  // Goals scored (inlined)
  switch (elementType) {
    case 1: // GOALKEEPER
    case 2: // DEFENDER
      points += 6 * goalsScored;
      break;
    case 3: // MIDFIELDER
      points += 5 * goalsScored;
      break;
    case 4: // FORWARD
      points += 4 * goalsScored;
      break;
  }

  // Assists (inlined)
  points += 3 * assists;

  // Clean sheets (inlined)
  switch (elementType) {
    case 1: // GOALKEEPER
    case 2: // DEFENDER
      points += 4 * cleanSheets;
      break;
    case 3: // MIDFIELDER
      points += cleanSheets;
      break;
  }

  // Goals conceded (inlined)
  if (elementType === 1 || elementType === 2) {
    points -= Math.floor(goalsConceded / 2);
  }

  // Penalties saved (inlined)
  points += 5 * penaltiesSaved;

  // Penalties missed (inlined)
  points -= 2 * penaltiesMissed;

  // Own goals (inlined)
  points -= 2 * ownGoals;

  // Yellow cards (inlined)
  points -= yellowCards;

  // Red cards (inlined)
  points -= 3 * redCards;

  // Saves (inlined)
  points += Math.floor(saves / 3);

  // Bonus (inlined)
  points += bonus;

  // Defensive contribution (inlined)
  switch (elementType) {
    case 2: // DEFENDER
      if (defensiveContribution >= 10) points += 2;
      break;
    case 3: // MIDFIELDER
    case 4: // FORWARD
      if (defensiveContribution >= 12) points += 2;
      break;
  }

  return points;
};

const hasCompletedFixtures = (pick: ElementEventResultData): boolean =>
  pick.isGwFinished || pick.playStatus === PLAY_STATUS.BLANK || pick.bgw;

const selectCaptainForScoring = (picks: ElementEventResultData[]): ElementEventResultData | null => {
  const captain = picks.find((p) => p.isCaptain) ?? null;
  if (!captain) {
    return null;
  }

  if (captain.isPlayed) {
    return captain;
  }

  if (!hasCompletedFixtures(captain)) {
    return captain;
  }

  const vice = picks.find((p) => p.isViceCaptain) ?? null;
  return vice ?? captain;
};

const normalizeChip = (raw: string | null | undefined): string => {
  const value = (raw ?? '').toUpperCase().trim();
  if (value === 'BENCH_BOOST' || value === 'BB') return 'BENCH_BOOST';
  if (value === 'TRIPLE_CAPTAIN' || value === 'TC') return 'TRIPLE_CAPTAIN';
  if (value === 'FREE_HIT' || value === 'FH') return 'FREE_HIT';
  if (value === 'WILDCARD' || value === 'WC') return 'WILDCARD';
  if (value === 'NONE' || value === '') return 'NONE';

  // Unknown / legacy / placeholder values (e.g. "N/A") should never leak to GraphQL enums.
  return 'NONE';
};

export const entryLiveCalcService = {
  async calcLivePointsByEntry(
    context: GraphQLContext,
    eventId: number,
    entryId: number
  ): Promise<LiveCalcData> {
    if (!Number.isInteger(eventId) || !Number.isInteger(entryId) || eventId <= 0 || entryId <= 0) {
      return {
        rank: 0,
        event: 0,
        entry: entryId,
        entryName: '',
        playerName: '',
        region: null,
        startedEvent: 0,
        overallPoints: 0,
        overallRank: 0,
        value: 0,
        bank: 0,
        teamValue: 0,
        lastOverallPoints: 0,
        lastOverallRank: 0,
        lastValue: 0,
        totalTransfers: 0,
        chip: 'NONE',
        livePoints: 0,
        transferCost: 0,
        liveNetPoints: 0,
        liveTotalPoints: 0,
        played: 0,
        toPlay: 0,
        playedCaptain: 0,
        captainName: '',
        pickList: [],
        transfersList: [],
      };
    }

    // Parallel fetch all initial data
    const [
      entry,
      currentResult,
      previousResult,
      pickEntity,
      fixtures,
      teams,
    ]: [
      Entry | null,
      EntryEventResult | null,
      EntryEventResult | null,
      EntryEventPick | null,
      Fixture[],
      Team[],
    ] = await Promise.all([
      entriesService.getEntryById(context, entryId),
      entriesService.getEntryEventResult(context, entryId, eventId),
      eventId > 1
        ? entriesService.getEntryEventResult(context, entryId, eventId - 1)
        : Promise.resolve<EntryEventResult | null>(null),
      entryLiveRepository.getEntryEventPick(context, entryId, eventId),
      getEventFixtures(context, eventId),
      playersRepository.listTeams(context),
    ]);

    const entryInfo: Entry | null = entry;
    const teamsById: Map<number, Team> = teamMapById(teams);
    const fixturesByTeam: Map<number, Fixture[]> = buildFixtureIndex(fixtures);

    const chip = normalizeChip(pickEntity?.chip ?? null);
    const transferCost =
      (currentResult?.eventTransfersCost ?? null) ??
      (pickEntity?.transfersCost ?? 0);

    const picks: EntryPick[] = pickEntity?.picks ?? [];

    // Fetch transfers early so we can batch-load all players at once
    const transferRows = await entryLiveRepository.getEntryEventTransfers(
      context,
      entryId,
      eventId,
    );

    // Collect all unique player IDs we need (from picks + transfers)
    const allPlayerIds = new Set<number>();
    picks.forEach((pick) => allPlayerIds.add(pick.element));
    transferRows.forEach((t) => {
      allPlayerIds.add(t.elementIn);
      allPlayerIds.add(t.elementOut);
    });

    const playerIdList = Array.from(allPlayerIds);
    const playersPromise: Promise<Player[]> = playersRepository.getPlayersByIds(
      context,
      playerIdList
    );
    const livePromise = liveRepository.getLivePerformancesByPlayerIds(
      context,
      eventId,
      playerIdList,
    );
    const [playersList, livePerformances] = await Promise.all(
      [playersPromise, livePromise] as const
    );
    const playersById: Map<number, Player> = new Map(playersList.map((player) => [player.id, player]));
    const liveByPlayer: Map<number, LivePerformance> = liveMapByPlayerId(livePerformances);

    // Static + live per pick (now purely CPU work, no I/O)
    const pickList: ElementEventResultData[] = picks.map((pick) => {
      const player = playersById.get(pick.element) ?? null;
      const team = player ? teamsById.get(player.teamId) : undefined;
      const teamFixtures = player ? fixturesByTeam.get(player.teamId) : undefined;
      const matchInfo = buildTeamMatchInfo({
        teamId: player?.teamId ?? 0,
        team,
        fixtures: teamFixtures,
        teamsById,
      });

      const live = liveByPlayer.get(pick.element);
      const elementType = player?.position ?? 0;
      
      // Extract live stats with safe defaults (reduced null coalescing)
      const minutes = safeNull(live?.minutes, 0);
      const yellowCards = safeNull(live?.yellowCards, 0);
      const redCards = safeNull(live?.redCards, 0);
      const isPlayed = minutes > 0 || yellowCards > 0 || redCards > 0;
      
      const defensiveContribution: number = safeNull(live?.defensiveContribution, 0);

      // Calculate live points from individual stats
      const calculatedTotalPoints = calcElementLivePoints(elementType, live);

      return {
        season: null,
        event: eventId,
        element: pick.element,
        code: player?.code ?? 0,
        webName: player?.webName ?? '',
        price: player ? player.price / 10 : 0,
        elementType,
        elementTypeName: elementTypeName(player),
        teamId: player?.teamId ?? 0,
        teamCode: matchInfo.teamCode,
        teamName: matchInfo.teamName,
        teamShortName: matchInfo.teamShortName,
        againstId: matchInfo.againstId,
        againstName: matchInfo.againstName,
        againstShortName:
          matchInfo.againstShortName.length > 0
            ? matchInfo.againstShortName
            : 'BLANK',
        wasHome: matchInfo.wasHome,
        score: matchInfo.score,
        position: pick.position,
        multiplier: pick.multiplier,
        isCaptain: pick.isCaptain,
        isViceCaptain: pick.isViceCaptain,
        isGwStarted: matchInfo.isGwStarted,
        isGwFinished: matchInfo.isGwFinished,
        isPlayed,
        playStatus: matchInfo.playStatus,
        minutes,
        goalsScored: safeNull(live?.goalsScored, 0),
        assists: safeNull(live?.assists, 0),
        cleanSheets: safeNull(live?.cleanSheets, 0),
        goalsConceded: safeNull(live?.goalsConceded, 0),
        defensiveContribution,
        ownGoals: safeNull(live?.ownGoals, 0),
        penaltiesSaved: safeNull(live?.penaltiesSaved, 0),
        penaltiesMissed: safeNull(live?.penaltiesMissed, 0),
        yellowCards,
        redCards,
        saves: safeNull(live?.saves, 0),
        bonus: safeNull(live?.bonus, 0),
        bps: safeNull(live?.bps, 0),
        totalPoints: calculatedTotalPoints,
        starts: live?.starts ?? null,
        expectedGoals: parseNullableFloat(live?.expectedGoals),
        expectedAssists: parseNullableFloat(live?.expectedAssists),
        expectedGoalInvolvements: parseNullableFloat(live?.expectedGoalInvolvements),
        expectedGoalsConceded: parseNullableFloat(live?.expectedGoalsConceded),
        inDreamTeam: live?.inDreamTeam ?? null,
        pickActive: false,
        autoSub: false,
        bgw: matchInfo.bgw,
        dgw: matchInfo.dgw,
      };
    });

    // Determine active picks based on chip and mark them in a single pass
    const isBenchBoost = chip === 'BENCH_BOOST';
    const activePicks: ElementEventResultData[] = [];

    for (const pick of pickList) {
      const isActive = isBenchBoost ? true : pick.multiplier > 0;
      const autoSub = !isBenchBoost && pick.position > 11 && pick.multiplier > 0;
      pick.pickActive = isActive;
      pick.autoSub = autoSub;
      if (isActive) {
        activePicks.push(pick);
      }
    }

    const captainForScoring = selectCaptainForScoring(activePicks);
    const captainMultiplier = chip === 'TRIPLE_CAPTAIN' ? 3 : 2;

    // Calculate live points: sum of all active picks with captain multiplier applied
    // Optimized: avoid conditional checks in reduce loop
    const captainElementId = captainForScoring?.element;
    const livePoints = activePicks.reduce((sum, p) => {
      if (captainElementId !== undefined && p.element === captainElementId) {
        return sum + p.totalPoints * captainMultiplier;
      }
      return sum + p.totalPoints;
    }, 0);

    const liveNetPoints = livePoints - transferCost;
    // Last overall = previous event's overall points (GW21 when querying GW22).
    const lastOverallPoints = previousResult?.overallPoints ?? 0;
    const lastOverallRank = previousResult?.overallRank ?? 0;
    const lastValue = asScaled(previousResult?.teamValue ?? null, 10);
    // Live total = last overall + current live net points
    const liveTotalPoints = lastOverallPoints + liveNetPoints;

    const played = activePicks.filter((p) => p.isPlayed || p.bgw || p.isGwFinished).length;
    const toPlay = activePicks.filter((p) => !p.isGwStarted && !p.isGwFinished && !p.bgw).length;

    const playedCaptain = captainForScoring?.element ?? 0;
    const captainName = captainForScoring?.webName ?? '';

    // Transfers enrichment (players already loaded in playersById)
    const transfersList: EntryEventTransfersData[] = transferRows.map((t) => {
      const inPlayer = playersById.get(t.elementIn) ?? null;
      const outPlayer = playersById.get(t.elementOut) ?? null;
      const inTeam = inPlayer ? teamsById.get(inPlayer.teamId) : undefined;
      const outTeam = outPlayer ? teamsById.get(outPlayer.teamId) : undefined;
      const inLive = liveByPlayer.get(t.elementIn);
      const outLive = liveByPlayer.get(t.elementOut);

      return {
        event: eventId,
        entry: entryId,
        elementIn: t.elementIn,
        elementInWebName: inPlayer?.webName ?? '',
        elementInType: inPlayer?.position ?? 0,
        elementInTypeName: elementTypeName(inPlayer),
        elementInTeamId: inPlayer?.teamId ?? 0,
        elementInTeamName: inTeam?.name ?? '',
        elementInTeamShortName: inTeam?.shortName ?? '',
        elementInCost: inPlayer ? inPlayer.price / 10 : 0,
        elementInPoints: inLive?.totalPoints ?? 0,
        elementInPlayed: (inLive?.minutes ?? 0) > 0,
        elementOut: t.elementOut,
        elementOutWebName: outPlayer?.webName ?? '',
        elementOutTeamId: outPlayer?.teamId ?? 0,
        elementOutTeamName: outTeam?.name ?? '',
        elementOutTeamShortName: outTeam?.shortName ?? '',
        elementOutType: outPlayer?.position ?? 0,
        elementOutTypeName: elementTypeName(outPlayer),
        elementOutCost: outPlayer ? outPlayer.price / 10 : 0,
        elementOutPoints: outLive?.totalPoints ?? 0,
        time: t.time ?? '',
      };
    });

    return {
      rank: currentResult?.eventRank ?? 0,
      event: eventId,
      entry: entryId,
      entryName: entryInfo?.entryName ?? '',
      playerName: entryInfo?.playerName ?? '',
      region: entryInfo?.region ?? null,
      startedEvent: safeInt(entryInfo?.startedEvent),
      overallPoints: safeInt(entryInfo?.overallPoints),
      overallRank: safeInt(entryInfo?.overallRank),
      value: asScaled(entryInfo?.teamValue ?? null, 10),
      bank: asScaled(entryInfo?.bank ?? null, 10),
      teamValue: asScaled(
        (entryInfo?.teamValue ?? null) !== null && (entryInfo?.bank ?? null) !== null
          ? safeInt(entryInfo?.teamValue) - safeInt(entryInfo?.bank)
          : null,
        10
      ),
      totalTransfers: safeInt(entryInfo?.totalTransfers),
      lastOverallPoints,
      lastOverallRank,
      lastValue,
      chip,
      livePoints,
      transferCost,
      liveNetPoints,
      liveTotalPoints,
      played,
      toPlay,
      playedCaptain,
      captainName,
      pickList: [...pickList].sort((a, b) => a.position - b.position),
      transfersList,
    };
  },
};
