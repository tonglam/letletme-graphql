import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import type { LiveCalcData } from "../entry-live/calc-service";
import {
	MANAGER_SCORE_REFRESH_SECONDS,
	type LiveManagerScore,
	type ManagerScoreLoad,
} from "../entry-live/manager-score";

export const ENTRY_LIVE_COMPETITION_BOARD_PROJECTION_VERSION = "v2";
export const ENTRY_LIVE_COMPETITION_BOARD_CACHE_TTL_SECONDS = 30;

export type EntryLiveCompetitionBoardSort =
	| "EVENT_POINTS"
	| "NET_EVENT_POINTS"
	| "TRANSFER_COST"
	| "PLAYED"
	| "TOTAL_POINTS"
	| "OVERALL_RANK"
	| "TEAM_VALUE"
	| "RANK"
	| "ENTRY_NAME";

export type EntryLiveCompetitionBoardSortDirection = "ASC" | "DESC";
export type EntryLiveCompetitionPickScope = "ANY" | "STARTER" | "BENCH";
export type EntryLiveCompetitionCaptainMode = "ANY" | "CAPTAIN" | "VICE";

export type EntryLiveCompetitionOwnershipFilter = {
	playerIds: number[];
	scope: EntryLiveCompetitionPickScope;
	captainMode: EntryLiveCompetitionCaptainMode;
};

export type EntryLiveCompetitionTeamCountRule = {
	teamId: number;
	exactCount: number;
	scope: EntryLiveCompetitionPickScope;
};

export type EntryLiveCompetitionBoardRequest = {
	entryId: number;
	tournamentId: number;
	eventId: number;
	page: number;
	pageSize: number;
	sort: EntryLiveCompetitionBoardSort;
	direction: EntryLiveCompetitionBoardSortDirection;
	search: string;
	chips: string[];
	captainPlayerIds: number[];
	ownership: EntryLiveCompetitionOwnershipFilter | null;
	teamCountRules: EntryLiveCompetitionTeamCountRule[];
	expectedBoardRevision: string | null;
};

export type EntryLiveCompetitionBoardRow = {
	entry: number;
	entryName: string;
	playerName: string;
	rank: number;
	overallRank: number;
	teamValue: number;
	chip: string;
	livePoints: number;
	transferCost: number;
	liveNetPoints: number;
	liveTotalPoints: number;
	played: number;
	toPlay: number;
	captainId: number;
	captainName: string;
	captainPoints: number;
	score: LiveManagerScore;
};

type CountPair = [id: number, count: number];

export type IndexedEntryLiveCompetitionBoardRow = EntryLiveCompetitionBoardRow & {
	searchText: string;
	ownerAny: number[];
	ownerStarter: number[];
	ownerBench: number[];
	captains: number[];
	viceCaptains: number[];
	teamAny: CountPair[];
	teamStarter: CountPair[];
	teamBench: CountPair[];
};

