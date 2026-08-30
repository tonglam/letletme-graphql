import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { QueryResultRow } from "pg";

import { normalizeFplChip, type CanonicalFplChip } from "../../contracts/fpl-chip";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import type { Entry } from "../../contracts/entry";
import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreLiveIdentitySnapshot,
	type CoreLiveIdentitySnapshot,
	type CorePlayerData,
	type CoreTeamData,
} from "../../infra/data-snapshot";
import { metrics } from "../../infra/metrics";
import { entriesRepository } from "../entries/repository";

/**
 * GraphQL's Live Points owner.  This module deliberately has no Data HTTP
 * client, no FPL client and no queue dependency.  A request is a projection
 * of a complete publication; recovery belongs to the producer/reconciler.
 */
export const LIVE_POINTS_CONTRACT_VERSION = "live-points-v2" as const;
export const LIVE_POINTS_ALGORITHM_VERSION = "live-points-v2-algorithm-1" as const;
export const LIVE_POINTS_FRESHNESS_SECONDS = 30;
const UNAVAILABLE_REVISION = "unavailable";

type LivePublicationState =
	| "PRE_DEADLINE"
	| "PICKS_WAIT"
	| "PICKS_PROBE"
	| "PICKS_SYNC"
	| "LIVE_ACTIVE"
	| "BETWEEN_FIXTURES"
	| "DAY_SETTLING"
	| "GW_REVIEW"
	| "FINALIZED";

type ServedFrom =
	| "REDIS_CURRENT"
	| "REDIS_PREVIOUS"
	| "PROCESS_LKG"
	| "POSTGRES_CHECKPOINT"
	| "FINAL_RESULT"
	| "UNAVAILABLE";

type DeliveryState = "FRESH" | "STALE" | "DEGRADED" | "FINAL" | "UNAVAILABLE";

type PublicationItem = {
	name: "eventLive" | "fixtures" | "input";
	key: string;
	type: "string";
	count: number;
	bytes: number;
	sha256: string;
};

type StreamRevision = {
	revision: string;
	contentUpdatedAt: string;
};

type LivePublication = {
	contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
	publicationId: string;
	generation: number;
	season: string;
	eventId: number;
	state: LivePublicationState;
	sourceCheckedAt: string;
	publishedAt: string;
	checkpointedAt: string | null;
	expectedNextCheckAt: string | null;
	revisions: {
		lifecycle: StreamRevision;
		fixtureIdentity: StreamRevision;
		scoreCore: StreamRevision;
		displayStats: StreamRevision;
		explain: StreamRevision;
		rules: StreamRevision;
	};
	items: {
		eventLive: PublicationItem;
		fixtures: PublicationItem;
	};
};

type EventLiveRow = {
	eventId: number;
	elementId: number;
	minutes: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	goalsConceded: number | null;
	ownGoals: number | null;
	penaltiesSaved: number | null;
	penaltiesMissed: number | null;
	yellowCards: number | null;
	redCards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	defensiveContribution: number | null;
	starts: boolean | null;
	expectedGoals: string | null;
	expectedAssists: string | null;
	expectedGoalInvolvements: string | null;
	expectedGoalsConceded: string | null;
	inDreamTeam: boolean | null;
	totalPoints: number;
	fixtureBreakdown?: readonly unknown[];
};

type FixtureRow = {
	id: number;
	code: number;
	event: number | null;
	finished: boolean;
	finishedProvisional: boolean;
	kickoffTime: string | null;
	minutes: number;
	started: boolean | null;
	teamH: number;
	teamA: number;
	teamHScore: number | null;
	teamAScore: number | null;
	teamHDifficulty: number | null;
	teamADifficulty: number | null;
};

type Pick = {
	element: number;
	position: number;
	multiplier: number;
	isCaptain: boolean;
	isViceCaptain: boolean;
};

type Exactly15Picks = [
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
	Pick,
];

type EntryLiveInput = {
	contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
	season: string;
	eventId: number;
	entryId: number;
	picksBase: {
		revision: string;
		contentUpdatedAt: string;
		picks: Exactly15Picks;
		chip: string | null;
		transferCost: number;
	};
	previousTotals: {
		revision: string;
		throughEventId: number;
		totalPoints: number;
		overallRank: number | null;
	} | null;
	officialAdjustment: {
		revision: string;
		multipliers: readonly { element: number; multiplier: number }[];
		automaticSubs: readonly { inElement: number; outElement: number }[];
	} | null;
	finalResult: {
		revision: string;
		score: { eventPoints: number; totalPoints: number | null };
		picks: Exactly15Picks;
		automaticSubs: readonly { inElement: number; outElement: number }[];
	} | null;
};

type EntryPublication = {
	contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
	publicationId: string;
	generation: number;
	season: string;
	eventId: number;
	entryId: number;
	state: "PROVISIONAL" | "FINAL";
	sourceCheckedAt: string;
	publishedAt: string;
	checkpointedAt: string | null;
	expectedNextCheckAt: string | null;
	item: PublicationItem;
};

type GlobalRead = {
	publication: LivePublication;
	eventLives: EventLiveRow[];
	fixtures: FixtureRow[];
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "POSTGRES_CHECKPOINT";
};

export type LivePublicationReadV2 = GlobalRead;

type EntryRead = {
	publication: EntryPublication;
	input: EntryLiveInput;
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "POSTGRES_CHECKPOINT";
};

export type LiveRevisionVectorV2 = {
	publicationId: string;
	generation: number;
	lifecycle: string;
	fixtureIdentity: string;
	scoreCore: string;
	displayStats: string;
	explain: string;
	picksBase: string | null;
	officialAdjustment: string | null;
	previousTotals: string | null;
	finalResult: string | null;
	rules: string;
	algorithm: string;
	input: string;
};

export type LiveTimesV2 = {
	sourceCheckedAt: string;
	contentUpdatedAt: string;
	publishedAt: string;
	checkpointedAt: string | null;
	servedAt: string;
	staleAt: string;
	nextRefreshAt: string | null;
};

export type LiveDeliveryV2 = {
	state: DeliveryState;
	servedFrom: ServedFrom;
	reasonCodes: string[];
};

export type LiveScoreV2 = {
	eventPoints: number;
	netEventPoints: number;
	totalPoints: number | null;
	totalScope: "OVERALL" | "UNKNOWN";
	transferCost: number;
	source: "FPL_EVENT_LIVE" | "FPL_FINAL_RESULT" | "UNAVAILABLE";
	calculationMode: "PROJECTED_AUTOSUBS" | "FINAL_RESULT";
	revisions: LiveRevisionVectorV2;
	times: LiveTimesV2;
	delivery: LiveDeliveryV2;
};

export type LiveRankV2 = {
	eventRank: number | null;
	overallRank: number | null;
	leagueRank: number | null;
	revision: string | null;
	contentUpdatedAt: string | null;
	state: DeliveryState;
};

export type LiveSnapshotMetaV2 = {
	season: string;
	eventId: number;
	state: LivePublicationState | "UNAVAILABLE";
	revisions: LiveRevisionVectorV2;
	times: LiveTimesV2;
	delivery: LiveDeliveryV2;
};

export type ElementEventResultDataV2 = {
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

export type LiveCalcDataV2 = {
	availability: "READY" | "PENDING" | "NO_PICKS" | "UNAVAILABLE";
	delivery: LiveDeliveryV2;
	snapshot: LiveSnapshotMetaV2;
	score: LiveScoreV2;
	rank: LiveRankV2 | null;
	provisional: boolean;
	event: number;
	entry: number;
	entryName: string;
	playerName: string;
	region: string | null;
	startedEvent: number;
	value: number;
	bank: number;
	teamValue: number;
	totalTransfers: number;
	lastValue: number;
	chip: CanonicalFplChip;
	played: number;
	toPlay: number;
	playedCaptain: number;
	captainName: string;
	pickList: ElementEventResultDataV2[];
	activeCaptain: { id: number; name: string; points: number };
};

export type BatchLiveCalcResultV2 = {
	results: Map<number, LiveCalcDataV2>;
	errors: Array<{ entryId: number; message: string }>;
	meta: {
		eventId: number;
		totalEntries: number;
		succeededCount: number;
		failedCount: number;
	};
};

type Row = QueryResultRow & Record<string, unknown>;

type LiveLkgEntry = Readonly<{ value: LiveCalcDataV2; expiresAt: number }>;

const liveLkg = new Map<string, LiveLkgEntry>();
const LIVE_LKG_MAX_ENTRIES = 256;
// This is only a bounded process-memory retention policy.  It is not the
// freshness contract: a retained complete same-event response remains usable
// while its source is stale, and PostgreSQL remains the next fallback after
// an eviction.
const LIVE_LKG_RETENTION_MS = 24 * 60 * 60 * 1000;
const requestRedisGlobalMemo = new WeakMap<object, Map<string, Promise<GlobalRead | null>>>();
const requestDatabaseGlobalMemo = new WeakMap<object, Map<string, Promise<GlobalRead | null>>>();
const requestCoreMemo = new WeakMap<object, Promise<CoreLiveIdentitySnapshot | null>>();
const requestEntryMemo = new WeakMap<object, Map<number, Promise<Entry>>>();
const entryMetadataCircuit = new Map<string, number>();
const ENTRY_METADATA_CIRCUIT_COOLDOWN_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const iso = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const integer = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
	return null;
};

// JSON numbers are part of the V2 publication contract. Do not accept a
// numeric string for fields that participate in a revision vector: otherwise
// a malformed checkpoint can pass validation while retaining a different
// runtime shape from Redis.
const safeInteger = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const jsonValue = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
};

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

const hash = (value: unknown): string =>
	createHash("sha256").update(stable(value), "utf8").digest("hex");

const validItem = (
	value: unknown,
	expectedKey: string,
	expectedName: PublicationItem["name"]
): value is PublicationItem =>
	isRecord(value) &&
	value.name === expectedName &&
	value.key === expectedKey &&
	value.type === "string" &&
	integer(value.count) !== null &&
	(integer(value.count) as number) >= 0 &&
	integer(value.bytes) !== null &&
	(integer(value.bytes) as number) >= 0 &&
	typeof value.sha256 === "string" &&
	/^[0-9a-f]{64}$/.test(value.sha256);

const validRevision = (value: unknown): value is StreamRevision =>
	isRecord(value) &&
	typeof value.revision === "string" &&
	/^[0-9a-f]{64}$/.test(value.revision) &&
	iso(value.contentUpdatedAt);

const validPublicationRevisions = (value: unknown): value is LivePublication["revisions"] =>
	isRecord(value) &&
	validRevision(value.lifecycle) &&
	validRevision(value.fixtureIdentity) &&
	validRevision(value.scoreCore) &&
	validRevision(value.displayStats) &&
	validRevision(value.explain) &&
	validRevision(value.rules);

const liveKey = (season: string, eventId: number, suffix: string): string =>
	`llm:data:v2:fpl:live:${season}:${eventId}:${suffix}`;

const liveItemKey = (
	season: string,
	eventId: number,
	generation: number,
	name: "eventLive" | "fixtures"
): string => `llm:data:v2:fpl:live:${season}:${eventId}:${generation}:${name}`;

