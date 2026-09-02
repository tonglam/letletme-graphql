import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";

import type { Entry } from "../../contracts/entry";
import type { GraphQLContext } from "../../graphql/context";
import {
	readLeagueLivePublicationPointerV2,
	readLeagueLivePublicationV2,
	liveDeliveryFreshnessStateV2,
	liveDeliveryFreshnessWindowV2,
	type LeagueLiveIndexRowV2,
	type LeagueLiveManifestV2,
	type LeagueLivePublicationReadV2,
	type LeagueLiveScope,
} from "./league-v2";
import {
	projectLivePointsFromPublishedEntryV2,
	readLivePublicationV2,
	readLivePublicationByRefV2,
	type LiveDeliveryV2,
	type LiveCalcDataV2,
	type LivePublicationReadV2,
} from "../entry-live/v2-service";

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
	first: number;
	after: string | null;
	sort: EntryLiveCompetitionBoardSort;
	direction: EntryLiveCompetitionBoardSortDirection;
	search: string;
	chips: string[];
	captainPlayerIds: number[];
	ownership: EntryLiveCompetitionOwnershipFilter | null;
	teamCountRules: EntryLiveCompetitionTeamCountRule[];
};

export type EntryLiveCompetitionBoardRowV2 = {
	// NO_PICKS is an internal publication state. The GraphQL contract exposes
	// it as MISSING with a null score, so the schema never receives an unknown
	// enum value.
	availability: "READY" | "MISSING";
	entry: number;
	entryName: string;
	playerName: string;
	liveRank: number | null;
	overallRank: number | null;
	teamValue: number | null;
	chip: string | null;
	transferCost: number | null;
	played: number | null;
	toPlay: number | null;
	captainId: number | null;
	captainName: string | null;
	captainPoints: number | null;
	score: LiveCalcDataV2["score"] | null;
};

type IndexedRow = EntryLiveCompetitionBoardRowV2 & {
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
	publication: LeagueLiveManifestV2;
	servedFrom: LeagueLivePublicationReadV2["servedFrom"];
	boardRevision: string;
	scoreCoreRevision: string;
	rows: readonly IndexedRow[];
	totalEntries: number;
	highestEventPoints: number | null;
	averageEventPoints: number | null;
};