export type CachedEntryLiveCompetitionBoard = {
	boardRevision: string;
	playerRevision: string;
	managerRevision: string | null;
	rows: IndexedEntryLiveCompetitionBoardRow[];
	officialCoverage: number;
	unavailableEntryIds: number[];
	partial: boolean;
	failedEntryIds: number[];
	totalEntries: number;
	highestEventPoints: number | null;
	averageEventPoints: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isNullableFiniteNumber = (value: unknown): value is number | null =>
	value === null || isFiniteNumber(value);

const isNullableString = (value: unknown): value is string | null =>
	value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const isPositiveIdArray = (value: unknown): value is number[] =>
	Array.isArray(value) && value.every(isPositiveSafeInteger);

const isCountPairArray = (value: unknown): value is CountPair[] =>
	Array.isArray(value) &&
	value.every(
		(pair) =>
			Array.isArray(pair) &&
			pair.length === 2 &&
			isPositiveSafeInteger(pair[0]) &&
			isNonNegativeSafeInteger(pair[1])
	);

const LIVE_MANAGER_SCORE_SOURCES = new Set([
	"FPL_EVENT_LIVE",
	"FPL_ENTRY_SUMMARY",
	"FPL_CLASSIC_STANDINGS",
	"FPL_FINAL_RESULT",
	"UNAVAILABLE",
]);
const LIVE_MANAGER_SCORE_STATES = new Set(["FRESH", "STALE", "SETTLING", "FINAL", "UNAVAILABLE"]);
const LIVE_MANAGER_SCORE_SCOPES = new Set(["OVERALL", "CLASSIC_PHASE", "UNKNOWN"]);
const LIVE_MANAGER_SCORE_SEMANTICS = new Set(["GROSS", "NET", "ZERO_COST_EQUIVALENT", "UNKNOWN"]);
const LIVE_MANAGER_SCORE_RECONCILIATIONS = new Set([
	"MATCHED",
	"SOURCE_SKEW",
	"NOT_COMPARABLE",
	"NO_LINEUP",
]);

const isCachedManagerScore = (value: unknown): value is LiveManagerScore => {
	if (!isRecord(value)) return false;
	return (
		isNullableFiniteNumber(value.eventPoints) &&
		isNullableFiniteNumber(value.netEventPoints) &&
		isNullableFiniteNumber(value.totalPoints) &&
		LIVE_MANAGER_SCORE_SCOPES.has(String(value.totalScope)) &&
		isNullableFiniteNumber(value.eventRank) &&
		isNullableFiniteNumber(value.overallRank) &&
		isNullableFiniteNumber(value.leagueRank) &&
		isFiniteNumber(value.transferCost) &&
		LIVE_MANAGER_SCORE_SOURCES.has(String(value.source)) &&
		LIVE_MANAGER_SCORE_STATES.has(String(value.state)) &&
		LIVE_MANAGER_SCORE_SEMANTICS.has(String(value.eventPointSemantics)) &&
		isNullableString(value.revision) &&
		isNullableString(value.checkedAt) &&
		isNullableString(value.upstreamUpdatedAt) &&
		isNullableString(value.staleAt) &&
		isNullableString(value.nextRefreshAt) &&
		LIVE_MANAGER_SCORE_RECONCILIATIONS.has(String(value.reconciliation)) &&
		isStringArray(value.reasonCodes)
	);
};

const isCachedBoardRow = (value: unknown): value is IndexedEntryLiveCompetitionBoardRow => {
	if (!isRecord(value)) return false;
	return (
		isPositiveSafeInteger(value.entry) &&
		typeof value.entryName === "string" &&
		typeof value.playerName === "string" &&
		isNonNegativeSafeInteger(value.rank) &&
		isNonNegativeSafeInteger(value.overallRank) &&
		isFiniteNumber(value.teamValue) &&
		typeof value.chip === "string" &&
		isFiniteNumber(value.livePoints) &&
		isFiniteNumber(value.transferCost) &&
		isFiniteNumber(value.liveNetPoints) &&
		isFiniteNumber(value.liveTotalPoints) &&
		isNonNegativeSafeInteger(value.played) &&
		isNonNegativeSafeInteger(value.toPlay) &&
		isNonNegativeSafeInteger(value.captainId) &&
		typeof value.captainName === "string" &&
		isFiniteNumber(value.captainPoints) &&
		isCachedManagerScore(value.score) &&
		typeof value.searchText === "string" &&
		isPositiveIdArray(value.ownerAny) &&
		isPositiveIdArray(value.ownerStarter) &&
		isPositiveIdArray(value.ownerBench) &&
		isPositiveIdArray(value.captains) &&
		isPositiveIdArray(value.viceCaptains) &&
		isCountPairArray(value.teamAny) &&
		isCountPairArray(value.teamStarter) &&
		isCountPairArray(value.teamBench)
	);
};

const optionalString = (value: unknown): string => (typeof value === "string" ? value : "");

const uniquePositiveIds = (value: unknown, field: string, max: number): number[] => {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) throw badInput(`${field} must be a list`);
	if (value.length > max) throw badInput(`${field} accepts at most ${max} values`);
	const ids = value.filter(isPositiveSafeInteger);
	if (ids.length !== value.length) throw badInput(`${field} contains an invalid ID`);
	return Array.from(new Set(ids));
};

const badInput = (message: string): GraphQLError =>
	new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

const normalizeScope = (value: unknown): EntryLiveCompetitionPickScope => {
	if (value === undefined || value === null) return "ANY";
	if (value === "ANY" || value === "STARTER" || value === "BENCH") return value;
	throw badInput("Invalid pick scope");
};

