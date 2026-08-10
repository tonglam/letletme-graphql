import type { GraphQLContext } from "../../graphql/context";
import { MAX_EVENT_ID } from "../../infra/config";
import { getCurrentEventId } from "../../infra/event";
import { buildPlayerMap } from "../../infra/player-map";
import { getCurrentSeason } from "../../infra/season";
import { buildTeamMap } from "../../infra/team-map";
import type { Player, Team } from "../../infra/types";
import { calcElementLivePoints, type ElementEventResultData } from "../entry-live/calc-service";
import type { Fixture } from "../fixtures/repository";
import { fixturesRepository } from "../fixtures/repository";
import { loadLiveBonusByPlayerId } from "../live/bonus-cache";
import type { LivePerformance } from "../live/repository";
import { liveRepository } from "../live/repository";
import {
	isLiveSnapshotConsistencyActive,
	isLiveSnapshotDatabaseFallback,
	LiveSnapshotCoherenceError,
	loadLiveSnapshotMeta,
	withLiveSnapshotConsistency,
} from "../live/snapshot-meta";

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

export const resolveLiveMatchStatus = (
	fixture: Pick<Fixture, "id" | "teamHId" | "teamAId" | "finished" | "started">,
	statusByFixtureId: ReadonlyMap<number, MatchBucketStatus>,
	statusByPair: ReadonlyMap<string, MatchBucketStatus>
): MatchBucketStatus =>
	statusByFixtureId.get(fixture.id) ??
	statusByPair.get(`${fixture.teamHId}:${fixture.teamAId}`) ??
	(fixture.finished ? "FINISHED" : fixture.started ? "PLAYING" : "NOT_STARTED");