export type EntryLiveCompetitionBoardPageV2 = {
	rows: EntryLiveCompetitionBoardRowV2[];
	viewerRow: EntryLiveCompetitionBoardRowV2 | null;
	filteredEntries: number;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

const MAX_FIRST = 50;
const MAX_PROJECTION_ENTRIES = 5_000;
const MAX_PROJECTION_CONCURRENCY = 16;
const MAX_LKG_BYTES = 64 * 1024 * 1024;
const projectionCache = new Map<string, { value: EntryLiveCompetitionBoardV2; bytes: number }>();
const projectionInFlight = new Map<string, Promise<EntryLiveCompetitionBoardV2>>();
let projectionCacheBytes = 0;

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

const pickScope = (value: unknown): EntryLiveCompetitionPickScope => {
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

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
};

const digest = (value: unknown): string =>
	createHash("sha256").update(canonical(value), "utf8").digest("hex");

// Data stores the Classic league algorithm identity as the hash of this
// producer representation. The GraphQL guard must compare the same revision,
// not the human-readable live-points algorithm label.
const LIVE_LEAGUE_CLASSIC_ALGORITHM_REVISION = digest("live-league-v2:classic:1");

export const normalizeEntryLiveCompetitionBoardRequestV2 = (
	value: unknown
): EntryLiveCompetitionBoardRequest => {
	if (!isRecord(value)) throw badInput("Competition board input is required");
	const input = value.input;
	if (input !== undefined && input !== null && !isRecord(input))
		throw badInput("Competition board input is invalid");
	const options = isRecord(input) ? input : {};
	for (const field of ["entryId", "tournamentId", "eventId"] as const) {
		if (!positiveId(value[field])) throw badInput(`${field} must be a positive integer`);
	}
	const first = options.first === undefined || options.first === null ? 20 : options.first;
	if (!positiveId(first) || first > MAX_FIRST)
		throw badInput(`first must be between 1 and ${MAX_FIRST}`);
	const after = options.after === undefined || options.after === null ? null : options.after;
	if (after !== null && (typeof after !== "string" || after.length > 512))
		throw badInput("after is invalid");
	const search = typeof options.search === "string" ? options.search.trim() : "";
	if (search.length > 100) throw badInput("search accepts at most 100 characters");
	const sort = (options.sort ?? "EVENT_POINTS") as EntryLiveCompetitionBoardSort;
	if (!BOARD_SORTS.has(sort)) throw badInput("Invalid competition board sort");
	const direction = options.direction ?? "DESC";
	if (direction !== "ASC" && direction !== "DESC") throw badInput("Invalid sort direction");
	const rawChips = options.chips === undefined || options.chips === null ? [] : options.chips;
	if (
		!Array.isArray(rawChips) ||
		rawChips.length > CHIP_VALUES.size ||
		!rawChips.every((chip): chip is string => typeof chip === "string" && CHIP_VALUES.has(chip))
	)
		throw badInput("chips contains an invalid value");
	const captainPlayerIds = positiveIds(options.captainPlayerIds, "captainPlayerIds", 15);

	let ownership: EntryLiveCompetitionOwnershipFilter | null = null;
	if (options.ownership !== undefined && options.ownership !== null) {
		if (!isRecord(options.ownership)) throw badInput("ownership must be an object");
		const playerIds = positiveIds(options.ownership.playerIds, "ownership.playerIds", 5);
		if (playerIds.length > 0)
			ownership = {
				playerIds,
				scope: pickScope(options.ownership.scope),
				captainMode: captainMode(options.ownership.captainMode),
			};
	}

	const rawRules = options.teamCountRules ?? [];
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
		return { teamId: rule.teamId, exactCount: rule.exactCount, scope: pickScope(rule.scope) };
	});
	if (
		new Set(teamCountRules.map((rule) => `${rule.scope}:${rule.teamId}`)).size !==
		teamCountRules.length
	)
		throw badInput("teamCountRules contains duplicate team and scope rules");
	return {
		entryId: Number(value.entryId),
		tournamentId: Number(value.tournamentId),
		eventId: Number(value.eventId),
		first: Number(first),
		after: after as string | null,
		sort,
		direction,
		search,
		chips: [...new Set(rawChips)],
		captainPlayerIds,
		ownership,
		teamCountRules,
	};
};

const count = (values: readonly number[]): Array<[number, number]> => {
	const result = new Map<number, number>();
	for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
	return [...result.entries()].sort((left, right) => left[0] - right[0]);
};

const rowFor = (
	value: LiveCalcDataV2,
	liveRank: number,
	overallRank: number | null = null
): IndexedRow => {
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
		availability: "READY",
		entry: value.entry,
		entryName: value.entryName,
		playerName: value.playerName,
		liveRank,
		overallRank,
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
		captains: value.pickList.filter((pick) => pick.isCaptain).map((pick) => pick.element),
		viceCaptains: value.pickList.filter((pick) => pick.isViceCaptain).map((pick) => pick.element),
		teamAny: count(teamAny),
		teamStarter: count(teamStarter),
		teamBench: count(teamBench),
	};
};

const deliverySeverity = (servedFrom: LiveCalcDataV2["delivery"]["servedFrom"]): number => {
	switch (servedFrom) {
		case "REDIS_CURRENT":
			return 0;
		case "REDIS_PREVIOUS":
			return 1;
		case "PROCESS_LKG":
			return 2;
		case "POSTGRES_CHECKPOINT":
			return 3;
		case "FINAL_RESULT":
			return 0;
		case "UNAVAILABLE":
			return 4;
	}
};

type DeliverySource = LiveDeliveryV2["servedFrom"];

const worstServedFrom = (
	left: LeagueLivePublicationReadV2["servedFrom"],
	right: LivePublicationReadV2["servedFrom"]
): LeagueLivePublicationReadV2["servedFrom"] =>
	deliverySeverity(left) >= deliverySeverity(right) ? left : right;

