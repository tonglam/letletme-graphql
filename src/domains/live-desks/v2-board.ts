import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";

import type { GraphQLContext } from "../../graphql/context";
import {
	calcLivePointsForEntriesV2,
	readLivePublicationV2,
	type LiveCalcDataV2,
} from "../entry-live/v2-service";

export type EntryLiveCompetitionBoardSort =
	| "EVENT_POINTS"
	| "NET_EVENT_POINTS"
	| "TRANSFER_COST"
	| "PLAYED"
	| "TOTAL_POINTS"
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

export type EntryLiveCompetitionBoardRowV2 = {
	entry: number;
	entryName: string;
	playerName: string;
	rank: number;
	overallRank: number | null;
	teamValue: number;
	chip: string;
	transferCost: number;
	played: number;
	toPlay: number;
	captainId: number;
	captainName: string;
	captainPoints: number;
	score: LiveCalcDataV2["score"];
};

export type IndexedEntryLiveCompetitionBoardRowV2 = EntryLiveCompetitionBoardRowV2 & {
	searchText: string;
	ownerAny: number[];
	ownerStarter: number[];
	ownerBench: number[];
	captains: number[];
	viceCaptains: number[];
	teamAny: Array<[number, number]>;
	teamStarter: Array<[number, number]>;
	teamBench: Array<[number, number]>;
};

export type EntryLiveCompetitionBoardV2 = {
	boardRevision: string;
	scoreCoreRevision: string | null;
	rows: IndexedEntryLiveCompetitionBoardRowV2[];
	unavailableEntryIds: number[];
	failedEntryIds: number[];
	computedEntries: number;
	deferredEntryCount: number;
	failedEntryCount: number;
	unavailableEntryCount: number;
	totalEntries: number;
	highestEventPoints: number | null;
	averageEventPoints: number | null;
	partial: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const badInput = (message: string): GraphQLError =>
	new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

const positiveId = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const positiveIds = (value: unknown, field: string, maximum: number): number[] => {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > maximum || !value.every(positiveId)) {
		throw badInput(`${field} contains invalid player ids`);
	}
	return [...new Set(value.map(Number))];
};

const scope = (value: unknown): EntryLiveCompetitionPickScope => {
	if (value === undefined || value === null || value === "ANY") return "ANY";
	if (value === "STARTER" || value === "BENCH") return value;
	throw badInput("Invalid pick scope");
};

const captainMode = (value: unknown): EntryLiveCompetitionCaptainMode => {
	if (value === undefined || value === null || value === "ANY") return "ANY";
	if (value === "CAPTAIN" || value === "VICE") return value;
	throw badInput("Invalid captain mode");
};