const entryKey = (season: string, eventId: number, entryId: number, suffix: string): string =>
	`llm:data:v2:fpl:entry-live:${season}:${eventId}:${entryId}:${suffix}`;

const entryItemKey = (
	season: string,
	eventId: number,
	entryId: number,
	generation: number
): string => `llm:data:v2:fpl:entry-live:${season}:${eventId}:${entryId}:${generation}:input`;

const validState = (value: unknown): value is LivePublicationState =>
	typeof value === "string" &&
	new Set<LivePublicationState>([
		"PRE_DEADLINE",
		"PICKS_WAIT",
		"PICKS_PROBE",
		"PICKS_SYNC",
		"LIVE_ACTIVE",
		"BETWEEN_FIXTURES",
		"DAY_SETTLING",
		"GW_REVIEW",
		"FINALIZED",
	]).has(value as LivePublicationState);

const parseLivePublication = (
	raw: string | null,
	season: string,
	eventId: number
): LivePublication | null => {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value)) return null;
		const generation = integer(value.generation);
		const revisions = value.revisions;
		const items = value.items;
		if (
			value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
			typeof value.publicationId !== "string" ||
			!value.publicationId ||
			generation === null ||
			generation <= 0 ||
			value.season !== season ||
			value.eventId !== eventId ||
			!validState(value.state) ||
			!iso(value.sourceCheckedAt) ||
			!iso(value.publishedAt) ||
			(value.checkpointedAt !== null && !iso(value.checkpointedAt)) ||
			(value.expectedNextCheckAt !== null && !iso(value.expectedNextCheckAt)) ||
			!validPublicationRevisions(revisions) ||
			!isRecord(items) ||
			!validItem(
				items.eventLive,
				liveItemKey(season, eventId, generation, "eventLive"),
				"eventLive"
			) ||
			!validItem(items.fixtures, liveItemKey(season, eventId, generation, "fixtures"), "fixtures")
		)
			return null;
		return value as unknown as LivePublication;
	} catch {
		return null;
	}
};

const parseEntryPublication = (
	raw: string | null,
	season: string,
	eventId: number,
	entryId: number
): EntryPublication | null => {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value)) return null;
		const generation = integer(value.generation);
		if (
			value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
			typeof value.publicationId !== "string" ||
			generation === null ||
			generation <= 0 ||
			value.season !== season ||
			value.eventId !== eventId ||
			value.entryId !== entryId ||
			(value.state !== "PROVISIONAL" && value.state !== "FINAL") ||
			!iso(value.sourceCheckedAt) ||
			!iso(value.publishedAt) ||
			(value.checkpointedAt !== null && !iso(value.checkpointedAt)) ||
			(value.expectedNextCheckAt !== null && !iso(value.expectedNextCheckAt)) ||
			!validItem(value.item, entryItemKey(season, eventId, entryId, generation), "input")
		)
			return null;
		return value as unknown as EntryPublication;
	} catch {
		return null;
	}
};

const validPick = (value: unknown): value is Pick =>
	isRecord(value) &&
	integer(value.element) !== null &&
	(integer(value.element) as number) > 0 &&
	integer(value.position) !== null &&
	(integer(value.position) as number) >= 1 &&
	(integer(value.position) as number) <= 15 &&
	integer(value.multiplier) !== null &&
	(integer(value.multiplier) as number) >= 0 &&
	(integer(value.multiplier) as number) <= 3 &&
	typeof value.isCaptain === "boolean" &&
	typeof value.isViceCaptain === "boolean" &&
	!(value.isCaptain && value.isViceCaptain);

const validRevisionOnly = (value: Record<string, unknown>): boolean =>
	typeof value.revision === "string" && /^[0-9a-f]{64}$/.test(value.revision);

const validAutomaticSubs = (
	value: unknown,
	allowedElements?: ReadonlySet<number>
): value is readonly { inElement: number; outElement: number }[] => {
	if (!Array.isArray(value)) return false;
	const incoming = new Set<number>();
	const outgoing = new Set<number>();
	return value.every((item) => {
		if (!isRecord(item)) return false;
		const inElement = integer(item.inElement);
		const outElement = integer(item.outElement);
		if (
			inElement === null ||
			inElement <= 0 ||
			outElement === null ||
			outElement <= 0 ||
			inElement === outElement ||
			incoming.has(inElement) ||
			outgoing.has(outElement) ||
			incoming.has(outElement) ||
			outgoing.has(inElement) ||
			(allowedElements !== undefined &&
				(!allowedElements.has(inElement) || !allowedElements.has(outElement)))
		)
			return false;
		incoming.add(inElement);
		outgoing.add(outElement);
		return true;
	});
};

const validPreviousTotals = (
	value: unknown,
	expectedThroughEventId: number
): value is NonNullable<EntryLiveInput["previousTotals"]> =>
	isRecord(value) &&
	validRevisionOnly(value) &&
	safeInteger(value.throughEventId) !== null &&
	(safeInteger(value.throughEventId) as number) === expectedThroughEventId &&
	safeInteger(value.totalPoints) !== null &&
	(expectedThroughEventId === 0
		? (safeInteger(value.totalPoints) as number) === 0
		: (safeInteger(value.totalPoints) as number) >= 0) &&
	(value.overallRank === null ||
		(safeInteger(value.overallRank) !== null && (safeInteger(value.overallRank) as number) > 0));

const validAdjustment = (
	value: unknown
): value is NonNullable<EntryLiveInput["officialAdjustment"]> =>
	isRecord(value) &&
	validRevisionOnly(value) &&
	Array.isArray(value.multipliers) &&
	value.multipliers.every(
		(item) =>
			isRecord(item) &&
			integer(item.element) !== null &&
			(integer(item.element) as number) > 0 &&
			integer(item.multiplier) !== null &&
			(integer(item.multiplier) as number) >= 0 &&
			(integer(item.multiplier) as number) <= 3
	) &&
	Array.isArray(value.automaticSubs) &&
	validAutomaticSubs(value.automaticSubs);

const validFinalResult = (value: unknown): value is NonNullable<EntryLiveInput["finalResult"]> => {
	if (
		!isRecord(value) ||
		!validRevisionOnly(value) ||
		!isRecord(value.score) ||
		integer(value.score.eventPoints) === null ||
		(integer(value.score.eventPoints) as number) < 0 ||
		(value.score.totalPoints !== null &&
			(integer(value.score.totalPoints) === null ||
				(integer(value.score.totalPoints) as number) < 0)) ||
		!Array.isArray(value.picks) ||
		value.picks.length !== 15 ||
		!value.picks.every(validPick) ||
		!value.picks.every((pick) => (pick as Pick).position >= 1 && (pick as Pick).position <= 15) ||
		new Set(value.picks.map((pick) => (pick as Pick).position)).size !== 15 ||
		new Set(value.picks.map((pick) => (pick as Pick).element)).size !== 15 ||
		value.picks.filter((pick) => (pick as Pick).isCaptain).length !== 1 ||
		value.picks.filter((pick) => (pick as Pick).isViceCaptain).length !== 1
	)
		return false;
	return validAutomaticSubs(
		value.automaticSubs,
		new Set(value.picks.map((pick) => (pick as Pick).element))
	);
};

const validInput = (
	value: unknown,
	season: string,
	eventId: number,
	entryId: number
): value is EntryLiveInput => {
	if (
		!isRecord(value) ||
		value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
		value.season !== season ||
		value.eventId !== eventId ||
		value.entryId !== entryId
	)
		return false;
	const picksBase = value.picksBase;
	if (
		!isRecord(picksBase) ||
		typeof picksBase.revision !== "string" ||
		!/^[0-9a-f]{64}$/.test(picksBase.revision) ||
		!iso(picksBase.contentUpdatedAt) ||
		!Array.isArray(picksBase.picks) ||
		picksBase.picks.length !== 15 ||
		!picksBase.picks.every(validPick) ||
		new Set(picksBase.picks.map((pick) => (pick as Pick).position)).size !== 15 ||
		!picksBase.picks.every(
			(pick) => (pick as Pick).position >= 1 && (pick as Pick).position <= 15
		) ||
		new Set(picksBase.picks.map((pick) => (pick as Pick).element)).size !== 15 ||
		picksBase.picks.filter((pick) => (pick as Pick).isCaptain).length !== 1 ||
		picksBase.picks.filter((pick) => (pick as Pick).isViceCaptain).length !== 1 ||
		(picksBase.chip !== null && typeof picksBase.chip !== "string") ||
		integer(picksBase.transferCost) === null ||
		(integer(picksBase.transferCost) as number) < 0
	)
		return false;
	if (!(
		value.previousTotals === null ||
		validPreviousTotals(value.previousTotals, Math.max(0, eventId - 1))
	))
		return false;
	const pickElements = new Set(picksBase.picks.map((pick) => (pick as Pick).element));
	if (
		value.officialAdjustment !== null &&
		(!validAdjustment(value.officialAdjustment) ||
			value.officialAdjustment.multipliers.length !== 15 ||
			new Set(value.officialAdjustment.multipliers.map((item) => item.element)).size !== 15 ||
			value.officialAdjustment.multipliers.some((item) => !pickElements.has(item.element)) ||
			value.officialAdjustment.automaticSubs.some(
				(substitution) =>
					!pickElements.has(substitution.inElement) || !pickElements.has(substitution.outElement)
			))
	)
		return false;
	if (
		value.finalResult !== null &&
		(!validFinalResult(value.finalResult) ||
			value.finalResult.picks.some((pick) => !pickElements.has(pick.element)))
	)
		return false;
	return true;
};

const parsePublicationPayload = <T>(
	raw: string | null,
	item: PublicationItem,
	validate: (value: unknown) => value is T
): T | null => {
	if (
		raw === null ||
		Buffer.byteLength(raw, "utf8") !== item.bytes ||
		hash(jsonValue(raw)) !== item.sha256
	)
		return null;
	try {
		const value: unknown = JSON.parse(raw);
		const count =
			item.name === "input"
				? isRecord(value) && isRecord(value.picksBase) && Array.isArray(value.picksBase.picks)
					? value.picksBase.picks.length
					: null
				: Array.isArray(value)
					? value.length
					: null;
		return validate(value) && count === item.count ? value : null;
	} catch {
		return null;
	}
};

const nullableIntegerField = (row: Record<string, unknown>, field: string): boolean =>
	row[field] === null || integer(row[field]) !== null;

const nullableBooleanField = (row: Record<string, unknown>, field: string): boolean =>
	row[field] === null || typeof row[field] === "boolean";

const nullableStringField = (row: Record<string, unknown>, field: string): boolean =>
	row[field] === null || typeof row[field] === "string";

const hasUniquePositiveIds = <T>(rows: readonly T[], getId: (row: T) => number | null): boolean => {
	const ids = rows.map(getId);
	return (
		ids.every((id): id is number => id !== null && Number.isSafeInteger(id) && id > 0) &&
		new Set(ids).size === ids.length
	);
};