const deliveryStateForSource = (
	servedFrom: DeliverySource,
	previousState: LiveDeliveryV2["state"],
	times: Pick<LiveCalcDataV2["score"]["times"], "sourceCheckedAt" | "staleAt" | "nextRefreshAt">
): LiveDeliveryV2["state"] => {
	if (previousState === "FINAL" || servedFrom === "FINAL_RESULT") return "FINAL";
	if (servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	return liveDeliveryFreshnessStateV2(times);
};

const reasonCodesForSource = (
	reasonCodes: readonly string[],
	servedFrom: DeliverySource
): string[] => {
	const retained = reasonCodes.filter((reason) => reason !== "LEAGUE_PUBLICATION_FALLBACK");
	return servedFrom === "REDIS_CURRENT" || servedFrom === "FINAL_RESULT"
		? retained
		: [...new Set([...retained, "LEAGUE_PUBLICATION_FALLBACK"])];
};

const withBoardDelivery = (
	value: LiveCalcDataV2,
	servedFrom: LeagueLivePublicationReadV2["servedFrom"]
): LiveCalcDataV2 => {
	const effectiveServedFrom =
		deliverySeverity(value.delivery.servedFrom) >= deliverySeverity(servedFrom)
			? value.delivery.servedFrom
			: servedFrom;
	const state = deliveryStateForSource(
		effectiveServedFrom,
		value.delivery.state,
		value.score.times
	);
	const delivery: LiveDeliveryV2 = {
		...value.delivery,
		state,
		servedFrom: effectiveServedFrom,
		reasonCodes: reasonCodesForSource(value.delivery.reasonCodes, effectiveServedFrom),
	};
	if (
		effectiveServedFrom === value.delivery.servedFrom &&
		state === value.delivery.state &&
		delivery.reasonCodes.length === value.delivery.reasonCodes.length &&
		delivery.reasonCodes.every((reason, index) => reason === value.delivery.reasonCodes[index])
	)
		return value;
	return {
		...value,
		delivery,
		score: { ...value.score, delivery },
		snapshot: { ...value.snapshot, delivery },
	};
};

const withBoardRowDelivery = (
	row: IndexedRow,
	servedFrom: LeagueLivePublicationReadV2["servedFrom"],
	previousBoardSource: LeagueLivePublicationReadV2["servedFrom"],
	freshnessPublication?: Pick<
		LivePublicationReadV2["publication"],
		"sourceCheckedAt" | "expectedNextCheckAt"
	>
): IndexedRow => {
	if (!row.score) return row;
	const score = row.score;
	const times = freshnessPublication
		? {
				...score.times,
				sourceCheckedAt: freshnessPublication.sourceCheckedAt,
				servedAt: new Date().toISOString(),
				staleAt: liveDeliveryFreshnessWindowV2({
					sourceCheckedAt: freshnessPublication.sourceCheckedAt,
					nextRefreshAt: freshnessPublication.expectedNextCheckAt,
				}).staleAt,
				nextRefreshAt: freshnessPublication.expectedNextCheckAt,
			}
		: score.times;
	// A cached projection can be re-served from a recovered current pointer,
	// but only rows that inherited the old board source may be rebased.  A row
	// that was independently degraded must keep that worse provenance.
	const effectiveServedFrom =
		score.delivery.servedFrom === previousBoardSource
			? servedFrom
			: deliverySeverity(score.delivery.servedFrom) >= deliverySeverity(servedFrom)
				? score.delivery.servedFrom
				: servedFrom;
	const state = deliveryStateForSource(effectiveServedFrom, score.delivery.state, times);
	const delivery: LiveDeliveryV2 = {
		...score.delivery,
		state,
		servedFrom: effectiveServedFrom,
		reasonCodes: reasonCodesForSource(score.delivery.reasonCodes, effectiveServedFrom),
	};
	if (
		!freshnessPublication &&
		effectiveServedFrom === score.delivery.servedFrom &&
		state === score.delivery.state &&
		delivery.reasonCodes.length === score.delivery.reasonCodes.length &&
		delivery.reasonCodes.every((reason, index) => reason === score.delivery.reasonCodes[index])
	)
		return row;
	return { ...row, score: { ...row.score, times, delivery } };
};

const withBoardReadDelivery = (
	board: EntryLiveCompetitionBoardV2,
	servedFrom: LeagueLivePublicationReadV2["servedFrom"],
	freshnessPublication?: Pick<
		LivePublicationReadV2["publication"],
		"sourceCheckedAt" | "expectedNextCheckAt"
	>
): EntryLiveCompetitionBoardV2 => {
	const effectiveServedFrom = worstServedFrom(board.servedFrom, servedFrom);
	return {
		...board,
		servedFrom: effectiveServedFrom,
		// Rebase even when the authority source is unchanged. A projection can be
		// served from the cache after its cadence boundary, so returning the object
		// unchanged would leave every row falsely marked FRESH.
		rows: board.rows.map((row) =>
			withBoardRowDelivery(row, effectiveServedFrom, board.servedFrom, freshnessPublication)
		),
	};
};

const noPicksRow = (value: LeagueLiveIndexRowV2): IndexedRow => ({
	availability: "MISSING",
	entry: value.entryId,
	entryName: value.entryName,
	playerName: value.playerName,
	liveRank: null,
	overallRank: value.overallRank,
	teamValue: value.teamValue === null ? null : value.teamValue / 10,
	chip: null,
	transferCost: null,
	played: null,
	toPlay: null,
	captainId: null,
	captainName: null,
	captainPoints: null,
	score: null,
	searchText: `${value.entryId} ${value.entryName} ${value.playerName}`.toLocaleLowerCase(),
	ownerAny: [],
	ownerStarter: [],
	ownerBench: [],
	captains: [],
	viceCaptains: [],
	teamAny: [],
	teamStarter: [],
	teamBench: [],
});

const metric = (row: IndexedRow, sort: EntryLiveCompetitionBoardSort): number | null => {
	if (row.availability !== "READY" || !row.score) return null;
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
			return row.overallRank;
		case "TEAM_VALUE":
			return row.teamValue;
		case "RANK":
			return row.liveRank;
		case "ENTRY_NAME":
			return null;
	}
};