const normalizeCaptainMode = (value: unknown): EntryLiveCompetitionCaptainMode => {
	if (value === undefined || value === null) return "ANY";
	if (value === "ANY" || value === "CAPTAIN" || value === "VICE") return value;
	throw badInput("Invalid captain mode");
};

const BOARD_SORTS = new Set<EntryLiveCompetitionBoardSort>([
	"EVENT_POINTS",
	"NET_EVENT_POINTS",
	"TRANSFER_COST",
	"PLAYED",
	"TOTAL_POINTS",
	"OVERALL_RANK",
	"TEAM_VALUE",
	"RANK",
	"ENTRY_NAME",
]);

const CHIP_VALUES = new Set([
	"NONE",
	"TRIPLE_CAPTAIN",
	"BENCH_BOOST",
	"WILDCARD",
	"FREE_HIT",
	"MANAGER",
]);

export const entryLiveCompetitionRosterRevision = (entryIds: readonly number[]): string =>
	createHash("sha256")
		.update(
			Array.from(new Set(entryIds))
				.sort((left, right) => left - right)
				.join(",")
		)
		.digest("hex")
		.slice(0, 20);

export const entryLiveCompetitionManagerStatusRevision = (
	input: ManagerScoreLoad,
	now = Date.now()
): string =>
	createHash("sha256")
		.update(
			JSON.stringify({
				dataAvailability: input.dataAvailability,
				servedFrom: input.servedFrom,
				refreshQueued: input.refreshQueued,
				errorCode: input.errorCode,
				checkedAt: input.checkedAt,
				nextRefreshAt: input.nextRefreshAt,
				missingEntryIds: [...input.missingEntryIds].sort((left, right) => left - right),
				rows: Array.from(input.rows, ([entryId, row]) => {
					const checkedAt = Date.parse(row.checkedAt);
					return {
						entryId,
						revision: row.revision,
						checkedAt: row.checkedAt,
						upstreamUpdatedAt: row.upstreamUpdatedAt,
						staleAt: row.staleAt,
						fresh:
							Number.isFinite(checkedAt) &&
							Math.max(0, (now - checkedAt) / 1000) <= MANAGER_SCORE_REFRESH_SECONDS,
					};
				}).sort((left, right) => left.entryId - right.entryId),
			})
		)
		.digest("hex")
		.slice(0, 20);