const isEventLiveArray = (value: unknown): value is EventLiveRow[] => {
	if (!Array.isArray(value) || !value.every(isRecord)) return false;
	const rows = value as Record<string, unknown>[];
	const integerFields = [
		"eventId",
		"elementId",
		"minutes",
		"goalsScored",
		"assists",
		"cleanSheets",
		"goalsConceded",
		"ownGoals",
		"penaltiesSaved",
		"penaltiesMissed",
		"yellowCards",
		"redCards",
		"saves",
		"bonus",
		"bps",
		"defensiveContribution",
		"totalPoints",
	];
	const stringFields = [
		"expectedGoals",
		"expectedAssists",
		"expectedGoalInvolvements",
		"expectedGoalsConceded",
	];
	return (
		hasUniquePositiveIds(rows, (row) => integer(row.elementId)) &&
		rows.every(
			(row) =>
				integer(row.eventId) !== null &&
				integer(row.elementId) !== null &&
				integer(row.totalPoints) !== null &&
				integerFields.every((field) => nullableIntegerField(row, field)) &&
				stringFields.every((field) => nullableStringField(row, field)) &&
				nullableBooleanField(row, "starts") &&
				nullableBooleanField(row, "inDreamTeam") &&
				(row.fixtureBreakdown === undefined || Array.isArray(row.fixtureBreakdown))
		)
	);
};

const isFixtureArray = (value: unknown): value is FixtureRow[] => {
	if (!Array.isArray(value) || !value.every(isRecord)) return false;
	const rows = value as Record<string, unknown>[];
	return (
		hasUniquePositiveIds(rows, (row) => integer(row.id)) &&
		rows.every(
			(row) =>
				(integer(row.code) ?? 0) > 0 &&
				(row.event === null || (integer(row.event) ?? 0) > 0) &&
				typeof row.finished === "boolean" &&
				typeof row.finishedProvisional === "boolean" &&
				nullableStringField(row, "kickoffTime") &&
				(integer(row.minutes) ?? -1) >= 0 &&
				nullableBooleanField(row, "started") &&
				(integer(row.teamH) ?? 0) > 0 &&
				(integer(row.teamA) ?? 0) > 0 &&
				nullableIntegerField(row, "teamHScore") &&
				nullableIntegerField(row, "teamAScore") &&
				nullableIntegerField(row, "teamHDifficulty") &&
				nullableIntegerField(row, "teamADifficulty")
		)
	);
};

const isEntryInput =
	(season: string, eventId: number, entryId: number) =>
	(value: unknown): value is EntryLiveInput =>
		validInput(value, season, eventId, entryId);

const readRedisGlobalCandidate = async (
	redis: Redis,
	season: string,
	eventId: number,
	pointer: "active" | "previous"
): Promise<GlobalRead | null> => {
	const publication = parseLivePublication(
		await redis.get(liveKey(season, eventId, pointer)),
		season,
		eventId
	);
	if (!publication) return null;
	const values = await redis.mget(
		publication.items.eventLive.key,
		publication.items.fixtures.key,
		`${publication.items.eventLive.key}:meta`,
		`${publication.items.fixtures.key}:meta`
	);
	if (
		values[2] !==
			`${publication.items.eventLive.count}|${publication.items.eventLive.bytes}|${publication.items.eventLive.sha256}` ||
		values[3] !==
			`${publication.items.fixtures.count}|${publication.items.fixtures.bytes}|${publication.items.fixtures.sha256}`
	)
		return null;
	const eventLives = parsePublicationPayload(
		values[0],
		publication.items.eventLive,
		isEventLiveArray
	);
	const fixtures = parsePublicationPayload(values[1], publication.items.fixtures, isFixtureArray);
	if (
		!eventLives ||
		!fixtures ||
		eventLives.some((row) => row.eventId !== eventId) ||
		fixtures.some((row) => row.event !== null && row.event !== eventId)
	)
		return null;
	return {
		publication,
		eventLives,
		fixtures,
		servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS",
	};
};

const readRedisEntryCandidate = async (
	redis: Redis,
	season: string,
	eventId: number,
	entryId: number,
	pointer: "active" | "previous"
): Promise<EntryRead | null> => {
	const publication = parseEntryPublication(
		await redis.get(entryKey(season, eventId, entryId, pointer)),
		season,
		eventId,
		entryId
	);
	if (!publication) return null;
	const [payload, metadata] = await redis.mget(
		publication.item.key,
		`${publication.item.key}:meta`
	);
	if (metadata !== `${publication.item.count}|${publication.item.bytes}|${publication.item.sha256}`)
		return null;
	const input = parsePublicationPayload(
		payload,
		publication.item,
		isEntryInput(season, eventId, entryId)
	);
	return input
		? { publication, input, servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS" }
		: null;
};

/** The V2 checkpoint relation is deliberately distinct from ops.dataset_publications. */
export const GLOBAL_CHECKPOINT_SQL = `
	SELECT
		publication_id,
		generation,
		state,
		source_checked_at,
		published_at,
		checkpointed_at,
		expected_next_check_at,
		revisions,
		event_live,
		fixtures,
		event_live_bytes,
		fixtures_bytes,
		event_live_sha256,
		fixtures_sha256,
		event_live_count,
		fixtures_count
	FROM competition.live_points_publication_checkpoints
	WHERE season_id = $1 AND event_id = $2 AND checkpointed_at IS NOT NULL
	ORDER BY generation DESC
	LIMIT 1
`;

export const ENTRY_CHECKPOINT_SQL = `
	WITH head AS (
		SELECT publication_id, generation, picks_base_revision, content_sha256, row_count,
			source_checked_at, content_updated_at, checkpointed_at, state
		FROM competition.entry_event_pick_heads
		WHERE season_id = $1 AND entry_id = $2 AND event_id = $3 AND state = 'COMPLETE'
	), picks AS (
		SELECT p.position, p.element_id, p.multiplier, p.is_captain, p.is_vice_captain,
			p.active_chip, p.transfers_cost
		FROM competition.entry_event_picks p
		WHERE p.season_id = $1 AND p.entry_id = $2 AND p.event_id = $3
	), final_result AS (
		SELECT result.event_points, result.overall_points, result.event_picks,
			result.automatic_substitutions, result.rich_synced_at, event.data_checked_at
		FROM competition.entry_event_results result
		JOIN fpl.events event
			ON event.season_id = result.season_id AND event.event_id = result.event_id
		WHERE result.season_id = $1
			AND result.entry_id = $2
			AND result.event_id = $3
			AND result.rich_synced_at IS NOT NULL
			AND event.finished = true
			AND event.data_checked = true
			AND (event.data_checked_at IS NULL OR result.rich_synced_at >= event.data_checked_at)
		LIMIT 1
	)
	SELECT head.*, COALESCE(jsonb_agg(jsonb_build_object(
		'element', picks.element_id,
		'position', picks.position,
		'multiplier', picks.multiplier,
		'isCaptain', picks.is_captain,
		'isViceCaptain', picks.is_vice_captain
	) ORDER BY picks.position) FILTER (WHERE picks.position IS NOT NULL), '[]'::jsonb) AS picks,
		MAX(picks.active_chip::text) AS chip,
		MAX(picks.transfers_cost) AS transfers_cost,
		final_result.event_points AS final_event_points,
		final_result.overall_points AS final_total_points,
		final_result.event_picks AS final_picks,
		final_result.automatic_substitutions AS final_automatic_substitutions,
		final_result.rich_synced_at AS final_source_checked_at,
		final_result.data_checked_at AS data_checked_at
	FROM head LEFT JOIN picks ON TRUE
		LEFT JOIN final_result ON TRUE
	GROUP BY head.publication_id, head.generation, head.picks_base_revision, head.content_sha256,
		head.row_count, head.source_checked_at, head.content_updated_at, head.checkpointed_at, head.state,
		final_result.event_points, final_result.overall_points, final_result.event_picks,
		final_result.automatic_substitutions, final_result.rich_synced_at, final_result.data_checked_at
`;

/** Exact SQL/result-shape probes for the V2 PostgreSQL fallback reader. */
export const LIVE_POINTS_V2_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "live-points-v2.global-checkpoint",
		sql: GLOBAL_CHECKPOINT_SQL,
		values: [2026, 1],
		resultTypes: [
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "publication_id",
				pgType: "text",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "generation",
				pgType: "bigint",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "state",
				pgType: "text",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "source_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "checkpointed_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "expected_next_check_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "revisions",
				pgType: "jsonb",
				acceptedPgTypes: ["json"],
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "event_live",
				pgType: "jsonb",
				acceptedPgTypes: ["json"],
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "fixtures",
				pgType: "jsonb",
				acceptedPgTypes: ["json"],
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "event_live_bytes",
				pgType: "integer",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "fixtures_bytes",
				pgType: "integer",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "event_live_sha256",
				pgType: "text",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "fixtures_sha256",
				pgType: "text",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "event_live_count",
				pgType: "integer",
			},
			{
				relation: "competition.live_points_publication_checkpoints",
				column: "fixtures_count",
				pgType: "integer",
			},
		],
	},
	{
		name: "live-points-v2.entry-checkpoint",
		sql: ENTRY_CHECKPOINT_SQL,
		values: [2026, 6953, 1],
		resultTypes: [
			{ relation: "competition.entry_event_pick_heads", column: "publication_id", pgType: "text" },
			{ relation: "competition.entry_event_pick_heads", column: "generation", pgType: "bigint" },
			{
				relation: "competition.entry_event_pick_heads",
				column: "picks_base_revision",
				pgType: "text",
			},
			{ relation: "competition.entry_event_pick_heads", column: "content_sha256", pgType: "text" },
			{ relation: "competition.entry_event_pick_heads", column: "row_count", pgType: "smallint" },
			{
				relation: "competition.entry_event_pick_heads",
				column: "source_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.entry_event_pick_heads",
				column: "content_updated_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.entry_event_pick_heads",
				column: "checkpointed_at",
				pgType: "timestamp with time zone",
			},
			{ relation: "competition.entry_event_pick_heads", column: "state", pgType: "text" },
			{ relation: "competition.entry_event_picks", column: "position", pgType: "smallint" },
			{ relation: "competition.entry_event_picks", column: "element_id", pgType: "integer" },
			{ relation: "competition.entry_event_picks", column: "multiplier", pgType: "smallint" },
			{ relation: "competition.entry_event_picks", column: "is_captain", pgType: "boolean" },
			{ relation: "competition.entry_event_picks", column: "is_vice_captain", pgType: "boolean" },
			{
				relation: "competition.entry_event_picks",
				column: "active_chip",
				pgType: "competition.chip",
			},
			{ relation: "competition.entry_event_picks", column: "transfers_cost", pgType: "integer" },
			{ relation: "competition.entry_event_results", column: "event_points", pgType: "integer" },
			{ relation: "competition.entry_event_results", column: "overall_points", pgType: "integer" },
			{
				relation: "competition.entry_event_results",
				column: "event_picks",
				pgType: "jsonb",
				acceptedPgTypes: ["json"],
			},
			{
				relation: "competition.entry_event_results",
				column: "automatic_substitutions",
				pgType: "jsonb",
				acceptedPgTypes: ["json"],
			},
			{
				relation: "competition.entry_event_results",
				column: "rich_synced_at",
				pgType: "timestamp with time zone",
			},
			{ relation: "fpl.events", column: "data_checked_at", pgType: "timestamp with time zone" },
		],
	},
];

