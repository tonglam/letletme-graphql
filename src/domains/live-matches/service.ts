import type { GraphQLContext } from "../../graphql/context";
import { getLiveDataSnapshot, type LiveFixtureData } from "../../infra/data-snapshot";
import { getCurrentEventId } from "../../infra/event";
import { buildPlayerMap } from "../../infra/player-map";
import { buildTeamMap } from "../../infra/team-map";
import type { Player, Team } from "../../infra/types";
import { calcElementLivePoints, type ElementEventResultData } from "../entry-live/calc-service";
import type { Fixture } from "../fixtures/repository";
import { fixturesRepository } from "../fixtures/repository";
import { loadLiveBonusByPlayerId } from "../live/bonus-cache";
import type { LivePerformance } from "../live/repository";
import { liveRepository } from "../live/repository";
import { LiveSnapshotCoherenceError, withLiveSnapshotConsistency } from "../live/snapshot-meta";

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
	playStatus: "NOT_STARTED" | "PLAYING" | "FINISHED";
};

export type LiveMatches = {
	notStarted: LiveMatchData[];
	playing: LiveMatchData[];
	finished: LiveMatchData[];
};

type MatchBucketStatus = LiveMatchData["playStatus"];

export const resolveLiveMatchStatus = (
	fixture: Pick<Fixture, "id" | "teamHId" | "teamAId" | "finished" | "started">,
	statusByFixtureId: ReadonlyMap<number, MatchBucketStatus>
): MatchBucketStatus =>
	statusByFixtureId.get(fixture.id) ??
	(fixture.finished ? "FINISHED" : fixture.started ? "PLAYING" : "NOT_STARTED");