const pickValues = (row: IndexedRow, scope: EntryLiveCompetitionPickScope): readonly number[] =>
	scope === "STARTER" ? row.ownerStarter : scope === "BENCH" ? row.ownerBench : row.ownerAny;

const teamValues = (
	row: IndexedRow,
	scope: EntryLiveCompetitionPickScope
): ReadonlyArray<[number, number]> =>
	scope === "STARTER" ? row.teamStarter : scope === "BENCH" ? row.teamBench : row.teamAny;

const matches = (row: IndexedRow, request: EntryLiveCompetitionBoardRequest): boolean => {
	const query = request.search.toLocaleLowerCase();
	const numeric = /^\d+$/.test(query) ? Number(query) : null;
	const owned = new Set(pickValues(row, request.ownership?.scope ?? "ANY"));
	const role =
		request.ownership?.captainMode === "CAPTAIN"
			? row.captains
			: request.ownership?.captainMode === "VICE"
				? row.viceCaptains
				: null;
	return (
		(query.length === 0 ||
			(numeric === null ? row.searchText.includes(query) : row.entry === numeric)) &&
		(request.chips.length === 0 || (row.chip !== null && request.chips.includes(row.chip))) &&
		(request.captainPlayerIds.length === 0 ||
			(row.captainId !== null && request.captainPlayerIds.includes(row.captainId))) &&
		(!request.ownership ||
			(request.ownership.playerIds.every((id) => owned.has(id)) &&
				(!role || request.ownership.playerIds.some((id) => role.includes(id))))) &&
		request.teamCountRules.every(
			(rule) =>
				row.availability === "READY" &&
				(teamValues(row, rule.scope).find(([teamId]) => teamId === rule.teamId)?.[1] ?? 0) ===
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
}: IndexedRow): EntryLiveCompetitionBoardRowV2 => row;

type Cursor = {
	v: 2;
	publicationId: string;
	generation: number;
	sortRevision: string;
	filterHash: string;
	offset: number;
	lastEntryId: number;
};

const encodeCursor = (value: Cursor): string =>
	Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeCursor = (value: string): Cursor | null => {
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		if (
			parsed.v !== 2 ||
			typeof parsed.publicationId !== "string" ||
			typeof parsed.generation !== "number" ||
			!Number.isSafeInteger(parsed.generation) ||
			typeof parsed.sortRevision !== "string" ||
			typeof parsed.filterHash !== "string" ||
			typeof parsed.offset !== "number" ||
			!Number.isSafeInteger(parsed.offset) ||
			parsed.offset < 0 ||
			!positiveId(parsed.lastEntryId)
		)
			return null;
		return parsed as unknown as Cursor;
	} catch {
		return null;
	}
};