export const normalizeEntryLiveCompetitionBoardRequest = (
	value: unknown
): EntryLiveCompetitionBoardRequest => {
	if (!isRecord(value)) throw badInput("Competition board input is required");
	for (const field of ["entryId", "tournamentId", "eventId"] as const) {
		if (!isPositiveSafeInteger(value[field])) throw badInput(`${field} must be a positive integer`);
	}
	const page = value.page === undefined || value.page === null ? 1 : value.page;
	const pageSize = value.pageSize === undefined || value.pageSize === null ? 20 : value.pageSize;
	if (!isPositiveSafeInteger(page)) throw badInput("page must be a positive integer");
	if (!isPositiveSafeInteger(pageSize) || pageSize > 50)
		throw badInput("pageSize must be between 1 and 50");
	const search = optionalString(value.search).trim();
	if (search.length > 100) throw badInput("search accepts at most 100 characters");
	const sort = (value.sort ?? "EVENT_POINTS") as EntryLiveCompetitionBoardSort;
	if (!BOARD_SORTS.has(sort)) throw badInput("Invalid competition board sort");
	const direction = value.direction ?? "DESC";
	if (direction !== "ASC" && direction !== "DESC") throw badInput("Invalid sort direction");
	const chips = value.chips === undefined || value.chips === null ? [] : value.chips;
	if (!Array.isArray(chips) || chips.length > CHIP_VALUES.size)
		throw badInput("chips contains too many values");
	if (!chips.every((chip): chip is string => typeof chip === "string" && CHIP_VALUES.has(chip)))
		throw badInput("chips contains an invalid value");
	const captainPlayerIds = uniquePositiveIds(value.captainPlayerIds, "captainPlayerIds", 15);

	let ownership: EntryLiveCompetitionOwnershipFilter | null = null;
	if (value.ownership !== undefined && value.ownership !== null) {
		if (!isRecord(value.ownership)) throw badInput("ownership must be an object");
		ownership = {
			playerIds: uniquePositiveIds(value.ownership.playerIds, "ownership.playerIds", 5),
			scope: normalizeScope(value.ownership.scope),
			captainMode: normalizeCaptainMode(value.ownership.captainMode),
		};
		if (ownership.playerIds.length === 0) ownership = null;
	}

	const rawRules = value.teamCountRules ?? [];
	if (!Array.isArray(rawRules) || rawRules.length > 4)
		throw badInput("teamCountRules accepts at most 4 rules");
	const teamCountRules = rawRules.map((rule, index): EntryLiveCompetitionTeamCountRule => {
		if (!isRecord(rule)) throw badInput(`teamCountRules[${index}] must be an object`);
		if (!isPositiveSafeInteger(rule.teamId))
			throw badInput(`teamCountRules[${index}].teamId is invalid`);
		if (
			typeof rule.exactCount !== "number" ||
			!Number.isSafeInteger(rule.exactCount) ||
			rule.exactCount < 0 ||
			rule.exactCount > 15
		)
			throw badInput(`teamCountRules[${index}].exactCount must be between 0 and 15`);
		return {
			teamId: rule.teamId,
			exactCount: rule.exactCount,
			scope: normalizeScope(rule.scope),
		};
	});
	if (
		new Set(teamCountRules.map((rule) => `${rule.scope}:${rule.teamId}`)).size !==
		teamCountRules.length
	)
		throw badInput("teamCountRules contains duplicate team and scope rules");

	const suppliedBoardRevision =
		typeof value.expectedBoardRevision === "string" && value.expectedBoardRevision.length > 0
			? value.expectedBoardRevision
			: null;
	if (page > 1 && !suppliedBoardRevision)
		throw badInput("expectedBoardRevision is required after the first page");

	return {
		entryId: Number(value.entryId),
		tournamentId: Number(value.tournamentId),
		eventId: Number(value.eventId),
		page,
		pageSize,
		sort,
		direction,
		search,
		chips: Array.from(new Set(chips)),
		captainPlayerIds,
		ownership,
		teamCountRules,
		expectedBoardRevision: page > 1 ? suppliedBoardRevision : null,
	};
};

const increment = (counts: Map<number, number>, id: number): void => {
	if (!isPositiveSafeInteger(id)) return;
	counts.set(id, (counts.get(id) ?? 0) + 1);
};

const countPairs = (counts: Map<number, number>): CountPair[] =>
	Array.from(counts.entries()).sort((left, right) => left[0] - right[0]);

const scoreHasOfficialEventMetric = (score: LiveManagerScore, requireNet: boolean): boolean => {
	const official =
		score.source === "FPL_EVENT_LIVE" ||
		score.source === "FPL_ENTRY_SUMMARY" ||
		score.source === "FPL_CLASSIC_STANDINGS" ||
		score.source === "FPL_FINAL_RESULT";
	return (
		official &&
		(requireNet
			? typeof score.netEventPoints === "number" && score.eventPointSemantics !== "UNKNOWN"
			: typeof score.eventPoints === "number")
	);
};