type LiveFixtureRedisRow = {
	fixtureId: number;
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

type LiveFixtureIdentity = Pick<Fixture, "id" | "teamHId" | "teamAId">;
type LiveFixtureIdentitySource =
	readonly LiveFixtureIdentity[] | PromiseLike<readonly LiveFixtureIdentity[]>;

export const applyLiveFixtureScores = (
	fixture: Fixture,
	liveFixture: Pick<LiveFixtureRedisRow, "teamScore" | "againstTeamScore"> | null
): Fixture =>
	liveFixture
		? {
				...fixture,
				teamHScore: liveFixture.teamScore,
				teamAScore: liveFixture.againstTeamScore,
			}
		: fixture;

const liveFixtureRows = (buckets: MatchBucketsFromRedis): LiveFixtureRedisRow[] => [
	...buckets.notStarted,
	...buckets.playing,
	...buckets.finished,
];

/**
 * A cardinality match is not an identity match: a same-sized hash from another
 * event can otherwise look complete. Bind every parsed home-side row to the
 * coherent Fixtures sibling by fixture ID and confirm its ordered home/away
 * team identity.
 */
export const matchesLiveFixtureIdentities = (
	buckets: MatchBucketsFromRedis,
	expectedFixtures: readonly LiveFixtureIdentity[]
): boolean => {
	const rows = liveFixtureRows(buckets);
	if (rows.length !== expectedFixtures.length) return false;

	const expectedById = new Map(expectedFixtures.map((fixture) => [fixture.id, fixture]));
	const matchedFixtureIds = new Set<number>();
	for (const row of rows) {
		const fixture = expectedById.get(row.fixtureId);
		if (
			!fixture ||
			matchedFixtureIds.has(fixture.id) ||
			fixture.teamHId !== row.teamId ||
			fixture.teamAId !== row.againstId
		) {
			return false;
		}
		matchedFixtureIds.add(fixture.id);
	}

	return matchedFixtureIds.size === expectedFixtures.length;
};

export const loadLiveFixtureBucketsFromRedis = async (
	context: GraphQLContext,
	eventId: number,
	expectedFixturesSource: LiveFixtureIdentitySource
): Promise<MatchBucketsFromRedis | null> => {
	const [snapshot, expectedFixtures] = await Promise.all([
		getLiveDataSnapshot(context, eventId),
		Promise.resolve(expectedFixturesSource),
	]);
	const mapRow = (fixture: LiveFixtureData): LiveFixtureRedisRow => ({
		fixtureId: fixture.fixtureId,
		teamId: fixture.teamId,
		teamName: fixture.teamName,
		teamShortName: fixture.teamShortName,
		teamScore: fixture.teamScore,
		againstId: fixture.againstId,
		againstName: fixture.againstName,
		againstShortName: fixture.againstShortName,
		againstTeamScore: fixture.againstTeamScore,
		kickoffTime: fixture.kickoffTime,
		wasHome: fixture.wasHome,
	});
	const buckets = Object.values(snapshot.liveFixtures).reduce<MatchBucketsFromRedis>(
		(result, value) => ({
			notStarted: [
				...result.notStarted,
				...value.Not_Start.filter((fixture) => fixture.wasHome).map(mapRow),
			],
			playing: [
				...result.playing,
				...value.Playing.filter((fixture) => fixture.wasHome).map(mapRow),
			],
			finished: [
				...result.finished,
				...value.Finished.filter((fixture) => fixture.wasHome).map(mapRow),
			],
		}),
		{ notStarted: [], playing: [], finished: [] }
	);
	if (!matchesLiveFixtureIdentities(buckets, expectedFixtures)) {
		throw new LiveSnapshotCoherenceError(
			eventId,
			"liveFixtures",
			`Live fixture identities do not match revision ${snapshot.revision}`
		);
	}
	return buckets;
};

const elementTypeName = (position: number): string => {
	switch (position) {
		case 1:
			return "GKP";
		case 2:
			return "DEF";
		case 3:
			return "MID";
		case 4:
			return "FWD";
		default:
			return "";
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
	bonusByPlayerId: Map<number, number>
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
		const bonus = bonusByPlayerId.get(perf.playerId) ?? perf.bonus ?? 0;
		const totalPoints = calcElementLivePoints(perf, bonus);
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
			teamName: team?.name ?? "",
			teamShortName: team?.shortName ?? "",
			againstId: 0,
			againstName: "",
			againstShortName: "",
			wasHome: "",
			score: "",
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
		teamDataMap.set(
			teamId,
			data.sort((a, b) => b.totalPoints - a.totalPoints)
		);
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
	playStatus: "NOT_STARTED" | "PLAYING" | "FINISHED",
	teamDataMap: Map<number, ElementEventResultData[]>,
	teamsById: Map<number, Team>
): LiveMatchData => {
	const homeTeam = teamsById.get(fixture.teamHId);
	const awayTeam = teamsById.get(fixture.teamAId);

	const homeTeamDataList = teamDataMap.get(fixture.teamHId) ?? [];
	const awayTeamDataList = teamDataMap.get(fixture.teamAId) ?? [];

	const minutes = Math.max(getMaxMinutes(homeTeamDataList), getMaxMinutes(awayTeamDataList));

	return {
		matchId,
		minutes,
		homeTeamId: fixture.teamHId,
		homeTeamName: homeTeam?.name ?? "",
		homeTeamShortName: homeTeam?.shortName ?? "",
		homePosition: homeTeam?.position ?? 0,
		homeScore: fixture.teamHScore ?? 0,
		homeTeamDataList,
		awayTeamId: fixture.teamAId,
		awayTeamName: awayTeam?.name ?? "",
		awayTeamShortName: awayTeam?.shortName ?? "",
		awayPosition: awayTeam?.position ?? 0,
		awayScore: fixture.teamAScore ?? 0,
		awayTeamDataList,
		kickoffTime: fixture.kickoffTime,
		playStatus,
	};
};

const kickoffTimestamp = (value: string | null): number | null => {
	if (!value) {
		return null;
	}
	const normalized = value.includes(" ") ? value.replace(" ", "T") : value;
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

const emptyLiveMatches = (): LiveMatches => ({
	notStarted: [],
	playing: [],
	finished: [],
});

export const liveMatchesService = {
	async getAllLiveMatches(context: GraphQLContext): Promise<LiveMatches> {
		const currentEventId = await getCurrentEventId(context);

		if (currentEventId === null) return emptyLiveMatches();
		return withLiveSnapshotConsistency(context, currentEventId, async () => {
			const currentFixturesPromise = fixturesRepository.getEventFixtures(context, currentEventId);
			const [teamsById, redisBuckets, currentFixtures] = await Promise.all([
				buildTeamMap(context),
				loadLiveFixtureBucketsFromRedis(context, currentEventId, currentFixturesPromise),
				currentFixturesPromise,
			]);

			const notStartedMatches: LiveMatchData[] = [];
			const playingMatches: LiveMatchData[] = [];
			const finishedMatches: LiveMatchData[] = [];
			let teamDataMap = new Map<number, ElementEventResultData[]>();

			const statusByFixtureId = new Map<number, MatchBucketStatus>();
			const liveFixtureById = new Map<number, LiveFixtureRedisRow>();
			if (redisBuckets) {
				for (const [status, fixtures] of [
					["NOT_STARTED", redisBuckets.notStarted],
					["PLAYING", redisBuckets.playing],
					["FINISHED", redisBuckets.finished],
				] as const) {
					for (const fixture of fixtures) {
						statusByFixtureId.set(fixture.fixtureId, status);
						liveFixtureById.set(fixture.fixtureId, fixture);
					}
				}
			}

			const needsLiveData =
				currentFixtures.some((fixture) => fixture.started || fixture.finished) ||
				Boolean(redisBuckets?.playing.length || redisBuckets?.finished.length);
			if (needsLiveData) {
				const [livePerformancesMap, bonusByPlayerId] = await Promise.all([
					liveRepository.getAllLivePerformances(context, currentEventId),
					loadLiveBonusByPlayerId(context, currentEventId),
				]);
				const livePerformances = Array.from(livePerformancesMap.values());
				const playerIds = livePerformances.map((performance) => performance.playerId);
				const playersById =
					playerIds.length > 0
						? await buildPlayerMap(context, playerIds)
						: new Map<number, Player>();
				teamDataMap = buildTeamDataMap(
					currentEventId,
					livePerformances,
					playersById,
					teamsById,
					bonusByPlayerId
				);
			}

			for (const fixture of currentFixtures) {
				const status = resolveLiveMatchStatus(fixture, statusByFixtureId);
				const liveFixture = liveFixtureById.get(fixture.id) ?? null;
				const match = buildMatch(
					applyLiveFixtureScores(fixture, liveFixture),
					fixture.id,
					status,
					teamDataMap,
					teamsById
				);
				if (status === "FINISHED") finishedMatches.push(match);
				else if (status === "PLAYING") playingMatches.push(match);
				else notStartedMatches.push(match);
			}

			return {
				notStarted: sortByKickoffTime(notStartedMatches),
				playing: sortByKickoffTime(playingMatches),
				finished: sortByKickoffTime(finishedMatches),
			};
		});
	},
};