type LiveFixtureRedisRow = {
	fixtureId: number | null;
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
		const trimmed = value.trim();
		if (trimmed.length === 0) return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const pickField = (
	row: Record<string, unknown>,
	keys: string[]
): { present: boolean; value: unknown } => {
	for (const key of keys) {
		if (Object.hasOwn(row, key)) return { present: true, value: row[key] };
	}
	return { present: false, value: undefined };
};

const parseOptionalInt = (
	field: { present: boolean; value: unknown },
	defaultValue: number
): { value: number; valid: boolean } => {
	if (!field.present || field.value === null) return { value: defaultValue, valid: true };
	const value = asNumber(field.value);
	return {
		value: value ?? defaultValue,
		valid:
			value !== null &&
			Number.isInteger(value) &&
			value >= -2_147_483_648 &&
			value <= 2_147_483_647,
	};
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

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseJsonUnknown = (value: string): unknown | null => {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
};

const normalizeLiveFixtureStatus = (rawStatus: string): MatchBucketStatus | null => {
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

export const parseLiveFixtureRow = (value: unknown): LiveFixtureRedisRow | null => {
	const row = asRecord(value);
	if (!row) {
		return null;
	}

	const teamId = asNumber(pickField(row, ["teamId", "team_id"]).value);
	const againstId = asNumber(pickField(row, ["againstId", "against_id"]).value);
	if (
		teamId === null ||
		againstId === null ||
		!Number.isInteger(teamId) ||
		!Number.isInteger(againstId) ||
		teamId <= 0 ||
		againstId <= 0
	) {
		return null;
	}

	const fixtureField = pickField(row, ["fixtureId", "fixture_id", "fixture", "id"]);
	const fixtureId = asNumber(fixtureField.value);
	if (fixtureField.present && fixtureField.value !== null && fixtureId === null) {
		return null;
	}
	if (fixtureId !== null && (!Number.isInteger(fixtureId) || fixtureId <= 0)) {
		return null;
	}

	const teamScore = parseOptionalInt(pickField(row, ["teamScore", "team_score"]), 0);
	const againstTeamScore = parseOptionalInt(
		pickField(row, ["againstTeamScore", "against_team_score"]),
		0
	);
	if (!teamScore.valid || !againstTeamScore.valid) return null;
	const wasHomeField = pickField(row, ["wasHome", "was_home"]);
	const wasHome = asBoolean(wasHomeField.value);
	if (wasHomeField.present && wasHomeField.value !== null && wasHome === null) return null;

	return {
		fixtureId: fixtureId === null ? null : fixtureId,
		teamId,
		teamName: asString(row.teamName ?? row.team_name) ?? "",
		teamShortName: asString(row.teamShortName ?? row.team_short_name) ?? "",
		teamScore: teamScore.value,
		againstId: againstId,
		againstName: asString(row.againstName ?? row.against_name) ?? "",
		againstShortName: asString(row.againstShortName ?? row.against_short_name) ?? "",
		againstTeamScore: againstTeamScore.value,
		kickoffTime: asString(row.kickoffTime ?? row.kickoff_time),
		wasHome: wasHome ?? false,
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
	source: MatchBucketsFromRedis
): MatchBucketsFromRedis => ({
	notStarted: [...target.notStarted, ...source.notStarted],
	playing: [...target.playing, ...source.playing],
	finished: [...target.finished, ...source.finished],
});

const liveFixtureRows = (buckets: MatchBucketsFromRedis): LiveFixtureRedisRow[] => [
	...buckets.notStarted,
	...buckets.playing,
	...buckets.finished,
];

/**
 * A cardinality match is not an identity match: a same-sized hash from another
 * event can otherwise look complete. Bind every parsed home-side row to the
 * coherent Fixtures sibling by fixture ID when available and always by the
 * ordered home/away team pair. Legacy rows without IDs consume one unmatched
 * expected pair, which also handles the unlikely duplicate-pair case safely.
 */
export const matchesLiveFixtureIdentities = (
	buckets: MatchBucketsFromRedis,
	expectedFixtures: readonly LiveFixtureIdentity[]
): boolean => {
	const rows = liveFixtureRows(buckets);
	if (rows.length !== expectedFixtures.length) return false;

	const expectedById = new Map(expectedFixtures.map((fixture) => [fixture.id, fixture]));
	const expectedIdsByPair = new Map<string, number[]>();
	for (const fixture of expectedFixtures) {
		const pair = `${fixture.teamHId}:${fixture.teamAId}`;
		const ids = expectedIdsByPair.get(pair) ?? [];
		ids.push(fixture.id);
		expectedIdsByPair.set(pair, ids);
	}

	const matchedFixtureIds = new Set<number>();
	for (const row of rows) {
		const pair = `${row.teamId}:${row.againstId}`;
		const fixture =
			row.fixtureId === null
				? expectedById.get(
						expectedIdsByPair.get(pair)?.find((id) => !matchedFixtureIds.has(id)) ?? -1
					)
				: expectedById.get(row.fixtureId);
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
	if (isLiveSnapshotDatabaseFallback(context, eventId)) return null;
	const expectedFixturesPromise = Promise.resolve(expectedFixturesSource);
	const season = await getCurrentSeason(context);
	const meta = await loadLiveSnapshotMeta(context, eventId, { season });
	for (const prefix of ["LiveFixtureV2", "LiveFixture"] as const) {
		const redisKey = `${prefix}:${season}:${eventId}`;
		let hashEntries: Record<string, string>;
		try {
			hashEntries = await context.redis.hgetall(redisKey);
		} catch (error) {
			context.logger.warn({ err: error, redisKey }, "Failed to read live fixtures from Redis");
			continue;
		}
		const fields = Object.values(hashEntries);
		if (fields.length === 0) {
			// A confirmed blank gameweek is a complete, intentionally empty
			// publication. Do not turn it into a database fallback just because
			// its Redis hash has no team buckets.
			if (meta?.fixtureCount === 0 && meta.fixtureTeamCount === 0) {
				const expectedFixtures = await expectedFixturesPromise;
				if (expectedFixtures.length === 0) {
					return { notStarted: [], playing: [], finished: [] };
				}
			}
			continue;
		}
		if (meta && fields.length !== meta.fixtureTeamCount) {
			context.logger.warn(
				{
					redisKey,
					revision: meta.revision,
					expectedCount: meta.fixtureTeamCount,
					actualCount: fields.length,
				},
				"Incomplete live fixture revision; trying compatibility view"
			);
			continue;
		}

		const buckets = fields.reduce<MatchBucketsFromRedis>(
			(acc, fieldValue) => mergeMatchBuckets(acc, parseLiveFixtureHashFieldValue(fieldValue)),
			{ notStarted: [], playing: [], finished: [] }
		);

		const fixtureCount =
			buckets.notStarted.length + buckets.playing.length + buckets.finished.length;
		if (meta && fixtureCount !== meta.fixtureCount) {
			context.logger.warn(
				{
					redisKey,
					revision: meta.revision,
					expectedCount: meta.fixtureCount,
					actualCount: fixtureCount,
				},
				"Malformed live fixture revision; trying compatibility view"
			);
			continue;
		}
		const expectedFixtures = await expectedFixturesPromise;
		if (!matchesLiveFixtureIdentities(buckets, expectedFixtures)) {
			context.logger.warn(
				{
					redisKey,
					revision: meta?.revision,
					expectedCount: expectedFixtures.length,
					actualCount: fixtureCount,
				},
				"Mismatched live fixture identities; trying compatibility view"
			);
			continue;
		}

		if (fixtureCount > 0) {
			return buckets;
		}
	}

	if (meta && isLiveSnapshotConsistencyActive(context, eventId)) {
		throw new LiveSnapshotCoherenceError(
			eventId,
			"LiveFixture",
			`No complete live fixture view remains for revision ${meta.revision}`
		);
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
	fixtureCountByTeam: ReadonlyMap<number, number>
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
		const totalPoints = calcElementLivePoints(
			player.position,
			perf,
			bonus,
			fixtureCountByTeam.get(player.teamId) ?? 1
		);
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
	playStatus: "NEXT_EVENT" | "NOT_STARTED" | "PLAYING" | "FINISHED",
	teamDataMap: Map<number, ElementEventResultData[]>,
	teamsById: Map<number, Team>
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
			: Math.max(getMaxMinutes(homeTeamDataList), getMaxMinutes(awayTeamDataList));

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

export const loadUpcomingEventFixtures = (
	context: GraphQLContext,
	currentEventId: number
): Promise<Fixture[]> => {
	if (currentEventId >= MAX_EVENT_ID) return Promise.resolve([]);
	const nextEventId = currentEventId + 1;
	return withLiveSnapshotConsistency(
		context,
		nextEventId,
		() => fixturesRepository.getEventFixtures(context, nextEventId),
		// This read is nested inside the current-event liveMatches root. Its own
		// revision remains coherent, but only the enclosing calculation may release
		// sibling GraphQL roots from the request-wide first-pass barrier.
		{ participateInRootBarrier: false }
	);
};

export const liveMatchesService = {
	async getAllLiveMatches(context: GraphQLContext, upcoming = false): Promise<LiveMatches> {
		const currentEventId = await getCurrentEventId(context);

		if (!currentEventId) {
			return {
				nextEvent: [],
				notStarted: [],
				playing: [],
				finished: [],
			};
		}
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
			const fixtureCountByTeam = new Map<number, number>();
			for (const fixture of currentFixtures) {
				fixtureCountByTeam.set(fixture.teamHId, (fixtureCountByTeam.get(fixture.teamHId) ?? 0) + 1);
				fixtureCountByTeam.set(fixture.teamAId, (fixtureCountByTeam.get(fixture.teamAId) ?? 0) + 1);
			}
			let teamDataMap = new Map<number, ElementEventResultData[]>();

			const statusByFixtureId = new Map<number, MatchBucketStatus>();
			const statusByPair = new Map<string, MatchBucketStatus>();
			const liveFixtureById = new Map<number, LiveFixtureRedisRow>();
			const liveFixtureByPair = new Map<string, LiveFixtureRedisRow>();
			if (redisBuckets) {
				for (const [status, fixtures] of [
					["NOT_STARTED", redisBuckets.notStarted],
					["PLAYING", redisBuckets.playing],
					["FINISHED", redisBuckets.finished],
				] as const) {
					for (const fixture of fixtures) {
						if (fixture.fixtureId !== null) {
							statusByFixtureId.set(fixture.fixtureId, status);
							liveFixtureById.set(fixture.fixtureId, fixture);
						}
						const pairKey = `${fixture.teamId}:${fixture.againstId}`;
						statusByPair.set(pairKey, status);
						liveFixtureByPair.set(pairKey, fixture);
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
					bonusByPlayerId,
					fixtureCountByTeam
				);
			}

			for (const fixture of currentFixtures) {
				const status = resolveLiveMatchStatus(fixture, statusByFixtureId, statusByPair);
				const pairKey = `${fixture.teamHId}:${fixture.teamAId}`;
				const liveFixture =
					liveFixtureById.get(fixture.id) ?? liveFixtureByPair.get(pairKey) ?? null;
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

			let nextEventMatches: LiveMatchData[] = [];
			if (upcoming && currentEventId < MAX_EVENT_ID) {
				const nextFixtures = await loadUpcomingEventFixtures(context, currentEventId);
				nextEventMatches = nextFixtures.map((fixture) =>
					buildMatch(fixture, fixture.id, "NEXT_EVENT", teamDataMap, teamsById)
				);
			}

			return {
				nextEvent: sortByKickoffTime(nextEventMatches),
				notStarted: sortByKickoffTime(notStartedMatches),
				playing: sortByKickoffTime(playingMatches),
				finished: sortByKickoffTime(finishedMatches),
			};
		});
	},
};