export const projectEntryLiveCompetitionBoardRow = (
	row: LiveCalcData,
	eventTeamIds?: ReadonlyMap<number, number>
): IndexedEntryLiveCompetitionBoardRow => {
	const ownerAny = new Set<number>();
	const ownerStarter = new Set<number>();
	const ownerBench = new Set<number>();
	const captains = new Set<number>();
	const viceCaptains = new Set<number>();
	const teamAny = new Map<number, number>();
	const teamStarter = new Map<number, number>();
	const teamBench = new Map<number, number>();
	for (const pick of row.pickList) {
		const teamId = eventTeamIds?.get(pick.element) ?? pick.teamId;
		ownerAny.add(pick.element);
		increment(teamAny, teamId);
		// Preserve the existing filter contract: starter/bench is the selected
		// lineup position, not the current scoring multiplier. Bench Boost and
		// finalized automatic substitutions must not move a pick between scopes.
		if (pick.position <= 11) {
			ownerStarter.add(pick.element);
			increment(teamStarter, teamId);
		} else {
			ownerBench.add(pick.element);
			increment(teamBench, teamId);
		}
		if (pick.isCaptain) captains.add(pick.element);
		if (pick.isViceCaptain) viceCaptains.add(pick.element);
	}
	const captainId = row.activeCaptain.id || row.playedCaptain || 0;
	const captainName = row.activeCaptain.name || row.captainName;
	captains.clear();
	if (captainId > 0) captains.add(captainId);
	return {
		entry: row.entry,
		entryName: row.entryName,
		playerName: row.playerName,
		rank: row.rank,
		overallRank: row.score.overallRank ?? row.overallRank,
		teamValue: row.teamValue,
		chip: row.chip,
		livePoints: row.livePoints,
		transferCost: row.score.transferCost ?? row.transferCost,
		liveNetPoints: row.liveNetPoints,
		liveTotalPoints: row.liveTotalPoints,
		played: row.played,
		toPlay: row.toPlay,
		captainId,
		captainName,
		captainPoints: row.activeCaptain.points,
		score: row.score,
		searchText: `${row.entry} ${row.entryName} ${row.playerName}`.toLocaleLowerCase(),
		ownerAny: Array.from(ownerAny).sort((left, right) => left - right),
		ownerStarter: Array.from(ownerStarter).sort((left, right) => left - right),
		ownerBench: Array.from(ownerBench).sort((left, right) => left - right),
		captains: Array.from(captains).sort((left, right) => left - right),
		viceCaptains: Array.from(viceCaptains).sort((left, right) => left - right),
		teamAny: countPairs(teamAny),
		teamStarter: countPairs(teamStarter),
		teamBench: countPairs(teamBench),
	};
};

export type EntryLiveCompetitionBoardRevisionInput = {
	season: string;
	eventId: number;
	tournamentId: number;
	coreRevision: string;
	playerRevision: string;
	managerRevision: string | null;
	rosterRevision: string;
	windowRevision: string;
	totalEntries: number;
	unavailableEntryIds: readonly number[];
	failedEntryIds: readonly number[];
	rows: readonly IndexedEntryLiveCompetitionBoardRow[];
};

export const entryLiveCompetitionBoardRevision = (
	input: EntryLiveCompetitionBoardRevisionInput
): string =>
	createHash("sha256")
		.update(
			JSON.stringify({
				projection: ENTRY_LIVE_COMPETITION_BOARD_PROJECTION_VERSION,
				season: input.season,
				eventId: input.eventId,
				tournamentId: input.tournamentId,
				coreRevision: input.coreRevision,
				playerRevision: input.playerRevision,
				managerRevision: input.managerRevision,
				rosterRevision: input.rosterRevision,
				windowRevision: input.windowRevision,
				totalEntries: input.totalEntries,
				unavailableEntryIds: [...input.unavailableEntryIds].sort((left, right) => left - right),
				failedEntryIds: [...input.failedEntryIds].sort((left, right) => left - right),
				// Hash every value that can change membership, order, or headline
				// content, plus all internal filter indexes. Poll timestamps and the
				// derived fresh/stale state are deliberately excluded so a no-op
				// manager check does not invalidate a user's next page.
				rows: [...input.rows]
					.sort((left, right) => left.entry - right.entry)
					.map((row) => ({
						entry: row.entry,
						entryName: row.entryName,
						playerName: row.playerName,
						rank: row.rank,
						overallRank: row.overallRank,
						teamValue: row.teamValue,
						chip: row.chip,
						livePoints: row.livePoints,
						transferCost: row.transferCost,
						liveNetPoints: row.liveNetPoints,
						liveTotalPoints: row.liveTotalPoints,
						played: row.played,
						toPlay: row.toPlay,
						captainId: row.captainId,
						captainName: row.captainName,
						captainPoints: row.captainPoints,
						score: {
							eventPoints: row.score.eventPoints,
							netEventPoints: row.score.netEventPoints,
							totalPoints: row.score.totalPoints,
							totalScope: row.score.totalScope,
							eventRank: row.score.eventRank,
							overallRank: row.score.overallRank,
							leagueRank: row.score.leagueRank,
							transferCost: row.score.transferCost,
							source: row.score.source,
							eventPointSemantics: row.score.eventPointSemantics,
							revision: row.score.revision,
						},
						ownerAny: row.ownerAny,
						ownerStarter: row.ownerStarter,
						ownerBench: row.ownerBench,
						captains: row.captains,
						viceCaptains: row.viceCaptains,
						teamAny: row.teamAny,
						teamStarter: row.teamStarter,
						teamBench: row.teamBench,
					})),
			})
		)
		.digest("hex")
		.slice(0, 24);