const filterHash = (request: EntryLiveCompetitionBoardRequest): string =>
	digest({
		sort: request.sort,
		direction: request.direction,
		search: request.search,
		chips: request.chips,
		captainPlayerIds: request.captainPlayerIds,
		ownership: request.ownership,
		teamCountRules: request.teamCountRules,
	});

const sortRows = (
	rows: readonly IndexedRow[],
	request: EntryLiveCompetitionBoardRequest
): IndexedRow[] => {
	const direction = request.direction === "ASC" ? 1 : -1;
	return [...rows].sort((left, right) => {
		if (left.availability !== right.availability) return left.availability === "READY" ? -1 : 1;
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
};

export const queryEntryLiveCompetitionBoardV2 = (
	board: EntryLiveCompetitionBoardV2,
	request: EntryLiveCompetitionBoardRequest
): EntryLiveCompetitionBoardPageV2 => {
	const filtered = sortRows(
		board.rows.filter((row) => matches(row, request)),
		request
	);
	const sortRevision = digest({
		content: board.boardRevision,
		sort: request.sort,
		direction: request.direction,
	});
	let start = 0;
	if (request.after !== null) {
		const cursor = decodeCursor(request.after);
		if (
			!cursor ||
			cursor.publicationId !== board.publication.publicationId ||
			cursor.generation !== board.publication.generation ||
			cursor.sortRevision !== sortRevision ||
			cursor.filterHash !== filterHash(request) ||
			cursor.offset < 0 ||
			cursor.offset > filtered.length ||
			(cursor.offset > 0 && filtered[cursor.offset - 1]?.entry !== cursor.lastEntryId)
		)
			throw new GraphQLError("The live competition board cursor is no longer valid", {
				extensions: { code: "LIVE_BOARD_REVISION_GONE" },
			});
		start = cursor.offset;
	}
	const pageRows = filtered.slice(start, start + request.first);
	const end = start + pageRows.length;
	const endCursor =
		pageRows.length === 0
			? null
			: encodeCursor({
					v: 2,
					publicationId: board.publication.publicationId,
					generation: board.publication.generation,
					sortRevision,
					filterHash: filterHash(request),
					offset: end,
					lastEntryId: pageRows[pageRows.length - 1]!.entry,
				});
	return {
		rows: pageRows.map(publicRow),
		viewerRow: filtered.find((row) => row.entry === request.entryId)
			? publicRow(filtered.find((row) => row.entry === request.entryId)!)
			: null,
		filteredEntries: filtered.length,
		pageInfo: { hasNextPage: end < filtered.length, endCursor },
	};
};

const entryFromIndex = (row: LeagueLiveIndexRowV2): Entry => ({
	id: row.entryId,
	entryName: row.entryName,
	playerName: row.playerName,
	region: row.region,
	startedEvent: row.startedEvent,
	overallPoints: row.overallPoints,
	overallRank: row.overallRank,
	bank: row.bank,
	teamValue: row.teamValue,
	totalTransfers: row.totalTransfers,
	lastEventId: row.lastEventId,
	lastOverallPoints: row.lastOverallPoints,
	lastOverallRank: row.lastOverallRank,
	lastTeamValue: row.lastTeamValue,
	lastBank: row.lastBank,
});

const cacheKey = (
	scope: LeagueLiveScope,
	publication: Pick<LeagueLiveManifestV2, "publicationId" | "generation">
): string =>
	`${scope.season}:${scope.eventId}:${scope.tournamentId}:${publication.publicationId}:${publication.generation}`;

const rememberProjection = (key: string, value: EntryLiveCompetitionBoardV2): void => {
	const bytes = Buffer.byteLength(canonical(value), "utf8");
	const existing = projectionCache.get(key);
	if (existing) projectionCacheBytes -= existing.bytes;
	projectionCache.delete(key);
	if (bytes > MAX_LKG_BYTES) return;
	projectionCache.set(key, { value, bytes });
	projectionCacheBytes += bytes;
	while (projectionCacheBytes > MAX_LKG_BYTES && projectionCache.size > 0) {
		const oldest = projectionCache.keys().next().value as string | undefined;
		if (!oldest) break;
		const removed = projectionCache.get(oldest);
		projectionCache.delete(oldest);
		if (removed) projectionCacheBytes -= removed.bytes;
	}
};

const projectCompleteBoard = async (
	context: GraphQLContext,
	read: LeagueLivePublicationReadV2,
	global: LivePublicationReadV2
): Promise<EntryLiveCompetitionBoardV2> => {
	const servedFrom = worstServedFrom(read.servedFrom, global.servedFrom);
	if (
		read.publication.globalRef.publicationId !== global.publication.publicationId ||
		read.publication.globalRef.generation !== global.publication.generation ||
		read.publication.revisions.scoreCore !== global.publication.revisions.scoreCore.revision ||
		read.publication.revisions.fixtureIdentity !==
			global.publication.revisions.fixtureIdentity.revision ||
		read.publication.revisions.rules !== global.publication.revisions.rules.revision ||
		read.publication.revisions.algorithm !== LIVE_LEAGUE_CLASSIC_ALGORITHM_REVISION
	)
		throw new Error("LEAGUE_GLOBAL_REVISION_MISMATCH");
	if (read.index.length > MAX_PROJECTION_ENTRIES) throw new Error("LEAGUE_PUBLICATION_TOO_LARGE");
	const projected = Array<IndexedRow>(read.index.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= read.index.length) return;
			const indexRow = read.index[index]!;
			if (indexRow.availability === "NO_PICKS") {
				projected[index] = noPicksRow(indexRow);
				continue;
			}
			const input = read.payload[String(indexRow.entryId)];
			if (
				indexRow.inputPublicationId === null ||
				indexRow.inputGeneration === null ||
				indexRow.inputContentUpdatedAt === null
			)
				throw new Error(`LEAGUE_ENTRY_INPUT_REF_MISSING:${indexRow.entryId}`);
			const value = await projectLivePointsFromPublishedEntryV2(
				context,
				global,
				input,
				{
					publicationId: indexRow.inputPublicationId,
					generation: indexRow.inputGeneration,
					sourceCheckedAt: indexRow.inputContentUpdatedAt,
					servedFrom,
				},
				entryFromIndex(indexRow)
			);
			projected[index] = rowFor(withBoardDelivery(value, servedFrom), 0, indexRow.overallRank);
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(MAX_PROJECTION_CONCURRENCY, Math.max(1, read.index.length)) },
			() => worker()
		)
	);
	const ready = projected.filter(
		(row): row is IndexedRow & { score: NonNullable<IndexedRow["score"]> } =>
			row.availability === "READY" && row.score !== null
	);
	const ranked = [...ready].sort(
		(left, right) => right.score.eventPoints - left.score.eventPoints || left.entry - right.entry
	);
	let previous: number | null = null;
	let rank = 0;
	for (const [index, row] of ranked.entries()) {
		if (previous === null || row.score.eventPoints !== previous) rank = index + 1;
		row.liveRank = rank;
		previous = row.score.eventPoints;
	}
	const readyScores = ready.map((row) => row.score.eventPoints);
	return {
		publication: read.publication,
		servedFrom,
		boardRevision: read.publication.revisions.content,
		scoreCoreRevision: read.publication.revisions.scoreCore,
		rows: projected,
		totalEntries: projected.length,
		highestEventPoints: readyScores.length ? Math.max(...readyScores) : null,
		averageEventPoints: readyScores.length
			? readyScores.reduce((total, value) => total + value, 0) / readyScores.length
			: null,
	};
};

