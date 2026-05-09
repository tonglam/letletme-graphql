import type { GraphQLContext } from "../../graphql/context";
import { MAX_EVENT_ID } from "../../infra/config";
import { getCurrentEventId } from "../../infra/event";
import { buildPlayerMap } from "../../infra/player-map";
import { getCurrentSeason } from "../../infra/season";
import { buildTeamMap } from "../../infra/team-map";
import type { Player, Team } from "../../infra/types";
import {
	calcElementLivePoints,
	type ElementEventResultData,
} from "../entry-live/calc-service";
import type { Fixture } from "../fixtures/repository";
import { fixturesRepository } from "../fixtures/repository";
import { loadLiveBonusByPlayerId } from "../live/bonus-cache";
import type { LivePerformance } from "../live/repository";
import { liveRepository } from "../live/repository";

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
	playStatus: "NEXT_EVENT" | "NOT_STARTED" | "PLAYING" | "FINISHED";
};

export type LiveMatches = {
	nextEvent: LiveMatchData[];
	notStarted: LiveMatchData[];
	playing: LiveMatchData[];
	finished: LiveMatchData[];
};

type MatchBucketStatus = Exclude<LiveMatchData["playStatus"], "NEXT_EVENT">;

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
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
};

const asNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const asBoolean = (value: unknown): boolean | null => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1") {
			return true;
		}
		if (normalized === "false" || normalized === "0") {
			return false;
		}
	}
	if (typeof value === "number") {
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
	typeof value === "string" ? value : null;

const parseJsonUnknown = (value: string): unknown | null => {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
};

const normalizeLiveFixtureStatus = (
	rawStatus: string,
): MatchBucketStatus | null => {
	const normalized = rawStatus
		.trim()
		.toUpperCase()
		.replace(/[\s-]+/g, "_");
	if (normalized === "NOT_STARTED" || normalized === "NOT_START") {
		return "NOT_STARTED";
	}
	if (normalized === "PLAYING" || normalized === "EVENT_NOT_FINISHED") {
		return "PLAYING";
	}
	if (normalized === "FINISHED") {
		return "FINISHED";
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
		teamName: asString(row.teamName ?? row.team_name) ?? "",
		teamShortName: asString(row.teamShortName ?? row.team_short_name) ?? "",
		teamScore: Math.trunc(asNumber(row.teamScore ?? row.team_score) ?? 0),
		againstId: Math.trunc(againstId),
		againstName: asString(row.againstName ?? row.against_name) ?? "",
		againstShortName:
			asString(row.againstShortName ?? row.against_short_name) ?? "",
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
	} else if (typeof value === "string") {
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

const parseLiveFixtureHashFieldValue = (
	value: string,
): MatchBucketsFromRedis => {
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
		if (status === "NOT_STARTED") {
			buckets.notStarted.push(...fixtures);
			return;
		}
		if (status === "PLAYING") {
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
		(acc, fieldValue) =>
			mergeMatchBuckets(acc, parseLiveFixtureHashFieldValue(fieldValue)),
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
	bonusByPlayerId: Map<number, number>,
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
		const perfWithLiveBonus: LivePerformance = { ...perf, bonus };
		const totalPoints = calcElementLivePoints(player.position, perfWithLiveBonus);
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
			expectedGoals: perf.expectedGoals
				? Number.parseFloat(perf.expectedGoals)
				: null,
			expectedAssists: perf.expectedAssists
				? Number.parseFloat(perf.expectedAssists)
				: null,
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
			data.sort((a, b) => b.totalPoints - a.totalPoints),
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
	playStatus: "NEXT_EVENT" | "NOT_STARTED" | "PLAYING" | "FINISHED",
	teamDataMap: Map<number, ElementEventResultData[]>,
	teamsById: Map<number, Team>,
): LiveMatchData => {
	const homeTeam = teamsById.get(fixture.teamHId);
	const awayTeam = teamsById.get(fixture.teamAId);

	// Get team data lists from pre-built map (empty for NEXT_EVENT)
	const homeTeamDataList =
		playStatus === "NEXT_EVENT" ? [] : (teamDataMap.get(fixture.teamHId) ?? []);
	const awayTeamDataList =
		playStatus === "NEXT_EVENT" ? [] : (teamDataMap.get(fixture.teamAId) ?? []);

	const minutes =
		playStatus === "NEXT_EVENT"
			? 0
			: Math.max(
					getMaxMinutes(homeTeamDataList),
					getMaxMinutes(awayTeamDataList),
				);

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
		homeTeamName: fixture.teamName || homeTeam?.name || "",
		homeTeamShortName: fixture.teamShortName || homeTeam?.shortName || "",
		homePosition: homeTeam?.position ?? 0,
		homeScore: fixture.teamScore,
		homeTeamDataList,
		awayTeamId: fixture.againstId,
		awayTeamName: fixture.againstName || awayTeam?.name || "",
		awayTeamShortName: fixture.againstShortName || awayTeam?.shortName || "",
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

export const liveMatchesService = {
	async getAllLiveMatches(
		context: GraphQLContext,
		upcoming = false,
	): Promise<LiveMatches> {
		const currentEventId = await getCurrentEventId(context);

		if (!currentEventId) {
			return {
				nextEvent: [],
				notStarted: [],
				playing: [],
				finished: [],
			};
		}

		const [teamsById, redisBuckets] = await Promise.all([
			buildTeamMap(context),
			loadLiveFixtureBucketsFromRedis(context, currentEventId),
		]);

		let notStartedMatches: LiveMatchData[] = [];
		let playingMatches: LiveMatchData[] = [];
		let finishedMatches: LiveMatchData[] = [];
		let teamDataMap = new Map<number, ElementEventResultData[]>();

		if (redisBuckets) {
			const needsLiveData =
				redisBuckets.playing.length > 0 || redisBuckets.finished.length > 0;

			if (needsLiveData) {
				const livePerformancesMap = await liveRepository.getAllLivePerformances(
					context,
					currentEventId,
				);
				const livePerformances = Array.from(livePerformancesMap.values());

				const relevantTeamIds = new Set<number>();
				for (const fixture of [
					...redisBuckets.playing,
					...redisBuckets.finished,
				]) {
					relevantTeamIds.add(fixture.teamId);
					relevantTeamIds.add(fixture.againstId);
				}

				const playerIds = new Set<number>();
				for (const perf of livePerformances) {
					if (perf.playerId) {
						playerIds.add(perf.playerId);
					}
				}

				const playersById =
					playerIds.size > 0
						? await buildPlayerMap(context, Array.from(playerIds))
						: new Map<number, Player>();

				const filteredPerformances = livePerformances.filter((p) => {
					if (!p.playerId) return false;
					const player = playersById.get(p.playerId);
					return player && relevantTeamIds.has(player.teamId);
				});

				teamDataMap = buildTeamDataMap(
					currentEventId,
					filteredPerformances,
					playersById,
					teamsById,
					await loadLiveBonusByPlayerId(context, currentEventId),
				);
			}

			notStartedMatches = redisBuckets.notStarted.map((fixture, i) =>
				buildMatchFromRedis(
					fixture,
					i + 1,
					"NOT_STARTED",
					teamDataMap,
					teamsById,
				),
			);
			playingMatches = redisBuckets.playing.map((fixture, i) =>
				buildMatchFromRedis(fixture, i + 1, "PLAYING", teamDataMap, teamsById),
			);
			finishedMatches = redisBuckets.finished.map((fixture, i) =>
				buildMatchFromRedis(fixture, i + 1, "FINISHED", teamDataMap, teamsById),
			);
		}

		let nextEventMatches: LiveMatchData[] = [];
		if (upcoming && currentEventId <= MAX_EVENT_ID) {
			const nextFixtures = await fixturesRepository.getEventFixtures(
				context,
				currentEventId + 1,
			);
			nextEventMatches = nextFixtures.map((fixture, i) =>
				buildMatch(fixture, i + 1, "NEXT_EVENT", teamDataMap, teamsById),
			);
		}

		return {
			nextEvent: sortByKickoffTime(nextEventMatches),
			notStarted: sortByKickoffTime(notStartedMatches),
			playing: sortByKickoffTime(playingMatches),
			finished: sortByKickoffTime(finishedMatches),
		};
	},
};