export const buildEntryLiveCompetitionBoard = (input: {
	season: string;
	eventId: number;
	tournamentId: number;
	coreRevision: string;
	playerRevision: string;
	managerRevision: string | null;
	rosterRevision?: string;
	windowRevision?: string;
	eventTeamIds?: ReadonlyMap<number, number>;
	rows: readonly LiveCalcData[];
	totalEntries: number;
	failedEntryIds?: readonly number[];
	unavailableEntryIds?: readonly number[];
	requireNet?: boolean;
}): CachedEntryLiveCompetitionBoard => {
	const rows = input.rows.map((row) =>
		projectEntryLiveCompetitionBoardRow(row, input.eventTeamIds)
	);
	const requireNet = input.requireNet === true;
	const officialRows = rows.filter((row) => scoreHasOfficialEventMetric(row.score, requireNet));
	const unavailableEntryIds = rows
		.filter((row) => !scoreHasOfficialEventMetric(row.score, requireNet))
		.map((row) => row.entry);
	const failedEntryIds = Array.from(new Set(input.failedEntryIds ?? [])).sort(
		(left, right) => left - right
	);
	const unavailable = Array.from(
		new Set([...unavailableEntryIds, ...(input.unavailableEntryIds ?? []), ...failedEntryIds])
	).sort((left, right) => left - right);
	const officialEventPoints = officialRows
		.map((row) => (requireNet ? row.score.netEventPoints : row.score.eventPoints))
		.filter((points): points is number => typeof points === "number");
	const rowEntryIds = rows.map((row) => row.entry);
	const boardRevision = entryLiveCompetitionBoardRevision({
		...input,
		rosterRevision: input.rosterRevision ?? entryLiveCompetitionRosterRevision(rowEntryIds),
		windowRevision: input.windowRevision ?? entryLiveCompetitionRosterRevision(rowEntryIds),
		unavailableEntryIds: unavailable,
		failedEntryIds,
		rows,
	});
	return {
		boardRevision,
		playerRevision: input.playerRevision,
		managerRevision: input.managerRevision,
		rows,
		officialCoverage: input.totalEntries === 0 ? 0 : officialRows.length / input.totalEntries,
		unavailableEntryIds: unavailable,
		partial:
			failedEntryIds.length > 0 || unavailable.length > 0 || rows.length < input.totalEntries,
		failedEntryIds,
		totalEntries: input.totalEntries,
		highestEventPoints: officialEventPoints.length > 0 ? Math.max(...officialEventPoints) : null,
		averageEventPoints:
			officialEventPoints.length > 0
				? officialEventPoints.reduce((sum, points) => sum + points, 0) / officialEventPoints.length
				: null,
	};
};

/**
 * A future event has no picks or live manager scores yet. Keep that normal
 * pre-deadline state empty and non-partial instead of manufacturing one
 * unavailable row per roster entry through the batch calculator.
 */
export const buildScheduledEntryLiveCompetitionBoard = (input: {
	season: string;
	eventId: number;
	tournamentId: number;
	coreRevision: string;
	playerRevision: string;
	rosterRevision: string;
	windowRevision: string;
	totalEntries: number;
}): CachedEntryLiveCompetitionBoard => ({
	...buildEntryLiveCompetitionBoard({
		...input,
		managerRevision: null,
		rows: [],
		failedEntryIds: [],
		unavailableEntryIds: [],
	}),
	partial: false,
});

const idsForScope = (
	row: IndexedEntryLiveCompetitionBoardRow,
	scope: EntryLiveCompetitionPickScope
): readonly number[] =>
	scope === "STARTER" ? row.ownerStarter : scope === "BENCH" ? row.ownerBench : row.ownerAny;