export const readEntryLiveCompetitionBoardV2 = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	global: LivePublicationReadV2
): Promise<EntryLiveCompetitionBoardV2 | null> => {
	const read = await readLeagueLivePublicationV2(context, scope, {
		publicationId: global.publication.publicationId,
		generation: global.publication.generation,
	});
	if (!read) return null;
	return projectBoardRead(context, scope, read, global);
};

const samePublicationRef = (
	left: { publicationId: string; generation: number },
	right: { publicationId: string; generation: number }
): boolean => left.publicationId === right.publicationId && left.generation === right.generation;

const projectBoardRead = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	read: LeagueLivePublicationReadV2,
	global: LivePublicationReadV2
): Promise<EntryLiveCompetitionBoardV2> => {
	if (!samePublicationRef(read.publication.globalRef, global.publication))
		throw new Error("LEAGUE_GLOBAL_REVISION_MISMATCH");
	const key = cacheKey(scope, read.publication);
	const cached = projectionCache.get(key);
	if (cached) {
		projectionCache.delete(key);
		projectionCache.set(key, cached);
		return withBoardReadDelivery(
			cached.value,
			worstServedFrom(read.servedFrom, global.servedFrom),
			global.publication
		);
	}
	const existing = projectionInFlight.get(key);
	if (existing)
		return existing.then((value) =>
			withBoardReadDelivery(
				value,
				worstServedFrom(read.servedFrom, global.servedFrom),
				global.publication
			)
		);
	const load = projectCompleteBoard(context, read, global)
		.then((value) => {
			rememberProjection(key, value);
			return value;
		})
		.finally(() => projectionInFlight.delete(key));
	projectionInFlight.set(key, load);
	return load;
};