const dbIso = (value: unknown): string | null => {
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	return iso(value) ? value : null;
};

const normalizeFinalPicks = (value: unknown): Exactly15Picks | null => {
	if (!Array.isArray(value) || value.length !== 15) return null;
	const picks = value.map((item) => {
		if (!isRecord(item)) return null;
		const element = integer(item.element);
		const position = integer(item.position);
		const multiplier = integer(item.multiplier);
		const isCaptain = item.is_captain ?? item.isCaptain;
		const isViceCaptain = item.is_vice_captain ?? item.isViceCaptain;
		if (
			element === null ||
			element <= 0 ||
			position === null ||
			position < 1 ||
			position > 15 ||
			multiplier === null ||
			multiplier < 0 ||
			multiplier > 3 ||
			typeof isCaptain !== "boolean" ||
			typeof isViceCaptain !== "boolean"
		)
			return null;
		return { element, position, multiplier, isCaptain, isViceCaptain } satisfies Pick;
	});
	if (picks.some((pick) => pick === null)) return null;
	const normalized = picks as Exclude<(typeof picks)[number], null>[];
	if (
		new Set(normalized.map((pick) => pick.position)).size !== 15 ||
		new Set(normalized.map((pick) => pick.element)).size !== 15 ||
		normalized.filter((pick) => pick.isCaptain).length !== 1 ||
		normalized.filter((pick) => pick.isViceCaptain).length !== 1 ||
		normalized.some((pick) => pick.isCaptain && pick.isViceCaptain)
	)
		return null;
	return [...normalized].sort((left, right) => left.position - right.position) as Exactly15Picks;
};

const normalizeFinalAutomaticSubs = (
	value: unknown,
	allowedElements: ReadonlySet<number>
): readonly { inElement: number; outElement: number }[] | null => {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const incoming = new Set<number>();
	const outgoing = new Set<number>();
	const result: { inElement: number; outElement: number }[] = [];
	for (const item of value) {
		if (!isRecord(item)) return null;
		const inElement = integer(item.element_in ?? item.elementIn);
		const outElement = integer(item.element_out ?? item.elementOut);
		if (
			inElement === null ||
			inElement <= 0 ||
			outElement === null ||
			outElement <= 0 ||
			inElement === outElement ||
			!allowedElements.has(inElement) ||
			!allowedElements.has(outElement) ||
			incoming.has(inElement) ||
			outgoing.has(outElement) ||
			incoming.has(outElement) ||
			outgoing.has(inElement)
		)
			return null;
		incoming.add(inElement);
		outgoing.add(outElement);
		result.push({ inElement, outElement });
	}
	return result;
};

const readDatabaseGlobal = async (
	context: GraphQLContext,
	season: string,
	eventId: number
): Promise<GlobalRead | null> => {
	try {
		const result = await context.database.query<Row>(GLOBAL_CHECKPOINT_SQL, [
			context.currentSeason.seasonId,
			eventId,
		]);
		const row = result.rows[0];
		if (!row) return null;
		const publicationId = typeof row.publication_id === "string" ? row.publication_id : null;
		const generation = integer(row.generation);
		const sourceCheckedAt = dbIso(row.source_checked_at);
		const publishedAt = dbIso(row.published_at);
		const checkpointedAt = dbIso(row.checkpointed_at);
		if (
			!publicationId ||
			generation === null ||
			!sourceCheckedAt ||
			!publishedAt ||
			!checkpointedAt ||
			!validState(row.state)
		)
			return null;
		const eventLives = jsonValue(row.event_live);
		const fixtures = jsonValue(row.fixtures);
		const revisions = jsonValue(row.revisions);
		if (
			!isEventLiveArray(eventLives) ||
			!isFixtureArray(fixtures) ||
			!validPublicationRevisions(revisions) ||
			eventLives.some((row) => row.eventId !== eventId) ||
			fixtures.some((fixture) => fixture.event !== null && fixture.event !== eventId)
		)
			return null;
		const eventLivePayload = stable(eventLives);
		const fixturePayload = stable(fixtures);
		if (
			typeof row.event_live_sha256 !== "string" ||
			hash(eventLives) !== row.event_live_sha256 ||
			typeof row.fixtures_sha256 !== "string" ||
			hash(fixtures) !== row.fixtures_sha256 ||
			integer(row.event_live_bytes) !== Buffer.byteLength(eventLivePayload, "utf8") ||
			integer(row.fixtures_bytes) !== Buffer.byteLength(fixturePayload, "utf8") ||
			integer(row.event_live_count) !== eventLives.length ||
			integer(row.fixtures_count) !== fixtures.length
		)
			return null;
		const manifest: LivePublication = {
			contractVersion: LIVE_POINTS_CONTRACT_VERSION,
			publicationId,
			generation,
			season,
			eventId,
			state: row.state,
			sourceCheckedAt,
			publishedAt,
			checkpointedAt,
			expectedNextCheckAt: dbIso(row.expected_next_check_at),
			revisions: revisions as LivePublication["revisions"],
			items: {
				eventLive: {
					name: "eventLive",
					key: "postgres:eventLive",
					type: "string",
					count: eventLives.length,
					bytes: Buffer.byteLength(eventLivePayload, "utf8"),
					sha256: hash(eventLives),
				},
				fixtures: {
					name: "fixtures",
					key: "postgres:fixtures",
					type: "string",
					count: fixtures.length,
					bytes: Buffer.byteLength(fixturePayload, "utf8"),
					sha256: hash(fixtures),
				},
			},
		};
		return { publication: manifest, eventLives, fixtures, servedFrom: "POSTGRES_CHECKPOINT" };
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId },
			"Live Points V2 PostgreSQL checkpoint unavailable"
		);
		return null;
	}
};

const readDatabaseEntry = async (
	context: GraphQLContext,
	season: string,
	eventId: number,
	entryId: number
): Promise<EntryRead | null> => {
	try {
		const result = await context.database.query<Row>(ENTRY_CHECKPOINT_SQL, [
			context.currentSeason.seasonId,
			entryId,
			eventId,
		]);
		const row = result.rows[0];
		if (
			!row ||
			row.state !== "COMPLETE" ||
			integer(row.row_count) !== 15 ||
			integer(row.generation) === null ||
			typeof row.publication_id !== "string" ||
			row.publication_id.length === 0 ||
			typeof row.picks_base_revision !== "string" ||
			!/^[0-9a-f]{64}$/.test(row.picks_base_revision) ||
			typeof row.content_sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(row.content_sha256)
		)
			return null;
		const sourceCheckedAt = dbIso(row.source_checked_at);
		const contentUpdatedAt = dbIso(row.content_updated_at);
		const checkpointedAt = dbIso(row.checkpointed_at);
		const picks = jsonValue(row.picks);
		if (
			!sourceCheckedAt ||
			!contentUpdatedAt ||
			!checkpointedAt ||
			!Array.isArray(picks) ||
			picks.length !== 15 ||
			!picks.every(validPick)
		)
			return null;
		const finalPicks = normalizeFinalPicks(row.final_picks);
		const finalAutomaticSubs = finalPicks
			? normalizeFinalAutomaticSubs(
					row.final_automatic_substitutions,
					new Set(finalPicks.map((pick) => pick.element))
				)
			: null;
		const finalEventPoints = integer(row.final_event_points);
		const finalTotalPoints = integer(row.final_total_points);
		const finalSourceCheckedAt = dbIso(row.final_source_checked_at);
		const dataCheckedAt = dbIso(row.data_checked_at);
		const finalEvidenceValid = Boolean(
			finalPicks &&
			finalAutomaticSubs &&
			finalEventPoints !== null &&
			finalEventPoints >= 0 &&
			(finalTotalPoints === null || finalTotalPoints >= 0) &&
			finalSourceCheckedAt &&
			(!dataCheckedAt || Date.parse(finalSourceCheckedAt) >= Date.parse(dataCheckedAt))
		);
		const finalResultRevision = finalEvidenceValid
			? hash({
					dataCheckedAt,
					score: { eventPoints: finalEventPoints, totalPoints: finalTotalPoints },
					picks: finalPicks,
					automaticSubs: finalAutomaticSubs,
				})
			: null;
		const officialAdjustmentRevision = finalEvidenceValid
			? hash({
					dataCheckedAt,
					multipliers: finalPicks!.map((pick) => ({
						element: pick.element,
						multiplier: pick.multiplier,
					})),
					automaticSubs: finalAutomaticSubs,
				})
			: null;
		const input: EntryLiveInput = {
			contractVersion: LIVE_POINTS_CONTRACT_VERSION,
			season,
			eventId,
			entryId,
			picksBase: {
				revision: row.picks_base_revision,
				contentUpdatedAt,
				picks: picks as Exactly15Picks,
				chip: typeof row.chip === "string" ? row.chip : null,
				transferCost: integer(row.transfers_cost) ?? 0,
			},
			previousTotals: null,
			officialAdjustment: finalEvidenceValid
				? {
						revision: officialAdjustmentRevision!,
						multipliers: finalPicks!.map((pick) => ({
							element: pick.element,
							multiplier: pick.multiplier,
						})),
						automaticSubs: finalAutomaticSubs!,
					}
				: null,
			finalResult: finalEvidenceValid
				? {
						revision: finalResultRevision!,
						score: { eventPoints: finalEventPoints!, totalPoints: finalTotalPoints },
						picks: finalPicks!,
						automaticSubs: finalAutomaticSubs!,
					}
				: null,
		};
		const expectedContentHash = hash({
			picks,
			chip: typeof row.chip === "string" ? row.chip : null,
			transferCost: integer(row.transfers_cost) ?? 0,
		});
		if (
			row.content_sha256 !== expectedContentHash ||
			row.picks_base_revision !== expectedContentHash ||
			!validInput(input, season, eventId, entryId)
		)
			return null;
		const generation = integer(row.generation) as number;
		return {
			publication: {
				contractVersion: LIVE_POINTS_CONTRACT_VERSION,
				publicationId: row.publication_id,
				generation,
				season,
				eventId,
				entryId,
				state: finalEvidenceValid ? "FINAL" : "PROVISIONAL",
				sourceCheckedAt,
				publishedAt: checkpointedAt,
				checkpointedAt,
				expectedNextCheckAt: null,
				item: {
					name: "input",
					key: "postgres:input",
					type: "string",
					count: 15,
					bytes: Buffer.byteLength(stable(input), "utf8"),
					sha256: hash(input),
				},
			},
			input,
			servedFrom: "POSTGRES_CHECKPOINT",
		};
	} catch (error) {
		context.logger.warn(
			{ err: error, entryId, eventId },
			"Entry Live Points V2 PostgreSQL checkpoint unavailable"
		);
		return null;
	}
};

const requestScope = (context: GraphQLContext): object => context.requestScope ?? context;

const entryMetadataKey = (context: GraphQLContext, entryId: number): string =>
	`${context.currentSeason.seasonCode}:${entryId}`;