const teamsForScope = (
	row: IndexedEntryLiveCompetitionBoardRow,
	scope: EntryLiveCompetitionPickScope
): readonly CountPair[] =>
	scope === "STARTER" ? row.teamStarter : scope === "BENCH" ? row.teamBench : row.teamAny;

const rowMatchesOwnership = (
	row: IndexedEntryLiveCompetitionBoardRow,
	filter: EntryLiveCompetitionOwnershipFilter
): boolean => {
	const owners = new Set(idsForScope(row, filter.scope));
	const roleIds =
		filter.captainMode === "CAPTAIN"
			? new Set(row.captains)
			: filter.captainMode === "VICE"
				? new Set(row.viceCaptains)
				: null;
	return (
		filter.playerIds.every((playerId) => owners.has(playerId)) &&
		(!roleIds || filter.playerIds.some((playerId) => roleIds.has(playerId)))
	);
};

const rowMatchesTeamRule = (
	row: IndexedEntryLiveCompetitionBoardRow,
	rule: EntryLiveCompetitionTeamCountRule
): boolean =>
	(teamsForScope(row, rule.scope).find(([teamId]) => teamId === rule.teamId)?.[1] ?? 0) ===
	rule.exactCount;

const numericSortValue = (
	row: IndexedEntryLiveCompetitionBoardRow,
	sort: Exclude<EntryLiveCompetitionBoardSort, "ENTRY_NAME">
): number | null => {
	switch (sort) {
		case "EVENT_POINTS":
			return row.score.eventPoints;
		case "NET_EVENT_POINTS":
			return row.score.netEventPoints;
		case "TRANSFER_COST":
			return row.transferCost;
		case "PLAYED":
			return row.played;
		case "TOTAL_POINTS":
			return row.score.totalPoints;
		case "OVERALL_RANK":
			return row.score.overallRank ?? (row.overallRank > 0 ? row.overallRank : null);
		case "TEAM_VALUE":
			return row.teamValue;
		case "RANK":
			return row.rank > 0 ? row.rank : null;
	}
};

const compareNullableNumbers = (
	left: number | null,
	right: number | null,
	direction: number
): number => {
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	return (left - right) * direction;
};

export const toPublicEntryLiveCompetitionBoardRow = ({
	searchText: _searchText,
	ownerAny: _ownerAny,
	ownerStarter: _ownerStarter,
	ownerBench: _ownerBench,
	captains: _captains,
	viceCaptains: _viceCaptains,
	teamAny: _teamAny,
	teamStarter: _teamStarter,
	teamBench: _teamBench,
	...row
}: IndexedEntryLiveCompetitionBoardRow): EntryLiveCompetitionBoardRow => row;

export const queryEntryLiveCompetitionBoard = (
	board: CachedEntryLiveCompetitionBoard,
	request: EntryLiveCompetitionBoardRequest
): {
	rows: EntryLiveCompetitionBoardRow[];
	viewerRow: EntryLiveCompetitionBoardRow | null;
	filteredEntries: number;
	hasMore: boolean;
} => {
	if (request.expectedBoardRevision && request.expectedBoardRevision !== board.boardRevision) {
		throw new GraphQLError("The live competition board changed while paging", {
			extensions: { code: "LIVE_BOARD_REVISION_GONE", boardRevision: board.boardRevision },
		});
	}
	const search = request.search.toLocaleLowerCase();
	const numericEntrySearch = /^\d+$/.test(search) ? Number(search) : null;
	const chips = new Set(request.chips);
	const captainIds = new Set(request.captainPlayerIds);
	const direction = request.direction === "ASC" ? 1 : -1;
	const filtered = board.rows.filter(
		(row) =>
			(search.length === 0 ||
				(numericEntrySearch === null
					? row.searchText.includes(search)
					: Number.isSafeInteger(numericEntrySearch) && row.entry === numericEntrySearch)) &&
			(chips.size === 0 || chips.has(row.chip)) &&
			(captainIds.size === 0 || captainIds.has(row.captainId)) &&
			(!request.ownership || rowMatchesOwnership(row, request.ownership)) &&
			request.teamCountRules.every((rule) => rowMatchesTeamRule(row, rule))
	);
	filtered.sort((left, right) => {
		const primary =
			request.sort === "ENTRY_NAME"
				? left.entryName.localeCompare(right.entryName, undefined, { sensitivity: "base" }) *
					direction
				: compareNullableNumbers(
						numericSortValue(left, request.sort),
						numericSortValue(right, request.sort),
						direction
					);
		return primary || left.entry - right.entry;
	});
	const start = (request.page - 1) * request.pageSize;
	const pageRows = filtered.slice(start, start + request.pageSize);
	const viewerRow = filtered.find((row) => row.entry === request.entryId) ?? null;
	return {
		rows: pageRows.map(toPublicEntryLiveCompetitionBoardRow),
		viewerRow: viewerRow ? toPublicEntryLiveCompetitionBoardRow(viewerRow) : null,
		filteredEntries: filtered.length,
		hasMore: start + pageRows.length < filtered.length,
	};
};