const BOARD_SORTS = new Set<EntryLiveCompetitionBoardSort>([
	"EVENT_POINTS",
	"NET_EVENT_POINTS",
	"TRANSFER_COST",
	"PLAYED",
	"TOTAL_POINTS",
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

export const normalizeEntryLiveCompetitionBoardRequestV2 = (
	value: unknown
): EntryLiveCompetitionBoardRequest => {
	if (!isRecord(value)) throw badInput("Competition board input is required");
	for (const field of ["entryId", "tournamentId", "eventId"] as const) {
		if (!positiveId(value[field])) throw badInput(`${field} must be a positive integer`);
	}
	const page = value.page === undefined || value.page === null ? 1 : value.page;
	const pageSize = value.pageSize === undefined || value.pageSize === null ? 20 : value.pageSize;
	if (!positiveId(page)) throw badInput("page must be a positive integer");
	if (!positiveId(pageSize) || pageSize > 50) throw badInput("pageSize must be between 1 and 50");
	const search = typeof value.search === "string" ? value.search.trim() : "";
	if (search.length > 100) throw badInput("search accepts at most 100 characters");
	const sort = (value.sort ?? "EVENT_POINTS") as EntryLiveCompetitionBoardSort;
	if (!BOARD_SORTS.has(sort)) throw badInput("Invalid competition board sort");
	const direction = value.direction ?? "DESC";
	if (direction !== "ASC" && direction !== "DESC") throw badInput("Invalid sort direction");
	const rawChips = value.chips === undefined || value.chips === null ? [] : value.chips;
	if (
		!Array.isArray(rawChips) ||
		rawChips.length > CHIP_VALUES.size ||
		!rawChips.every((chip): chip is string => typeof chip === "string" && CHIP_VALUES.has(chip))
	) {
		throw badInput("chips contains an invalid value");
	}
	const captainPlayerIds = positiveIds(value.captainPlayerIds, "captainPlayerIds", 15);

	let ownership: EntryLiveCompetitionOwnershipFilter | null = null;
	if (value.ownership !== undefined && value.ownership !== null) {
		if (!isRecord(value.ownership)) throw badInput("ownership must be an object");
		const playerIds = positiveIds(value.ownership.playerIds, "ownership.playerIds", 5);
		ownership = {
			playerIds,
			scope: scope(value.ownership.scope),
			captainMode: captainMode(value.ownership.captainMode),
		};
		if (playerIds.length === 0) ownership = null;
	}

	const rawRules = value.teamCountRules ?? [];
	if (!Array.isArray(rawRules) || rawRules.length > 4)
		throw badInput("teamCountRules accepts at most 4 rules");
	const teamCountRules = rawRules.map((rule, index): EntryLiveCompetitionTeamCountRule => {
		if (!isRecord(rule) || !positiveId(rule.teamId))
			throw badInput(`teamCountRules[${index}].teamId is invalid`);
		if (
			typeof rule.exactCount !== "number" ||
			!Number.isSafeInteger(rule.exactCount) ||
			rule.exactCount < 0 ||
			rule.exactCount > 15
		)
			throw badInput(`teamCountRules[${index}].exactCount must be between 0 and 15`);
		return { teamId: rule.teamId, exactCount: rule.exactCount, scope: scope(rule.scope) };
	});
	if (
		new Set(teamCountRules.map((rule) => `${rule.scope}:${rule.teamId}`)).size !==
		teamCountRules.length
	)
		throw badInput("teamCountRules contains duplicate team and scope rules");

	const expectedBoardRevision =
		typeof value.expectedBoardRevision === "string" && value.expectedBoardRevision.length > 0
			? value.expectedBoardRevision
			: null;
	if (Number(page) > 1 && !expectedBoardRevision)
		throw badInput("expectedBoardRevision is required after the first page");
	return {
		entryId: Number(value.entryId),
		tournamentId: Number(value.tournamentId),
		eventId: Number(value.eventId),
		page: Number(page),
		pageSize: Number(pageSize),
		sort,
		direction,
		search,
		chips: [...new Set(rawChips)],
		captainPlayerIds,
		ownership,
		teamCountRules,
		expectedBoardRevision: Number(page) > 1 ? expectedBoardRevision : null,
	};
};

const count = (values: readonly number[]): Array<[number, number]> => {
	const result = new Map<number, number>();
	for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
	return [...result.entries()].sort((left, right) => left[0] - right[0]);
};

const rowFor = (value: LiveCalcDataV2, rank: number): IndexedEntryLiveCompetitionBoardRowV2 => {
	const ownerAny = value.pickList.map((pick) => pick.element);
	const ownerStarter = value.pickList
		.filter((pick) => pick.position <= 11)
		.map((pick) => pick.element);
	const ownerBench = value.pickList
		.filter((pick) => pick.position > 11)
		.map((pick) => pick.element);
	const teamAny = value.pickList.map((pick) => pick.teamId).filter(positiveId);
	const teamStarter = value.pickList
		.filter((pick) => pick.position <= 11)
		.map((pick) => pick.teamId)
		.filter(positiveId);
	const teamBench = value.pickList
		.filter((pick) => pick.position > 11)
		.map((pick) => pick.teamId)
		.filter(positiveId);
	const captain = value.activeCaptain;
	return {
		entry: value.entry,
		entryName: value.entryName,
		playerName: value.playerName,
		rank,
		overallRank: value.rank?.overallRank ?? null,
		teamValue: value.teamValue,
		chip: value.chip,
		transferCost: value.score.transferCost,
		played: value.played,
		toPlay: value.toPlay,
		captainId: captain.id,
		captainName: captain.name || value.captainName,
		captainPoints: captain.points,
		score: value.score,
		searchText: `${value.entry} ${value.entryName} ${value.playerName}`.toLocaleLowerCase(),
		ownerAny: [...new Set(ownerAny)].sort((left, right) => left - right),
		ownerStarter: [...new Set(ownerStarter)].sort((left, right) => left - right),
		ownerBench: [...new Set(ownerBench)].sort((left, right) => left - right),
		// Keep the original squad role for filtering. `captainId` is the
		// selected scorer and may be the vice after captain promotion.
		captains: value.pickList.filter((pick) => pick.isCaptain).map((pick) => pick.element),
		viceCaptains: value.pickList.filter((pick) => pick.isViceCaptain).map((pick) => pick.element),
		teamAny: count(teamAny),
		teamStarter: count(teamStarter),
		teamBench: count(teamBench),
	};
};

const metric = (
	row: IndexedEntryLiveCompetitionBoardRowV2,
	sort: EntryLiveCompetitionBoardSort
): number | null => {
	// Rank zero is the explicit unavailable/degraded marker produced for rows
	// that did not participate in the coherent score-core revision.  Do not let
	// their placeholder score (including zero) displace real negative scores.
	if (row.rank <= 0) return null;
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
		case "TEAM_VALUE":
			return row.teamValue;
		case "RANK":
			return row.rank > 0 ? row.rank : null;
		case "ENTRY_NAME":
			return null;
	}
};

const pickScope = (
	row: IndexedEntryLiveCompetitionBoardRowV2,
	value: EntryLiveCompetitionPickScope
): readonly number[] =>
	value === "STARTER" ? row.ownerStarter : value === "BENCH" ? row.ownerBench : row.ownerAny;

const teamScope = (
	row: IndexedEntryLiveCompetitionBoardRowV2,
	value: EntryLiveCompetitionPickScope
): ReadonlyArray<[number, number]> =>
	value === "STARTER" ? row.teamStarter : value === "BENCH" ? row.teamBench : row.teamAny;

const matches = (
	row: IndexedEntryLiveCompetitionBoardRowV2,
	request: EntryLiveCompetitionBoardRequest
): boolean => {
	const query = request.search.toLocaleLowerCase();
	const numeric = /^\d+$/.test(query) ? Number(query) : null;
	const owned = new Set(pickScope(row, request.ownership?.scope ?? "ANY"));
	const role =
		request.ownership?.captainMode === "CAPTAIN"
			? row.captains
			: request.ownership?.captainMode === "VICE"
				? row.viceCaptains
				: null;
	return (
		(query.length === 0 ||
			(numeric === null ? row.searchText.includes(query) : row.entry === numeric)) &&
		(request.chips.length === 0 || request.chips.includes(row.chip)) &&
		(request.captainPlayerIds.length === 0 || request.captainPlayerIds.includes(row.captainId)) &&
		(!request.ownership ||
			(request.ownership.playerIds.every((id) => owned.has(id)) &&
				(!role || request.ownership.playerIds.some((id) => role.includes(id))))) &&
		request.teamCountRules.every(
			(rule) =>
				(teamScope(row, rule.scope).find(([teamId]) => teamId === rule.teamId)?.[1] ?? 0) ===
				rule.exactCount
		)
	);
};

const publicRow = ({
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
}: IndexedEntryLiveCompetitionBoardRowV2): EntryLiveCompetitionBoardRowV2 =>
	row as EntryLiveCompetitionBoardRowV2;

export const queryEntryLiveCompetitionBoardV2 = (
	board: EntryLiveCompetitionBoardV2,
	request: EntryLiveCompetitionBoardRequest
) => {
	if (request.expectedBoardRevision && request.expectedBoardRevision !== board.boardRevision) {
		throw new GraphQLError("The live competition board changed while paging", {
			extensions: { code: "LIVE_BOARD_REVISION_GONE", boardRevision: board.boardRevision },
		});
	}
	const direction = request.direction === "ASC" ? 1 : -1;
	const filtered = board.rows.filter((row) => matches(row, request));
	filtered.sort((left, right) => {
		const leftAvailable = left.rank > 0;
		const rightAvailable = right.rank > 0;
		if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
		const primary =
			request.sort === "ENTRY_NAME"
				? left.entryName.localeCompare(right.entryName, undefined, { sensitivity: "base" }) *
					direction
				: (() => {
						const a = metric(left, request.sort);
						const b = metric(right, request.sort);
						if (a === null && b === null) return 0;
						if (a === null) return 1;
						if (b === null) return -1;
						return (a - b) * direction;
					})();
		return primary || left.entry - right.entry;
	});
	const start = (request.page - 1) * request.pageSize;
	const rows = filtered.slice(start, start + request.pageSize).map(publicRow);
	return {
		rows,
		viewerRow: filtered.find((row) => row.entry === request.entryId)
			? publicRow(filtered.find((row) => row.entry === request.entryId)!)
			: null,
		filteredEntries: filtered.length,
		hasMore: start + rows.length < filtered.length,
	};
};

const revision = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export const buildEntryLiveCompetitionBoardV2 = async (
	context: GraphQLContext,
	input: {
		eventId: number;
		tournamentId: number;
		entryIds: readonly number[];
		requireNet?: boolean;
		scoreCoreRevision?: string;
	}
): Promise<{
	board: EntryLiveCompetitionBoardV2;
	result: Awaited<ReturnType<typeof calcLivePointsForEntriesV2>>;
}> => {
	const publication = await readLivePublicationV2(
		context,
		input.eventId,
		input.scoreCoreRevision
	).catch(() => null);
	const result = await calcLivePointsForEntriesV2(context, input.eventId, input.entryIds, {
		scoreCoreRevision: input.scoreCoreRevision,
	});
	const values = [...result.results.values()];
	const observedScoreCoreRevisions = [
		...new Set(values.map((value) => value.score.revisions.scoreCore)),
	];
	const scoreCoreRevision =
		publication?.publication.revisions.scoreCore.revision ??
		(observedScoreCoreRevisions.length === 1 ? observedScoreCoreRevisions[0]! : null);
	const eligible = values.filter(
		(value) =>
			value.availability === "READY" &&
			value.score.source !== "UNAVAILABLE" &&
			scoreCoreRevision !== null &&
			value.score.revisions.scoreCore === scoreCoreRevision
	);
	const useNet = input.requireNet === true;
	const ranked = [...eligible].sort((left, right) => {
		const a = useNet ? left.score.netEventPoints : left.score.eventPoints;
		const b = useNet ? right.score.netEventPoints : right.score.eventPoints;
		return b - a || left.entry - right.entry;
	});
	const ranks = new Map<number, number>();
	let previous: number | null = null;
	let previousRank = 0;
	for (const [index, value] of ranked.entries()) {
		const score = useNet ? value.score.netEventPoints : value.score.eventPoints;
		if (previous === null || score !== previous) previousRank = index + 1;
		ranks.set(value.entry, previousRank);
		previous = score;
	}
	const rows = values.map((value) => rowFor(value, ranks.get(value.entry) ?? 0));
	const officialPoints = eligible.map((value) =>
		useNet ? value.score.netEventPoints : value.score.eventPoints
	);
	const failedEntrySet = new Set(result.errors.map((error) => error.entryId));
	const eligibleEntrySet = new Set(eligible.map((value) => value.entry));
	const unavailableEntryIds = input.entryIds.filter(
		(entryId) => !failedEntrySet.has(entryId) && !eligibleEntrySet.has(entryId)
	);
	const board = {
		boardRevision: revision({
			contract: "live-points-v2",
			season: context.currentSeason.seasonCode,
			eventId: input.eventId,
			tournamentId: input.tournamentId,
			rows: rows.map((row) => ({
				entry: row.entry,
				entryName: row.entryName,
				playerName: row.playerName,
				teamValue: row.teamValue,
				chip: row.chip,
				transferCost: row.transferCost,
				captainId: row.captainId,
				captainName: row.captainName,
				captainPoints: row.captainPoints,
				overallRank: row.overallRank,
				revision: row.score.revisions.input,
				score: row.score.eventPoints,
				net: row.score.netEventPoints,
				scoreCore: row.score.revisions.scoreCore,
				displayStats: row.score.revisions.displayStats,
				explain: row.score.revisions.explain,
				picksBase: row.score.revisions.picksBase,
				officialAdjustment: row.score.revisions.officialAdjustment,
				previousTotals: row.score.revisions.previousTotals,
				finalResult: row.score.revisions.finalResult,
				rules: row.score.revisions.rules,
				algorithm: row.score.revisions.algorithm,
				played: row.played,
				toPlay: row.toPlay,
				ownerAny: row.ownerAny,
				ownerStarter: row.ownerStarter,
				ownerBench: row.ownerBench,
				captains: row.captains,
				viceCaptains: row.viceCaptains,
				teamAny: row.teamAny,
				teamStarter: row.teamStarter,
				teamBench: row.teamBench,
			})),
		}),
		scoreCoreRevision,
		rows,
		unavailableEntryIds: [...new Set(unavailableEntryIds)].sort((a, b) => a - b),
		failedEntryIds: [...failedEntrySet].sort((a, b) => a - b),
		computedEntries: eligible.length,
		deferredEntryCount: 0,
		failedEntryCount: failedEntrySet.size,
		unavailableEntryCount: unavailableEntryIds.length,
		totalEntries: input.entryIds.length,
		highestEventPoints: officialPoints.length ? Math.max(...officialPoints) : null,
		averageEventPoints: officialPoints.length
			? officialPoints.reduce((sum, value) => sum + value, 0) / officialPoints.length
			: null,
		partial: result.errors.length > 0 || eligible.length < input.entryIds.length,
	};
	return { board, result };
};