const readRedisGlobal = (
	context: GraphQLContext,
	eventId: number,
	expectedScoreCoreRevision?: string
): Promise<GlobalRead | null> => {
	const scope = requestScope(context);
	let memo = requestRedisGlobalMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestRedisGlobalMemo.set(scope, memo);
	}
	const memoKey = String(eventId) + ":" + (expectedScoreCoreRevision ?? "current");
	const existing = memo.get(memoKey);
	if (existing) return existing;
	const load = (async (): Promise<GlobalRead | null> => {
		const season = context.currentSeason.seasonCode;
		try {
			const redis = context.redis;
			const redisValue = await readRedisGlobalCandidate(redis, season, eventId, "active");
			if (
				redisValue &&
				(expectedScoreCoreRevision === undefined ||
					redisValue.publication.revisions.scoreCore.revision === expectedScoreCoreRevision)
			)
				return redisValue;
			const previous = await readRedisGlobalCandidate(redis, season, eventId, "previous");
			if (
				previous &&
				(expectedScoreCoreRevision === undefined ||
					previous.publication.revisions.scoreCore.revision === expectedScoreCoreRevision)
			)
				return previous;
		} catch (error) {
			context.logger.warn({ err: error, eventId }, "Live Points V2 Redis read unavailable");
		}
		return null;
	})();
	memo.set(memoKey, load);
	return load;
};

const readDatabaseGlobalMemoized = (
	context: GraphQLContext,
	eventId: number,
	expectedScoreCoreRevision?: string
): Promise<GlobalRead | null> => {
	const scope = requestScope(context);
	let memo = requestDatabaseGlobalMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestDatabaseGlobalMemo.set(scope, memo);
	}
	const memoKey = String(eventId) + ":" + (expectedScoreCoreRevision ?? "current");
	const existing = memo.get(memoKey);
	if (existing) return existing;
	const load = readDatabaseGlobal(context, context.currentSeason.seasonCode, eventId).then(
		(value) =>
			value &&
			(expectedScoreCoreRevision === undefined ||
				value.publication.revisions.scoreCore.revision === expectedScoreCoreRevision)
				? value
				: null
	);
	memo.set(memoKey, load);
	return load;
};

const readGlobal = async (
	context: GraphQLContext,
	eventId: number,
	expectedScoreCoreRevision?: string
): Promise<GlobalRead | null> =>
	(await readRedisGlobal(context, eventId, expectedScoreCoreRevision)) ??
	(await readDatabaseGlobalMemoized(context, eventId, expectedScoreCoreRevision));

/** Read the complete event publication for non-entry live desks. */
export const readLivePublicationV2 = async (
	context: GraphQLContext,
	eventId: number,
	expectedScoreCoreRevision?: string
): Promise<LivePublicationReadV2 | null> => readGlobal(context, eventId, expectedScoreCoreRevision);

const readRedisEntry = async (
	context: GraphQLContext,
	eventId: number,
	entryId: number
): Promise<EntryRead | null> => {
	const season = context.currentSeason.seasonCode;
	try {
		const current = await readRedisEntryCandidate(
			context.redis,
			season,
			eventId,
			entryId,
			"active"
		);
		if (current) return current;
		const previous = await readRedisEntryCandidate(
			context.redis,
			season,
			eventId,
			entryId,
			"previous"
		);
		if (previous) return previous;
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId, entryId },
			"Entry Live Points V2 Redis read unavailable"
		);
	}
	return null;
};

const readCore = (context: GraphQLContext): Promise<CoreLiveIdentitySnapshot | null> => {
	const scope = requestScope(context);
	const existing = requestCoreMemo.get(scope);
	if (existing) return existing;
	const load = getCoreLiveIdentitySnapshot(context).catch((error) => {
		context.logger.warn({ err: error }, "Live Points V2 core identity unavailable");
		return null;
	});
	requestCoreMemo.set(scope, load);
	return load;
};

const emptyEntry = (entryId: number): Entry => ({
	id: entryId,
	entryName: "",
	playerName: "",
	region: null,
	startedEvent: null,
	overallPoints: null,
	overallRank: null,
	bank: null,
	teamValue: null,
	totalTransfers: null,
	lastEventId: null,
	lastOverallPoints: null,
	lastOverallRank: null,
	lastTeamValue: null,
	lastBank: null,
});

const getEntrySafe = async (context: GraphQLContext, entryId: number): Promise<Entry> => {
	const scope = requestScope(context);
	let memo = requestEntryMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestEntryMemo.set(scope, memo);
	}
	const existing = memo.get(entryId);
	if (existing) return existing;

	const key = entryMetadataKey(context, entryId);
	const circuitOpenUntil = entryMetadataCircuit.get(key) ?? 0;
	const load = (async (): Promise<Entry> => {
		if (circuitOpenUntil > Date.now()) return emptyEntry(entryId);
		try {
			const value = (await entriesRepository.getEntryById(context, entryId)) ?? emptyEntry(entryId);
			entryMetadataCircuit.delete(key);
			return value;
		} catch (error) {
			entryMetadataCircuit.set(key, Date.now() + ENTRY_METADATA_CIRCUIT_COOLDOWN_MS);
			context.logger.warn({ err: error, entryId }, "Live Points V2 entry metadata unavailable");
			return emptyEntry(entryId);
		}
	})();
	memo.set(entryId, load);
	return load;
};

const preloadEntryMetadata = async (
	context: GraphQLContext,
	entryIds: readonly number[]
): Promise<void> => {
	const uniqueIds = [
		...new Set(entryIds.filter((entryId) => Number.isSafeInteger(entryId) && entryId > 0)),
	];
	if (uniqueIds.length <= 1) return;
	const scope = requestScope(context);
	let memo = requestEntryMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestEntryMemo.set(scope, memo);
	}
	const missingIds = uniqueIds.filter(
		(entryId) =>
			!memo!.has(entryId) &&
			(entryMetadataCircuit.get(entryMetadataKey(context, entryId)) ?? 0) <= Date.now()
	);
	if (missingIds.length === 0) return;
	const chunkSize = 500;
	for (let offset = 0; offset < missingIds.length; offset += chunkSize) {
		const chunk = missingIds.slice(offset, offset + chunkSize);
		try {
			const entries = await entriesRepository.getEntriesByIds(context, chunk);
			for (const entryId of chunk)
				memo.set(entryId, Promise.resolve(entries.get(entryId) ?? emptyEntry(entryId)));
		} catch (error) {
			for (const entryId of chunk) {
				entryMetadataCircuit.set(
					entryMetadataKey(context, entryId),
					Date.now() + ENTRY_METADATA_CIRCUIT_COOLDOWN_MS
				);
				memo.set(entryId, Promise.resolve(emptyEntry(entryId)));
			}
			context.logger.warn(
				{ err: error, entryCount: chunk.length, offset },
				"Live Points V2 batch entry metadata chunk unavailable"
			);
		}
	}
};

const playerTypeName = (type: number): string =>
	({ 1: "Goalkeeper", 2: "Defender", 3: "Midfielder", 4: "Forward" })[type] ?? "Unknown";