export const entryLiveCompetitionBoardCacheKey = (
	context: GraphQLContext,
	input: {
		season: string;
		eventId: number;
		tournamentId: number;
		coreRevision: string;
		playerRevision: string;
		managerRevision: string | null;
		managerStatusRevision: string;
		rosterRevision: string;
		windowRevision: string;
		projectionMode?: "BOUNDED" | "FULL_FIELD";
		requireTeamValue?: boolean;
	}
): string => {
	const identity = createHash("sha256")
		.update(
			JSON.stringify({
				...input,
				projectionMode: input.projectionMode ?? "BOUNDED",
				requireTeamValue: input.requireTeamValue ?? false,
				projection: ENTRY_LIVE_COMPETITION_BOARD_PROJECTION_VERSION,
			})
		)
		.digest("hex")
		.slice(0, 32);
	return gqlCacheKey(
		context,
		`entry-live-competition-board:${input.eventId}:${input.tournamentId}:${identity}`
	);
};

const isCachedBoard = (value: unknown): value is CachedEntryLiveCompetitionBoard => {
	if (!isRecord(value)) return false;
	return (
		typeof value.boardRevision === "string" &&
		typeof value.playerRevision === "string" &&
		(value.managerRevision === null || typeof value.managerRevision === "string") &&
		Array.isArray(value.rows) &&
		value.rows.every(isCachedBoardRow) &&
		isFiniteNumber(value.officialCoverage) &&
		value.officialCoverage >= 0 &&
		value.officialCoverage <= 1 &&
		isPositiveIdArray(value.unavailableEntryIds) &&
		typeof value.partial === "boolean" &&
		isPositiveIdArray(value.failedEntryIds) &&
		isNonNegativeSafeInteger(value.totalEntries) &&
		isNullableFiniteNumber(value.highestEventPoints) &&
		isNullableFiniteNumber(value.averageEventPoints)
	);
};

export const readEntryLiveCompetitionBoard = async (
	context: GraphQLContext,
	key: string
): Promise<CachedEntryLiveCompetitionBoard | null> => {
	try {
		const raw = await context.redis.get(key);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		return isCachedBoard(parsed) ? parsed : null;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read lightweight competition board cache");
		return null;
	}
};

export const writeEntryLiveCompetitionBoard = async (
	context: GraphQLContext,
	key: string,
	board: CachedEntryLiveCompetitionBoard
): Promise<void> => {
	try {
		await context.redis.set(
			key,
			JSON.stringify(board),
			"EX",
			ENTRY_LIVE_COMPETITION_BOARD_CACHE_TTL_SECONDS
		);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to write lightweight competition board cache");
	}
};

const boardBuilds = new Map<string, Promise<CachedEntryLiveCompetitionBoard>>();

export const getOrBuildEntryLiveCompetitionBoard = async (
	context: GraphQLContext,
	key: string,
	build: () => Promise<CachedEntryLiveCompetitionBoard>
): Promise<CachedEntryLiveCompetitionBoard> => {
	const cached = await readEntryLiveCompetitionBoard(context, key);
	if (cached) return cached;
	const existing = boardBuilds.get(key);
	if (existing) return existing;
	const pending = build()
		.then(async (board) => {
			await writeEntryLiveCompetitionBoard(context, key, board);
			return board;
		})
		.finally(() => boardBuilds.delete(key));
	boardBuilds.set(key, pending);
	return pending;
};