/**
 * Return a previously completed projection without requiring the global
 * publication to be readable right now. This is the process LKG boundary for
 * a warm board: the cached projection is still pinned to its own event and
 * global reference, and is never combined with a newer global snapshot.
 */
export const readEntryLiveCompetitionBoardProcessLkgV2 = (
	scope: LeagueLiveScope,
	publication?: Pick<LeagueLiveManifestV2, "publicationId" | "generation">
): EntryLiveCompetitionBoardV2 | null => {
	const scopePrefix = `${scope.season}:${scope.eventId}:${scope.tournamentId}:`;
	const exactKey = publication ? cacheKey(scope, publication) : null;
	const keys = exactKey
		? [exactKey]
		: [...projectionCache.keys()].filter((key) => key.startsWith(scopePrefix)).reverse();
	for (const key of keys) {
		const cached = projectionCache.get(key);
		if (!cached) continue;
		projectionCache.delete(key);
		projectionCache.set(key, cached);
		return withBoardReadDelivery(cached.value, "PROCESS_LKG");
	}
	return null;
};

export const readEntryLiveCompetitionBoardWithPreviousV2 = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	global: LivePublicationReadV2
): Promise<EntryLiveCompetitionBoardV2 | null> => {
	try {
		const current = await readEntryLiveCompetitionBoardV2(context, scope, global);
		if (current) return current;
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId },
			"Current live league board projection failed; trying previous publication"
		);
	}
	// A global publication can move ahead of its league sibling for one worker
	// cycle. Read the complete board without an expected global, then follow the
	// board's exact reference. This serves the last coherent board while never
	// combining it with the newer global or with a different event.
	const candidates = [
		await readLeagueLivePublicationV2(context, scope).catch(() => null),
		await readLeagueLivePublicationPointerV2(context, scope, "previous").catch(() => null),
	].filter((candidate): candidate is LeagueLivePublicationReadV2 => candidate !== null);
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = cacheKey(scope, candidate.publication);
		if (seen.has(key)) continue;
		seen.add(key);
		try {
			const candidateGlobal = samePublicationRef(
				candidate.publication.globalRef,
				global.publication
			)
				? global
				: await readLivePublicationByRefV2(context, scope.eventId, candidate.publication.globalRef);
			if (!candidateGlobal) continue;
			return await projectBoardRead(context, scope, candidate, candidateGlobal);
		} catch (error) {
			context.logger.warn(
				{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId },
				"Retained live league board projection unavailable"
			);
		}
	}
	return readEntryLiveCompetitionBoardProcessLkgV2(scope);
};

export const readLiveLeagueGlobalForBoardV2 = (
	context: GraphQLContext,
	eventId: number
): Promise<LivePublicationReadV2 | null> =>
	readLivePublicationV2(context, eventId).catch(() => null);