const parseExpected = (value: string | null): number | null => {
	const parsed = value === null ? Number.NaN : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const eventFixturesForPlayer = (
	fixtures: readonly FixtureRow[],
	player: CorePlayerData
): FixtureRow[] =>
	fixtures.filter((fixture) => fixture.teamH === player.teamId || fixture.teamA === player.teamId);

const played = (row: EventLiveRow | undefined): boolean => (row?.minutes ?? 0) > 0;

const fixtureIdFromBreakdown = (value: unknown): number | null => {
	if (!isRecord(value)) return null;
	return integer(value.fixtureId ?? value.fixture_id ?? value.fixture);
};

const explicitTeamIdFromBreakdown = (value: unknown): number | null => {
	if (!isRecord(value)) return null;
	return integer(value.teamId ?? value.team_id ?? value.playerTeamId ?? value.player_team_id);
};

/**
 * Resolve the player identity for this event before building display rows.
 * Current-player metadata is only accepted when it is compatible with the
 * event fixtures (or the event has no fixture evidence yet).  A historical
 * transfer without event-scoped evidence fails closed instead of displaying a
 * score against the wrong club.
 */
const eventPlayer = (
	player: CorePlayerData,
	live: EventLiveRow | undefined,
	fixtures: readonly FixtureRow[]
): CorePlayerData | null => {
	const breakdown = Array.isArray(live?.fixtureBreakdown) ? live.fixtureBreakdown : null;
	const breakdownFixtureIds = new Set(
		(breakdown ?? [])
			.map(fixtureIdFromBreakdown)
			.filter((fixtureId): fixtureId is number => fixtureId !== null && fixtureId > 0)
	);
	const explicitTeamIds = new Set(
		(breakdown ?? [])
			.map(explicitTeamIdFromBreakdown)
			.filter((teamId): teamId is number => teamId !== null && teamId > 0)
	);
	if (explicitTeamIds.size === 1) {
		return { ...player, teamId: [...explicitTeamIds][0]! };
	}
	if (explicitTeamIds.size > 1) return null;

	const currentFixtures = eventFixturesForPlayer(fixtures, player);
	if (breakdownFixtureIds.size > 0) {
		const currentFixtureIds = new Set(currentFixtures.map((fixture) => fixture.id));
		if (
			currentFixtures.length > 0 &&
			[...breakdownFixtureIds].every((fixtureId) => currentFixtureIds.has(fixtureId))
		) {
			return player;
		}
		return null;
	}
	if (currentFixtures.length > 0 || breakdown?.length === 0 || fixtures.length === 0) {
		return player;
	}
	// A player with no current-event fixture may be a confirmed blank-gameweek
	// pick.  This is safe only when the source explicitly supplies an empty
	// breakdown; otherwise an old event/current roster mismatch is ambiguous.
	return null;
};

const playerHasCompletedEvent = (
	player: CorePlayerData,
	live: EventLiveRow | undefined,
	fixtures: readonly FixtureRow[]
): boolean => {
	if (played(live)) return false;
	const playerFixtures = eventFixturesForPlayer(fixtures, player);
	if (playerFixtures.length === 0)
		return Array.isArray(live?.fixtureBreakdown) && live!.fixtureBreakdown!.length === 0;
	return playerFixtures.every((fixture) => fixture.finished || fixture.finishedProvisional);
};

type Lineup = {
	active: Set<number>;
	autoSubs: Map<number, number>;
	activeCaptain: Pick | null;
	captainMultiplier: number;
};

const legalFormation = (
	active: readonly Pick[],
	players: ReadonlyMap<number, CorePlayerData>
): boolean => {
	const counts = new Map<number, number>();
	for (const pick of active) {
		const type = players.get(pick.element)?.type;
		if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	return (
		(counts.get(1) ?? 0) === 1 &&
		(counts.get(2) ?? 0) >= 3 &&
		(counts.get(3) ?? 0) >= 2 &&
		(counts.get(4) ?? 0) >= 1
	);
};

const calculateLineup = (
	picks: readonly Pick[],
	players: ReadonlyMap<number, CorePlayerData>,
	liveByElement: ReadonlyMap<number, EventLiveRow>,
	chip: CanonicalFplChip,
	fixtures: readonly FixtureRow[]
): Lineup => {
	const ordered = [...picks].sort((left, right) => left.position - right.position);
	const starters = ordered.filter((pick) => pick.position <= 11);
	const bench = ordered.filter((pick) => pick.position > 11);
	const active = new Set<number>();
	for (const pick of starters)
		if (
			!playerHasCompletedEvent(
				players.get(pick.element)!,
				liveByElement.get(pick.element),
				fixtures
			)
		)
			active.add(pick.element);
	const autoSubs = new Map<number, number>();
	if (chip === "BENCH_BOOST") {
		for (const pick of ordered) active.add(pick.element);
	} else {
		const missing = starters.filter((pick) =>
			playerHasCompletedEvent(players.get(pick.element)!, liveByElement.get(pick.element), fixtures)
		);
		const maxByType: Record<number, number> = { 1: 1, 2: 5, 3: 5, 4: 3 };
		const search = (
			index: number,
			current: Set<number>,
			substitutions: Map<number, number>
		): boolean => {
			if (index >= missing.length) {
				return legalFormation(
					ordered.filter((pick) => current.has(pick.element)),
					players
				);
			}
			const missingPick = missing[index];
			for (const candidate of bench) {
				if (
					current.has(candidate.element) ||
					substitutions.has(candidate.element) ||
					!played(liveByElement.get(candidate.element)) ||
					playerHasCompletedEvent(
						players.get(candidate.element)!,
						liveByElement.get(candidate.element),
						fixtures
					)
				)
					continue;
				const missingType = players.get(missingPick.element)?.type;
				const candidateType = players.get(candidate.element)?.type;
				if (candidateType === 1 ? missingType !== 1 : missingType === 1) continue;
				const count = [...current, candidate.element].filter(
					(element) => players.get(element)?.type === candidateType
				).length;
				if (candidateType !== undefined && count > (maxByType[candidateType] ?? 15)) continue;
				current.add(candidate.element);
				substitutions.set(candidate.element, missingPick.element);
				if (search(index + 1, current, substitutions)) return true;
				current.delete(candidate.element);
				substitutions.delete(candidate.element);
			}
			return search(index + 1, current, substitutions);
		};
		search(0, active, autoSubs);
	}
	const captain = ordered.find((pick) => pick.isCaptain) ?? null;
	const vice = ordered.find((pick) => pick.isViceCaptain) ?? null;
	const activeCaptain =
		captain && active.has(captain.element)
			? captain
			: vice && active.has(vice.element)
				? vice
				: null;
	const captainMultiplier =
		activeCaptain === null
			? 0
			: chip === "TRIPLE_CAPTAIN"
				? 3
				: activeCaptain.element === captain?.element
					? Math.max(2, captain?.multiplier ?? 2)
					: Math.max(2, vice?.multiplier ?? 2);
	return { active, autoSubs, activeCaptain, captainMultiplier };
};

const calculateFinalLineup = (
	picks: readonly Pick[],
	liveByElement: ReadonlyMap<number, EventLiveRow>,
	automaticSubs: readonly { inElement: number; outElement: number }[],
	chip: CanonicalFplChip
): Lineup => {
	const ordered = [...picks].sort((left, right) => left.position - right.position);
	const active = new Set(
		ordered
			.filter((pick) => (chip === "BENCH_BOOST" || pick.position <= 11) && pick.multiplier > 0)
			.map((pick) => pick.element)
	);
	const autoSubs = new Map(
		automaticSubs.map((substitution) => [substitution.inElement, substitution.outElement] as const)
	);
	if (chip !== "BENCH_BOOST") {
		for (const substitution of automaticSubs) {
			active.delete(substitution.outElement);
			active.add(substitution.inElement);
		}
	}
	const captain = ordered.find((pick) => pick.isCaptain) ?? null;
	const vice = ordered.find((pick) => pick.isViceCaptain) ?? null;
	const activeCaptain =
		captain && active.has(captain.element)
			? captain
			: vice && active.has(vice.element)
				? vice
				: null;
	const captainMultiplier =
		activeCaptain === null
			? 0
			: chip === "TRIPLE_CAPTAIN"
				? 3
				: activeCaptain.element === captain?.element
					? Math.max(2, captain?.multiplier ?? 2)
					: Math.max(2, vice?.multiplier ?? 2);
	return { active, autoSubs, activeCaptain, captainMultiplier };
};

const fixtureScore = (fixture: FixtureRow, player: CorePlayerData): string => {
	const home = fixture.teamH === player.teamId;
	const own = home ? fixture.teamHScore : fixture.teamAScore;
	const against = home ? fixture.teamAScore : fixture.teamHScore;
	return own === null || against === null ? "-" : `${own}-${against}`;
};

const mapPick = (params: {
	season: string;
	eventId: number;
	pick: Pick;
	player: CorePlayerData;
	team: CoreTeamData;
	fixtures: readonly FixtureRow[];
	live: EventLiveRow | undefined;
	lineup: Lineup;
	teams: ReadonlyMap<number, CoreTeamData>;
}): ElementEventResultDataV2 => {
	const { season, eventId, pick, player, team, fixtures, live, lineup } = params;
	const playerFixtures = eventFixturesForPlayer(fixtures, player);
	const fixtureDetails = playerFixtures.map((item) => {
		const wasHome = item.teamH === player.teamId;
		const opponentId = wasHome ? item.teamA : item.teamH;
		return {
			opponentId,
			opponentTeam: params.teams.get(opponentId),
			wasHome: wasHome ? "H" : "A",
			score: fixtureScore(item, player),
		};
	});
	const fixture = playerFixtures[0];
	const opponent = fixtureDetails.length === 1 ? (fixtureDetails[0]?.opponentId ?? 0) : 0;
	const opponentNames = fixtureDetails.map((item) => item.opponentTeam?.name ?? "").filter(Boolean);
	const opponentShortNames = fixtureDetails
		.map((item) => item.opponentTeam?.shortName ?? "")
		.filter(Boolean);
	const isGwStarted = playerFixtures.some((item) => item.started === true);
	const allFinished =
		playerFixtures.length > 0 &&
		playerFixtures.every((item) => item.finished || item.finishedProvisional);
	const isActive = lineup.active.has(pick.element);
	const captainMultiplier =
		lineup.activeCaptain?.element === pick.element
			? lineup.captainMultiplier
			: isActive
				? pick.multiplier
				: 0;
	return {
		season,
		event: eventId,
		element: pick.element,
		code: player.code,
		webName: player.webName,
		price: player.price / 10,
		elementType: player.type,
		elementTypeName: playerTypeName(player.type),
		teamId: player.teamId,
		teamCode: team.code,
		teamName: team.name,
		teamShortName: team.shortName,
		againstId: opponent,
		againstName: fixtureDetails.length === 0 ? "BLANK" : opponentNames.join(" / "),
		againstShortName: fixtureDetails.length === 0 ? "BLANK" : opponentShortNames.join(" / "),
		wasHome: fixtureDetails.map((item) => item.wasHome).join(" / "),
		score: fixtureDetails.map((item) => item.score).join(" / "),
		position: pick.position,
		multiplier: captainMultiplier,
		isCaptain: pick.isCaptain,
		isViceCaptain: pick.isViceCaptain,
		isGwStarted,
		isGwFinished: allFinished,
		isPlayed: played(live),
		playStatus: played(live) ? 1 : 0,
		minutes: live?.minutes ?? 0,
		goalsScored: live?.goalsScored ?? 0,
		assists: live?.assists ?? 0,
		cleanSheets: live?.cleanSheets ?? 0,
		goalsConceded: live?.goalsConceded ?? 0,
		defensiveContribution: live?.defensiveContribution ?? 0,
		ownGoals: live?.ownGoals ?? 0,
		penaltiesSaved: live?.penaltiesSaved ?? 0,
		penaltiesMissed: live?.penaltiesMissed ?? 0,
		yellowCards: live?.yellowCards ?? 0,
		redCards: live?.redCards ?? 0,
		saves: live?.saves ?? 0,
		bonus: live?.bonus ?? 0,
		bps: live?.bps ?? 0,
		totalPoints: live?.totalPoints ?? 0,
		starts: live?.starts ?? null,
		expectedGoals: parseExpected(live?.expectedGoals ?? null),
		expectedAssists: parseExpected(live?.expectedAssists ?? null),
		expectedGoalInvolvements: parseExpected(live?.expectedGoalInvolvements ?? null),
		expectedGoalsConceded: parseExpected(live?.expectedGoalsConceded ?? null),
		inDreamTeam: live?.inDreamTeam ?? null,
		pickActive: isActive,
		autoSub: lineup.autoSubs.has(pick.element),
		bgw: playerFixtures.length === 0,
		dgw: playerFixtures.length > 1,
	};
};

const nowIso = (): string => new Date().toISOString();

const deliveryFor = (
	global: GlobalRead,
	entry: EntryRead,
	_now: string,
	extraReasons: string[] = []
): LiveDeliveryV2 => {
	// Picks are a deadline-scoped immutable input, not a 30-second heartbeat.
	// Only the live score-core publication drives FRESH/STALE.  An older but
	// complete picks input is valid and must not make every live response stale.
	const age = Date.now() - Date.parse(global.publication.sourceCheckedAt);
	const fallback =
		global.servedFrom !== "REDIS_CURRENT" ||
		entry.servedFrom !== "REDIS_CURRENT" ||
		extraReasons.length > 0;
	const finalResultAvailable =
		global.publication.state === "FINALIZED" && entry.input.finalResult !== null;
	const state: DeliveryState = finalResultAvailable
		? "FINAL"
		: fallback
			? "DEGRADED"
			: age <= LIVE_POINTS_FRESHNESS_SECONDS * 1000
				? "FRESH"
				: "STALE";
	const servedFrom: ServedFrom = finalResultAvailable
		? "FINAL_RESULT"
		: global.servedFrom !== "REDIS_CURRENT"
			? global.servedFrom
			: entry.servedFrom;
	return {
		state,
		servedFrom,
		reasonCodes: [
			...extraReasons,
			...(fallback ? ["FALLBACK_SERVED"] : []),
			...(state === "STALE" ? ["SOURCE_OLDER_THAN_30_SECONDS"] : []),
		],
	};
};

const revisionVector = (
	global: LivePublication,
	entry: EntryLiveInput,
	entryPublication: EntryPublication
): LiveRevisionVectorV2 => ({
	publicationId: global.publicationId,
	generation: global.generation,
	lifecycle: global.revisions.lifecycle.revision,
	fixtureIdentity: global.revisions.fixtureIdentity.revision,
	scoreCore: global.revisions.scoreCore.revision,
	displayStats: global.revisions.displayStats.revision,
	explain: global.revisions.explain.revision,
	picksBase: entry.picksBase.revision,
	officialAdjustment: entry.officialAdjustment?.revision ?? null,
	previousTotals: entry.previousTotals?.revision ?? null,
	finalResult: entry.finalResult?.revision ?? null,
	rules: global.revisions.rules.revision,
	algorithm: LIVE_POINTS_ALGORITHM_VERSION,
	input: hash({ entryPublicationId: entryPublication.publicationId, input: entry }),
});

const timesFor = (global: LivePublication, entryRead: EntryRead, now: string): LiveTimesV2 => {
	const entry = entryRead.input;
	const latestTimestamp = (...values: readonly (string | null | undefined)[]): string =>
		values
			.filter((value): value is string => iso(value))
			.sort()
			.at(-1) ?? global.sourceCheckedAt;
	const contentUpdatedAt = latestTimestamp(
		global.revisions.lifecycle.contentUpdatedAt,
		global.revisions.fixtureIdentity.contentUpdatedAt,
		global.revisions.scoreCore.contentUpdatedAt,
		global.revisions.displayStats.contentUpdatedAt,
		global.revisions.explain.contentUpdatedAt,
		global.revisions.rules.contentUpdatedAt,
		entry.picksBase.contentUpdatedAt,
		entryRead.publication.sourceCheckedAt,
		entryRead.publication.publishedAt
	);
	// Freshness is the freshness of the global live authority. Entry picks are
	// immutable/deadline-scoped inputs; a late entry publication must not make a
	// stale score core appear fresh.
	const sourceCheckedAt = global.sourceCheckedAt;
	const publishedAt = latestTimestamp(global.publishedAt, entryRead.publication.publishedAt);
	const staleAt = new Date(
		Date.parse(sourceCheckedAt) + LIVE_POINTS_FRESHNESS_SECONDS * 1000
	).toISOString();
	return {
		sourceCheckedAt,
		contentUpdatedAt,
		publishedAt,
		checkpointedAt: global.checkpointedAt,
		servedAt: now,
		staleAt,
		nextRefreshAt: global.expectedNextCheckAt,
	};
};

const buildReady = async (
	context: GraphQLContext,
	global: GlobalRead,
	entryRead: EntryRead,
	entry: Entry,
	core: CoreLiveIdentitySnapshot | null
): Promise<LiveCalcDataV2> => {
	if (!core) throw new Error("CORE_IDENTITY_UNAVAILABLE");
	const effectiveCore = core;
	const input = entryRead.input;
	if (input.finalResult !== null && global.publication.state !== "FINALIZED") {
		throw new Error("FINAL_RESULT_WITHOUT_FINALIZED_PUBLICATION");
	}
	if (global.publication.state === "FINALIZED" && input.finalResult === null) {
		throw new Error("FINAL_RESULT_REQUIRED");
	}
	const finalInput = global.publication.state === "FINALIZED" ? input.finalResult : null;
	const adjustmentMultipliers = new Map(
		(input.officialAdjustment?.multipliers ?? []).map(
			(item) => [item.element, item.multiplier] as const
		)
	);
	const baseProjectionPicks = finalInput?.picks ?? input.picksBase.picks;
	const projectionPicks =
		!finalInput && input.officialAdjustment
			? (baseProjectionPicks.map(
					(pick) =>
						({
							...pick,
							multiplier: adjustmentMultipliers.get(pick.element) ?? pick.multiplier,
						}) satisfies Pick
				) as Exactly15Picks)
			: baseProjectionPicks;
	const players = new Map(effectiveCore.players.map((player) => [player.id, player]));
	const teams = new Map(effectiveCore.teams.map((team) => [team.id, team]));
	const liveByElement = new Map(global.eventLives.map((row) => [row.elementId, row]));
	const fixtures = global.fixtures;
	const missingPlayers = projectionPicks.filter((pick) => !players.has(pick.element));
	const missingLiveRows = projectionPicks.filter((pick) => !liveByElement.has(pick.element));
	if (missingPlayers.length > 0 || missingLiveRows.length > 0) {
		throw new Error(
			`INCOMPLETE_ROSTER_OR_EVENT_LIVE players=${missingPlayers.length} rows=${missingLiveRows.length}`
		);
	}
	const eventPlayers = new Map<number, CorePlayerData>();
	for (const pick of projectionPicks) {
		const sourcePlayer = players.get(pick.element);
		const resolvedPlayer = sourcePlayer
			? eventPlayer(sourcePlayer, liveByElement.get(pick.element), fixtures)
			: null;
		if (!resolvedPlayer || !teams.has(resolvedPlayer.teamId)) {
			throw new Error(`EVENT_PLAYER_IDENTITY_UNAVAILABLE:${pick.element}`);
		}
		eventPlayers.set(pick.element, resolvedPlayer);
	}
	const chip = normalizeFplChip(input.picksBase.chip, "NONE") ?? "NONE";
	const publishedAdjustment = input.officialAdjustment;
	const lineup = finalInput
		? calculateFinalLineup(projectionPicks, liveByElement, finalInput.automaticSubs, chip)
		: publishedAdjustment
			? calculateFinalLineup(
					projectionPicks,
					liveByElement,
					publishedAdjustment.automaticSubs,
					chip
				)
			: calculateLineup(projectionPicks, eventPlayers, liveByElement, chip, fixtures);
	const rows = projectionPicks.map((pick) =>
		mapPick({
			season: global.publication.season,
			eventId: global.publication.eventId,
			pick,
			player: eventPlayers.get(pick.element)!,
			team: teams.get(eventPlayers.get(pick.element)!.teamId)!,
			fixtures,
			live: liveByElement.get(pick.element),
			lineup,
			teams,
		})
	);
	const calculatedEventPoints = rows.reduce(
		(total, row) => total + row.totalPoints * row.multiplier,
		0
	);
	const eventPoints = finalInput?.score.eventPoints ?? calculatedEventPoints;
	if (finalInput && calculatedEventPoints !== finalInput.score.eventPoints) {
		throw new Error("FINAL_RESULT_PROJECTION_MISMATCH");
	}
	const transferCost = input.picksBase.transferCost;
	const netEventPoints = eventPoints - transferCost;
	const previousTotals = input.previousTotals;
	const totalPoints = finalInput
		? finalInput.score.totalPoints
		: previousTotals
			? previousTotals.totalPoints + netEventPoints
			: null;
	const activeCaptain = lineup.activeCaptain;
	const captainRow = activeCaptain
		? rows.find((row) => row.element === activeCaptain.element)
		: null;
	const now = nowIso();
	const vector = revisionVector(global.publication, input, entryRead.publication);
	const times = timesFor(global.publication, entryRead, now);
	const delivery = deliveryFor(global, entryRead, now, core ? [] : ["CORE_IDENTITY_UNAVAILABLE"]);
	const score: LiveScoreV2 = {
		eventPoints,
		netEventPoints,
		totalPoints,
		totalScope: totalPoints === null ? "UNKNOWN" : "OVERALL",
		transferCost,
		source: finalInput ? "FPL_FINAL_RESULT" : "FPL_EVENT_LIVE",
		calculationMode: finalInput ? "FINAL_RESULT" : "PROJECTED_AUTOSUBS",
		revisions: vector,
		times,
		delivery,
	};
	const snapshot: LiveSnapshotMetaV2 = {
		season: global.publication.season,
		eventId: global.publication.eventId,
		state: global.publication.state,
		revisions: vector,
		times,
		delivery,
	};
	return {
		availability: "READY",
		delivery,
		snapshot,
		score,
		rank: {
			eventRank: null,
			// Rank is an independent low-priority publication.  Entry metadata is
			// mutable and is not a rank revision, so it must never leak an
			// unversioned or stale overall rank into an otherwise READY score.
			overallRank: null,
			leagueRank: null,
			revision: null,
			contentUpdatedAt: null,
			state: "UNAVAILABLE",
		},
		provisional: !finalInput,
		event: global.publication.eventId,
		entry: entry.id,
		entryName: entry.entryName,
		playerName: entry.playerName,
		region: entry.region,
		startedEvent: entry.startedEvent ?? 0,
		value: (entry.teamValue ?? 0) / 10,
		bank: (entry.bank ?? 0) / 10,
		teamValue: (entry.teamValue ?? 0) / 10,
		totalTransfers: entry.totalTransfers ?? 0,
		lastValue: (entry.lastTeamValue ?? 0) / 10,
		chip,
		played: rows.filter((row) => row.pickActive && row.isPlayed).length,
		toPlay: rows.filter((row) => row.pickActive && !row.isPlayed).length,
		playedCaptain: activeCaptain?.element ?? 0,
		captainName: captainRow?.webName ?? "",
		pickList: rows,
		activeCaptain: {
			id: activeCaptain?.element ?? 0,
			name: captainRow?.webName ?? "",
			points: captainRow?.totalPoints ?? 0,
		},
	};
};

const unavailableRevisionVector = (eventId: number): LiveRevisionVectorV2 => ({
	publicationId: `${UNAVAILABLE_REVISION}:${eventId}`,
	generation: 0,
	lifecycle: UNAVAILABLE_REVISION,
	fixtureIdentity: UNAVAILABLE_REVISION,
	scoreCore: UNAVAILABLE_REVISION,
	displayStats: UNAVAILABLE_REVISION,
	explain: UNAVAILABLE_REVISION,
	picksBase: null,
	officialAdjustment: null,
	previousTotals: null,
	finalResult: null,
	rules: UNAVAILABLE_REVISION,
	algorithm: LIVE_POINTS_ALGORITHM_VERSION,
	input: UNAVAILABLE_REVISION,
});

const emptyUnavailable = (
	context: GraphQLContext,
	eventId: number,
	entryId: number,
	availability: "PENDING" | "NO_PICKS" | "UNAVAILABLE",
	reason: string
): LiveCalcDataV2 => {
	const now = nowIso();
	const vector = unavailableRevisionVector(eventId);
	const times: LiveTimesV2 = {
		sourceCheckedAt: now,
		contentUpdatedAt: now,
		publishedAt: now,
		checkpointedAt: null,
		servedAt: now,
		staleAt: now,
		nextRefreshAt: null,
	};
	const delivery: LiveDeliveryV2 = {
		state: "UNAVAILABLE",
		servedFrom: "UNAVAILABLE",
		reasonCodes: [reason],
	};
	const score: LiveScoreV2 = {
		eventPoints: 0,
		netEventPoints: 0,
		totalPoints: null,
		totalScope: "UNKNOWN",
		transferCost: 0,
		source: "UNAVAILABLE",
		calculationMode: "PROJECTED_AUTOSUBS",
		revisions: vector,
		times,
		delivery,
	};
	return {
		availability,
		delivery,
		snapshot: {
			season: context.currentSeason.seasonCode,
			eventId,
			state: "UNAVAILABLE",
			revisions: vector,
			times,
			delivery,
		},
		score,
		rank: null,
		provisional: false,
		event: eventId,
		entry: entryId,
		entryName: "",
		playerName: "",
		region: null,
		startedEvent: 0,
		value: 0,
		bank: 0,
		teamValue: 0,
		totalTransfers: 0,
		lastValue: 0,
		chip: "NONE",
		played: 0,
		toPlay: 0,
		playedCaptain: 0,
		captainName: "",
		pickList: [],
		activeCaptain: { id: 0, name: "", points: 0 },
	};
};

const globalVector = (global: GlobalRead): LiveRevisionVectorV2 => ({
	publicationId: global.publication.publicationId,
	generation: global.publication.generation,
	lifecycle: global.publication.revisions.lifecycle.revision,
	fixtureIdentity: global.publication.revisions.fixtureIdentity.revision,
	scoreCore: global.publication.revisions.scoreCore.revision,
	displayStats: global.publication.revisions.displayStats.revision,
	explain: global.publication.revisions.explain.revision,
	picksBase: null,
	officialAdjustment: null,
	previousTotals: null,
	finalResult: null,
	rules: global.publication.revisions.rules.revision,
	algorithm: LIVE_POINTS_ALGORITHM_VERSION,
	input: UNAVAILABLE_REVISION,
});

const globalDelivery = (global: GlobalRead, reason: string): LiveDeliveryV2 => {
	const fallback = global.servedFrom !== "REDIS_CURRENT";
	const age = Date.now() - Date.parse(global.publication.sourceCheckedAt);
	const state: DeliveryState =
		global.publication.state === "FINALIZED"
			? "FINAL"
			: fallback
				? "DEGRADED"
				: age <= LIVE_POINTS_FRESHNESS_SECONDS * 1000
					? "FRESH"
					: "STALE";
	return {
		state,
		servedFrom: global.servedFrom,
		reasonCodes: [
			reason,
			...(fallback ? ["FALLBACK_SERVED"] : []),
			...(state === "STALE" ? ["SOURCE_OLDER_THAN_30_SECONDS"] : []),
		],
	};
};

/** Keep the complete global publication visible while one entry is pending. */
const emptyFromGlobal = (
	context: GraphQLContext,
	global: GlobalRead,
	eventId: number,
	entryId: number,
	availability: "PENDING" | "NO_PICKS" | "UNAVAILABLE",
	reason: string
): LiveCalcDataV2 => {
	const now = nowIso();
	const vector = globalVector(global);
	const delivery = globalDelivery(global, reason);
	const times: LiveTimesV2 = {
		sourceCheckedAt: global.publication.sourceCheckedAt,
		contentUpdatedAt: global.publication.revisions.scoreCore.contentUpdatedAt,
		publishedAt: global.publication.publishedAt,
		checkpointedAt: global.publication.checkpointedAt,
		servedAt: now,
		staleAt: new Date(
			Date.parse(global.publication.sourceCheckedAt) + LIVE_POINTS_FRESHNESS_SECONDS * 1000
		).toISOString(),
		nextRefreshAt: global.publication.expectedNextCheckAt,
	};
	const score: LiveScoreV2 = {
		eventPoints: 0,
		netEventPoints: 0,
		totalPoints: null,
		totalScope: "UNKNOWN",
		transferCost: 0,
		source: "UNAVAILABLE",
		calculationMode: "PROJECTED_AUTOSUBS",
		revisions: vector,
		times,
		delivery,
	};
	return {
		...emptyUnavailable(context, eventId, entryId, availability, reason),
		availability,
		delivery,
		snapshot: {
			season: global.publication.season,
			eventId,
			state: global.publication.state,
			revisions: vector,
			times,
			delivery,
		},
		score,
	};
};

const degradedLkg = (value: LiveCalcDataV2, reason: string): LiveCalcDataV2 => {
	const servedAt = nowIso();
	const delivery: LiveDeliveryV2 = {
		...value.delivery,
		state: "DEGRADED",
		servedFrom: "PROCESS_LKG",
		reasonCodes: [...new Set([...value.delivery.reasonCodes, reason])],
	};
	return {
		...value,
		delivery,
		score: { ...value.score, delivery, times: { ...value.score.times, servedAt } },
		snapshot: { ...value.snapshot, delivery, times: { ...value.snapshot.times, servedAt } },
	};
};

const readLiveLkg = (key: string): LiveCalcDataV2 | null => {
	const cached = liveLkg.get(key);
	if (!cached) return null;
	if (cached.expiresAt <= Date.now()) {
		liveLkg.delete(key);
		return null;
	}
	// Map insertion order is our bounded LRU order.
	liveLkg.delete(key);
	liveLkg.set(key, cached);
	return cached.value;
};

const writeLiveLkg = (key: string, value: LiveCalcDataV2): void => {
	liveLkg.delete(key);
	liveLkg.set(key, { value, expiresAt: Date.now() + LIVE_LKG_RETENTION_MS });
	while (liveLkg.size > LIVE_LKG_MAX_ENTRIES) {
		const oldest = liveLkg.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		liveLkg.delete(oldest);
	}
};

export const clearLivePointsV2Lkg = (): void => liveLkg.clear();

export const loadLiveSnapshotMetaV2 = async (
	context: GraphQLContext,
	eventId: number
): Promise<LiveSnapshotMetaV2 | null> => {
	const global = await readGlobal(context, eventId);
	if (global) {
		const now = nowIso();
		const vector: LiveRevisionVectorV2 = {
			publicationId: global.publication.publicationId,
			generation: global.publication.generation,
			lifecycle: global.publication.revisions.lifecycle.revision,
			fixtureIdentity: global.publication.revisions.fixtureIdentity.revision,
			scoreCore: global.publication.revisions.scoreCore.revision,
			displayStats: global.publication.revisions.displayStats.revision,
			explain: global.publication.revisions.explain.revision,
			picksBase: null,
			officialAdjustment: null,
			previousTotals: null,
			finalResult: null,
			rules: global.publication.revisions.rules.revision,
			algorithm: LIVE_POINTS_ALGORITHM_VERSION,
			input: UNAVAILABLE_REVISION,
		};
		const times: LiveTimesV2 = {
			sourceCheckedAt: global.publication.sourceCheckedAt,
			contentUpdatedAt: global.publication.revisions.scoreCore.contentUpdatedAt,
			publishedAt: global.publication.publishedAt,
			checkpointedAt: global.publication.checkpointedAt,
			servedAt: now,
			staleAt: new Date(
				Date.parse(global.publication.sourceCheckedAt) + LIVE_POINTS_FRESHNESS_SECONDS * 1000
			).toISOString(),
			nextRefreshAt: global.publication.expectedNextCheckAt,
		};
		const fallback = global.servedFrom !== "REDIS_CURRENT";
		const state: DeliveryState =
			global.publication.state === "FINALIZED"
				? "FINAL"
				: fallback
					? "DEGRADED"
					: Date.now() - Date.parse(global.publication.sourceCheckedAt) <=
						  LIVE_POINTS_FRESHNESS_SECONDS * 1000
						? "FRESH"
						: "STALE";
		const delivery: LiveDeliveryV2 = {
			state,
			servedFrom: global.servedFrom,
			reasonCodes: fallback ? ["FALLBACK_SERVED"] : [],
		};
		return {
			season: global.publication.season,
			eventId,
			state: global.publication.state,
			revisions: vector,
			times,
			delivery,
		};
	}
	return null;
};

const observeLivePointsResult = (result: LiveCalcDataV2): LiveCalcDataV2 => {
	metrics.livePointsDeliveryTotal.labels(result.delivery.state, result.delivery.servedFrom).inc();
	return result;
};

export const calcLivePointsByEntryV2 = async (
	context: GraphQLContext,
	eventId: number,
	entryId: number,
	options: { scoreCoreRevision?: string } = {}
): Promise<LiveCalcDataV2> => {
	if (
		!Number.isSafeInteger(eventId) ||
		eventId <= 0 ||
		!Number.isSafeInteger(entryId) ||
		entryId <= 0
	)
		return observeLivePointsResult(
			emptyUnavailable(context, eventId, entryId, "UNAVAILABLE", "INVALID_SCOPE")
		);
	const lkgKey = [
		context.currentSeason.seasonCode,
		eventId,
		entryId,
		options.scoreCoreRevision ?? "current",
	].join(":");
	const redisGlobal = await readRedisGlobal(context, eventId, options.scoreCoreRevision);
	const processLkg = readLiveLkg(lkgKey);
	// The fallback order is intentional: a process LKG is a complete response
	// for this exact event/entry and is safer than a cold database read that may
	// combine metadata from a different publication.
	const global =
		redisGlobal ??
		(processLkg
			? null
			: await readDatabaseGlobalMemoized(context, eventId, options.scoreCoreRevision));
	if (!global) {
		return observeLivePointsResult(
			processLkg
				? degradedLkg(processLkg, "GLOBAL_PUBLICATION_UNAVAILABLE")
				: emptyUnavailable(
						context,
						eventId,
						entryId,
						"UNAVAILABLE",
						"GLOBAL_PUBLICATION_UNAVAILABLE"
					)
		);
	}
	const redisEntry = await readRedisEntry(context, eventId, entryId);
	const entryRead =
		redisEntry ??
		(processLkg
			? null
			: await readDatabaseEntry(context, context.currentSeason.seasonCode, eventId, entryId));
	if (!entryRead) {
		return observeLivePointsResult(
			processLkg
				? degradedLkg(processLkg, "ENTRY_INPUT_PENDING")
				: emptyFromGlobal(context, global, eventId, entryId, "PENDING", "ENTRY_INPUT_PENDING")
		);
	}
	const core = await readCore(context);
	try {
		const result = await buildReady(
			context,
			global,
			entryRead,
			await getEntrySafe(context, entryId),
			core
		);
		writeLiveLkg(lkgKey, result);
		return observeLivePointsResult(result);
	} catch (error) {
		context.logger.error({ err: error, eventId, entryId }, "Live Points V2 projection failed");
		metrics.livePointsProjectionFailures.labels("PROJECTION_FAILED").inc();
		const reason =
			error instanceof Error && error.message === "CORE_IDENTITY_UNAVAILABLE"
				? "CORE_IDENTITY_UNAVAILABLE"
				: "PROJECTION_FAILED";
		return observeLivePointsResult(
			processLkg
				? degradedLkg(processLkg, reason)
				: emptyUnavailable(context, eventId, entryId, "UNAVAILABLE", reason)
		);
	}
};

export const calcLivePointsForEntriesV2 = async (
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[],
	options: { scoreCoreRevision?: string } = {}
): Promise<BatchLiveCalcResultV2> => {
	const uniqueIds = [...new Set(entryIds)];
	const results = new Map<number, LiveCalcDataV2>();
	const errors: Array<{ entryId: number; message: string }> = [];
	// Entry metadata batching relies on the request's pinned Core identity
	// revision. Establish that identity before issuing the batch read.
	await readCore(context);
	await preloadEntryMetadata(context, uniqueIds);
	const concurrency = Math.min(32, Math.max(1, uniqueIds.length));
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= uniqueIds.length) return;
			const entryId = uniqueIds[index]!;
			try {
				results.set(entryId, await calcLivePointsByEntryV2(context, eventId, entryId, options));
			} catch (error) {
				errors.push({
					entryId,
					message: error instanceof Error ? error.message : "Live Points V2 calculation failed",
				});
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	const ordered = new Map<number, LiveCalcDataV2>();
	for (const entryId of entryIds) {
		const result = results.get(entryId);
		if (result) ordered.set(entryId, result);
	}
	return {
		results: ordered,
		errors: errors.sort((left, right) => left.entryId - right.entryId),
		meta: {
			eventId,
			totalEntries: entryIds.length,
			succeededCount: ordered.size,
			failedCount: errors.length,
		},
	};
};
