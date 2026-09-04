import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { QueryResultRow } from "pg";

import { normalizeFplChip, type CanonicalFplChip } from "../../contracts/fpl-chip";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import type { Entry } from "../../contracts/entry";
import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreLiveIdentitySnapshot,
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	type CoreFixtureSnapshot,
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
/** Fallback only for publications without a valid producer cadence boundary. */
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
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "PROCESS_LKG" | "POSTGRES_CHECKPOINT";
};

export type LivePublicationReadV2 = GlobalRead;

export type LivePublicationRefV2 = Readonly<{
	publicationId: string;
	generation: number;
}>;

type EntryRead = {
	publication: EntryPublication;
	input: EntryLiveInput;
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "PROCESS_LKG" | "POSTGRES_CHECKPOINT";
};

const GLOBAL_LKG_MAX_BYTES = 64 * 1024 * 1024;
const globalLkg = new Map<string, { value: GlobalRead; bytes: number }>();
let globalLkgBytes = 0;

const globalLkgKey = (
	context: GraphQLContext,
	eventId: number,
	publication: LivePublication
): string =>
	`${context.currentSeason.seasonCode}:${eventId}:${publication.publicationId}:${publication.generation}`;

const rememberGlobalLkg = (context: GraphQLContext, eventId: number, value: GlobalRead): void => {
	const key = globalLkgKey(context, eventId, value.publication);
	const bytes = Buffer.byteLength(stable(value), "utf8");
	const existing = globalLkg.get(key);
	if (existing) globalLkgBytes -= existing.bytes;
	globalLkg.delete(key);
	if (bytes > GLOBAL_LKG_MAX_BYTES) return;
	globalLkg.set(key, { value, bytes });
	globalLkgBytes += bytes;
	while (globalLkgBytes > GLOBAL_LKG_MAX_BYTES && globalLkg.size > 0) {
		const oldest = globalLkg.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		const removed = globalLkg.get(oldest);
		globalLkg.delete(oldest);
		if (removed) globalLkgBytes -= removed.bytes;
	}
};

const readGlobalLkg = (
	context: GraphQLContext,
	eventId: number,
	expectedScoreCoreRevision: string | undefined,
	expectedPublicationRef: LivePublicationRefV2 | undefined
): GlobalRead | null => {
	for (const key of [...globalLkg.keys()].reverse()) {
		const cached = globalLkg.get(key);
		if (!cached) continue;
		if (!key.startsWith(`${context.currentSeason.seasonCode}:${eventId}:`)) continue;
		const publication = cached.value.publication;
		if (
			(expectedScoreCoreRevision === undefined ||
				publication.revisions.scoreCore.revision === expectedScoreCoreRevision) &&
			matchesPublicationRef(publication, expectedPublicationRef)
		) {
			globalLkg.delete(key);
			globalLkg.set(key, cached);
			return { ...cached.value, servedFrom: "PROCESS_LKG" };
		}
	}
	return null;
};

type EntryMetadataRead = Readonly<{
	entry: Entry;
	available: boolean;
}>;

const entryMatchesGlobal = (entry: EntryRead, global: GlobalRead): boolean => {
	const finalized = global.publication.state === "FINALIZED";
	return finalized
		? entry.publication.state === "FINAL" && entry.input.finalResult !== null
		: entry.publication.state === "PROVISIONAL" && entry.input.finalResult === null;
};

const matchesPublicationRef = (
	publication: LivePublication,
	expected?: LivePublicationRefV2
): boolean =>
	expected === undefined ||
	(publication.publicationId === expected.publicationId &&
		publication.generation === expected.generation);

const lkgMatchesGlobal = (value: LiveCalcDataV2, global: GlobalRead): boolean => {
	const matchesRevision = (vector: LiveRevisionVectorV2): boolean =>
		vector.publicationId === global.publication.publicationId &&
		vector.generation === global.publication.generation &&
		vector.lifecycle === global.publication.revisions.lifecycle.revision &&
		vector.fixtureIdentity === global.publication.revisions.fixtureIdentity.revision &&
		vector.scoreCore === global.publication.revisions.scoreCore.revision &&
		vector.displayStats === global.publication.revisions.displayStats.revision &&
		vector.explain === global.publication.revisions.explain.revision &&
		vector.rules === global.publication.revisions.rules.revision &&
		vector.algorithm === LIVE_POINTS_ALGORITHM_VERSION;
	return (
		value.event === global.publication.eventId &&
		value.snapshot.season === global.publication.season &&
		value.snapshot.eventId === global.publication.eventId &&
		value.snapshot.state === global.publication.state &&
		matchesRevision(value.snapshot.revisions) &&
		matchesRevision(value.score.revisions) &&
		(global.publication.state === "FINALIZED"
			? value.score.calculationMode === "FINAL_RESULT"
			: value.score.calculationMode === "PROJECTED_AUTOSUBS")
	);
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
const requestEventRosterMemo = new WeakMap<
	object,
	Map<number, Promise<ReadonlySet<number> | null>>
>();
const requestEventPlayerMemo = new WeakMap<
	object,
	Map<number, Promise<ReadonlyMap<number, CorePlayerData>>>
>();
const requestCoreMemo = new WeakMap<object, Promise<CoreLiveIdentitySnapshot | null>>();
const requestCoreFixtureMemo = new WeakMap<object, Promise<CoreFixtureSnapshot | null>>();
const requestEntryMemo = new WeakMap<object, Map<number, Promise<EntryMetadataRead>>>();
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
	safeInteger(value.element) !== null &&
	(safeInteger(value.element) as number) > 0 &&
	safeInteger(value.position) !== null &&
	(safeInteger(value.position) as number) >= 1 &&
	(safeInteger(value.position) as number) <= 15 &&
	safeInteger(value.multiplier) !== null &&
	(safeInteger(value.multiplier) as number) >= 0 &&
	(safeInteger(value.multiplier) as number) <= 3 &&
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
		const inElement = safeInteger(item.inElement);
		const outElement = safeInteger(item.outElement);
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
	(expectedThroughEventId !== 0 || (safeInteger(value.totalPoints) as number) === 0) &&
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
			safeInteger(item.element) !== null &&
			(safeInteger(item.element) as number) > 0 &&
			safeInteger(item.multiplier) !== null &&
			(safeInteger(item.multiplier) as number) >= 0 &&
			(safeInteger(item.multiplier) as number) <= 3
	) &&
	Array.isArray(value.automaticSubs) &&
	validAutomaticSubs(value.automaticSubs);

const validFinalResult = (value: unknown): value is NonNullable<EntryLiveInput["finalResult"]> => {
	if (
		!isRecord(value) ||
		!validRevisionOnly(value) ||
		!isRecord(value.score) ||
		safeInteger(value.score.eventPoints) === null ||
		(value.score.totalPoints !== null && safeInteger(value.score.totalPoints) === null) ||
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
		(picksBase.chip !== null &&
			(typeof picksBase.chip !== "string" || normalizeFplChip(picksBase.chip, null) === null)) ||
		safeInteger(picksBase.transferCost) === null ||
		(safeInteger(picksBase.transferCost) as number) < 0
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
		hasUniquePositiveIds(rows, (row) => safeInteger(row.elementId)) &&
		rows.every(
			(row) =>
				safeInteger(row.eventId) !== null &&
				safeInteger(row.elementId) !== null &&
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
		hasUniquePositiveIds(rows, (row) => safeInteger(row.id)) &&
		rows.every(
			(row) =>
				(safeInteger(row.code) ?? 0) > 0 &&
				(row.event === null || (safeInteger(row.event) ?? 0) > 0) &&
				typeof row.finished === "boolean" &&
				typeof row.finishedProvisional === "boolean" &&
				nullableStringField(row, "kickoffTime") &&
				(safeInteger(row.minutes) ?? -1) >= 0 &&
				nullableBooleanField(row, "started") &&
				(safeInteger(row.teamH) ?? 0) > 0 &&
				(safeInteger(row.teamA) ?? 0) > 0 &&
				(row.teamHScore === null || safeInteger(row.teamHScore) !== null) &&
				(row.teamAScore === null || safeInteger(row.teamAScore) !== null) &&
				(row.teamHDifficulty === null || safeInteger(row.teamHDifficulty) !== null) &&
				(row.teamADifficulty === null || safeInteger(row.teamADifficulty) !== null)
		)
	);
};

const isEntryInput =
	(season: string, eventId: number, entryId: number) =>
	(value: unknown): value is EntryLiveInput =>
		validInput(value, season, eventId, entryId);

/**
 * Validate an entry input embedded in a league publication.  League readers
 * use this boundary before projecting an H2H side, so malformed inline input
 * cannot turn into a zero score or a synthetic missing entry.
 */
export const isPublishedEntryLiveInputV2 = (
	value: unknown,
	season: string,
	eventId: number,
	entryId: number
): boolean => validInput(value, season, eventId, entryId);

const hasCompleteEventLiveRoster = (
	eventLives: readonly EventLiveRow[],
	expectedPlayerIds: ReadonlySet<number>
): boolean => {
	// Core is the authoritative minimum roster for the active season. Older
	// event publications may also retain an event-only player identity that is
	// no longer present in the current core slice, so extra rows are allowed;
	// every authoritative core player must still be present.
	if (expectedPlayerIds.size === 0 || eventLives.length < expectedPlayerIds.size) return false;
	const actualPlayerIds = new Set(eventLives.map((row) => row.elementId));
	return [...expectedPlayerIds].every((playerId) => actualPlayerIds.has(playerId));
};

const hasCompleteFixtureCoverage = (
	fixtures: readonly FixtureRow[],
	expectedFixtureIds: ReadonlySet<number>
): boolean => {
	const actualFixtureIds = new Set(fixtures.map((fixture) => fixture.id));
	return (
		actualFixtureIds.size === expectedFixtureIds.size &&
		[...expectedFixtureIds].every((fixtureId) => actualFixtureIds.has(fixtureId))
	);
};

/**
 * Historical event-live rows must be checked against the player set that
 * existed at that event, not today's mutable core roster.  The Data producer
 * publishes this event-scoped snapshot only after its complete-set header is
 * verified; this direct read is a request-local expectation lookup and never
 * gates the hot Redis path on PostgreSQL availability.
 */
export const EVENT_ROSTER_SQL = `
	SELECT
		snapshot.event_id,
		snapshot.element_id,
		publication.row_count AS publication_row_count,
		publication.expected_row_count AS publication_expected_row_count
	FROM fpl.player_event_snapshot_publications publication
	JOIN fpl.player_event_snapshots snapshot
	  ON snapshot.season_id = publication.season_id
	 AND snapshot.event_id = publication.event_id
	WHERE publication.season_id = $1
	  AND publication.event_id = ANY($2::integer[])
	  AND publication.row_count = publication.expected_row_count
	  AND publication.row_count > 0
	  AND (publication.event_id <> 1 OR publication.baseline_verified_at IS NOT NULL)
	ORDER BY snapshot.event_id, snapshot.element_id
`;

/**
 * Event-time player identity is only used when the mutable Core identity slice
 * no longer contains a historical pick.  The complete publication header and
 * event-scoped snapshot are the authority; current player metadata supplies
 * labels that are not retained in player_event_snapshots itself, while an
 * event fixture row supplies the historical club when available.
 */
export const EVENT_PLAYER_IDENTITY_SQL = `
	SELECT
		snapshot.event_id,
		snapshot.element_id,
		snapshot.element_type AS event_element_type,
		snapshot.selected_by_percent,
		publication.row_count AS publication_row_count,
		publication.expected_row_count AS publication_expected_row_count,
		player.code,
		player.web_name,
		player.first_name,
		player.second_name,
		COALESCE(event_fixture.team_id, player.team_id) AS team_id,
		player.price,
		player.start_price,
		player.total_points
	FROM fpl.player_event_snapshot_publications publication
	JOIN fpl.player_event_snapshots snapshot
	  ON snapshot.season_id = publication.season_id
	 AND snapshot.event_id = publication.event_id
	JOIN fpl.players player
	  ON player.season_id = snapshot.season_id
	 AND player.element_id = snapshot.element_id
	LEFT JOIN LATERAL (
		SELECT stats.team_id
		FROM fpl.player_fixture_stats stats
		WHERE stats.season_id = snapshot.season_id
		  AND stats.event_id = snapshot.event_id
		  AND stats.element_id = snapshot.element_id
		ORDER BY stats.fixture_id
		LIMIT 1
	) event_fixture ON TRUE
	WHERE publication.season_id = $1
	  AND publication.event_id = $2
	  AND publication.row_count = publication.expected_row_count
	  AND publication.row_count > 0
	  AND (publication.event_id <> 1 OR publication.baseline_verified_at IS NOT NULL)
	ORDER BY snapshot.element_id
`;

const decodeRedisGlobalCandidate = (
	raw: string | null,
	values: readonly (string | null)[],
	season: string,
	eventId: number,
	pointer: "active" | "previous",
	expectedPlayerIds?: ReadonlySet<number>,
	expectedFixtureIds?: ReadonlySet<number> | null
): GlobalRead | null => {
	const publication = parseLivePublication(raw, season, eventId);
	if (!publication || values.length !== 4) return null;
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
		fixtures.some((row) => row.event !== null && row.event !== eventId) ||
		(expectedPlayerIds !== undefined &&
			!hasCompleteEventLiveRoster(eventLives, expectedPlayerIds)) ||
		expectedFixtureIds === null ||
		(expectedFixtureIds !== undefined && !hasCompleteFixtureCoverage(fixtures, expectedFixtureIds))
	)
		return null;
	return {
		publication,
		eventLives,
		fixtures,
		servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS",
	};
};

const readRedisGlobalCandidate = async (
	redis: Redis,
	season: string,
	eventId: number,
	pointer: "active" | "previous",
	expectedPlayerIds?: ReadonlySet<number>,
	expectedFixtureIds?: ReadonlySet<number> | null
): Promise<GlobalRead | null> => {
	const raw = await redis.get(liveKey(season, eventId, pointer));
	const publication = parseLivePublication(raw, season, eventId);
	if (!publication) return null;
	const values = await redis.mget(
		publication.items.eventLive.key,
		publication.items.fixtures.key,
		`${publication.items.eventLive.key}:meta`,
		`${publication.items.fixtures.key}:meta`
	);
	return decodeRedisGlobalCandidate(
		raw,
		values,
		season,
		eventId,
		pointer,
		expectedPlayerIds,
		expectedFixtureIds
	);
};

const readRedisGlobalCandidates = async (
	redis: Redis,
	season: string,
	eventIds: readonly number[],
	pointer: "active" | "previous",
	expectedPlayerIdsByEvent: ReadonlyMap<number, ReadonlySet<number> | undefined>,
	expectedFixtureIdsByEvent: ReadonlyMap<number, ReadonlySet<number> | null | undefined>
): Promise<Map<number, GlobalRead>> => {
	const uniqueEventIds = [...new Set(eventIds)];
	if (uniqueEventIds.length === 0) return new Map();
	const pointerValues = await redis.mget(
		...uniqueEventIds.map((eventId) => liveKey(season, eventId, pointer))
	);
	const publications = uniqueEventIds.flatMap((eventId, index) => {
		const raw = pointerValues[index] ?? null;
		const publication = parseLivePublication(raw, season, eventId);
		return publication ? [{ eventId, raw, publication }] : [];
	});
	if (publications.length === 0) return new Map();
	const payloadKeys = publications.flatMap(({ publication }) => [
		publication.items.eventLive.key,
		publication.items.fixtures.key,
		`${publication.items.eventLive.key}:meta`,
		`${publication.items.fixtures.key}:meta`,
	]);
	const payloadValues = await redis.mget(...payloadKeys);
	const result = new Map<number, GlobalRead>();
	publications.forEach(({ eventId, raw }, index) => {
		const candidate = decodeRedisGlobalCandidate(
			raw,
			payloadValues.slice(index * 4, index * 4 + 4),
			season,
			eventId,
			pointer,
			expectedPlayerIdsByEvent.get(eventId),
			expectedFixtureIdsByEvent.get(eventId)
		);
		if (candidate) result.set(eventId, candidate);
	});
	return result;
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
		SELECT entry_id, publication_id, generation, picks_base_revision, content_sha256, row_count,
			source_checked_at, content_updated_at, checkpointed_at, state
		FROM competition.entry_event_pick_heads
		WHERE season_id = $1 AND entry_id = ANY($2::integer[]) AND event_id = $3 AND state = 'COMPLETE'
	), picks AS (
		SELECT p.entry_id, p.position, p.element_id, p.multiplier, p.is_captain, p.is_vice_captain,
			p.active_chip, p.transfers_cost
		FROM competition.entry_event_picks p
		WHERE p.season_id = $1 AND p.entry_id = ANY($2::integer[]) AND p.event_id = $3
	), final_result AS (
		SELECT DISTINCT ON (result.entry_id) result.entry_id, result.event_points, result.overall_points, result.event_picks,
			result.automatic_substitutions, result.rich_synced_at, event.data_checked_at
		FROM competition.entry_event_results result
		JOIN fpl.events event
			ON event.season_id = result.season_id AND event.event_id = result.event_id
		WHERE result.season_id = $1
			AND result.entry_id = ANY($2::integer[])
			AND result.event_id = $3
			AND result.rich_synced_at IS NOT NULL
			AND event.finished = true
			AND event.data_checked = true
			AND (event.data_checked_at IS NULL OR result.rich_synced_at >= event.data_checked_at)
		ORDER BY result.entry_id, result.rich_synced_at DESC
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
	FROM head LEFT JOIN picks ON picks.entry_id = head.entry_id
		LEFT JOIN final_result ON final_result.entry_id = head.entry_id
	GROUP BY head.entry_id, head.publication_id, head.generation, head.picks_base_revision, head.content_sha256,
		head.row_count, head.source_checked_at, head.content_updated_at, head.checkpointed_at, head.state,
		final_result.entry_id, final_result.event_points, final_result.overall_points, final_result.event_picks,
		final_result.automatic_substitutions, final_result.rich_synced_at, final_result.data_checked_at
`;

/** Exact SQL/result-shape probes for the V2 PostgreSQL fallback reader. */
export const LIVE_POINTS_V2_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "live-points-v2.event-roster",
		sql: EVENT_ROSTER_SQL,
		values: [2026, [1]],
		resultTypes: [
			{ relation: "fpl.player_event_snapshots", column: "event_id", pgType: "integer" },
			{ relation: "fpl.player_event_snapshots", column: "element_id", pgType: "integer" },
			{
				relation: "fpl.player_event_snapshot_publications",
				column: "row_count",
				pgType: "integer",
			},
			{
				relation: "fpl.player_event_snapshot_publications",
				column: "expected_row_count",
				pgType: "integer",
			},
		],
	},
	{
		name: "live-points-v2.event-player-identity",
		sql: EVENT_PLAYER_IDENTITY_SQL,
		values: [2026, 1],
		resultTypes: [
			{ relation: "fpl.player_event_snapshots", column: "event_id", pgType: "integer" },
			{ relation: "fpl.player_event_snapshots", column: "element_id", pgType: "integer" },
			{ relation: "fpl.player_event_snapshots", column: "element_type", pgType: "integer" },
			{ relation: "fpl.player_event_snapshots", column: "selected_by_percent", pgType: "numeric" },
			{
				relation: "fpl.player_event_snapshot_publications",
				column: "row_count",
				pgType: "integer",
			},
			{
				relation: "fpl.player_event_snapshot_publications",
				column: "expected_row_count",
				pgType: "integer",
			},
			{ relation: "fpl.players", column: "code", pgType: "integer" },
			{
				relation: "fpl.players",
				column: "web_name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "fpl.players",
				column: "first_name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "fpl.players",
				column: "second_name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{ relation: "fpl.players", column: "team_id", pgType: "integer" },
			{ relation: "fpl.players", column: "price", pgType: "integer" },
			{ relation: "fpl.players", column: "start_price", pgType: "integer" },
			{ relation: "fpl.players", column: "total_points", pgType: "integer" },
			{ relation: "fpl.player_fixture_stats", column: "team_id", pgType: "integer" },
		],
	},
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
		values: [2026, [6953], 1],
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
	eventId: number,
	expectedFixtureIds: ReadonlySet<number> | null
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
			fixtures.some((fixture) => fixture.event !== null && fixture.event !== eventId) ||
			expectedFixtureIds === null ||
			!hasCompleteFixtureCoverage(fixtures, expectedFixtureIds)
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

const parseDatabaseEntryRow = (
	season: string,
	eventId: number,
	entryId: number,
	row: Row | undefined
): EntryRead | null => {
	try {
		if (
			!row ||
			integer(row.entry_id) !== entryId ||
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
			(finalTotalPoints === null || Number.isSafeInteger(finalTotalPoints)) &&
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
	} catch {
		return null;
	}
};

const readDatabaseEntry = async (
	context: GraphQLContext,
	season: string,
	eventId: number,
	entryId: number,
	global: GlobalRead
): Promise<EntryRead | null> => {
	try {
		const result = await context.database.query<Row>(ENTRY_CHECKPOINT_SQL, [
			context.currentSeason.seasonId,
			[entryId],
			eventId,
		]);
		const parsed = parseDatabaseEntryRow(season, eventId, entryId, result.rows[0]);
		return parsed && entryMatchesGlobal(parsed, global) ? parsed : null;
	} catch (error) {
		context.logger.warn(
			{ err: error, entryId, eventId },
			"Entry Live Points V2 PostgreSQL checkpoint unavailable"
		);
		return null;
	}
};

const readDatabaseEntries = async (
	context: GraphQLContext,
	season: string,
	eventId: number,
	entryIds: readonly number[],
	global: GlobalRead
): Promise<Map<number, EntryRead>> => {
	const uniqueIds = [...new Set(entryIds)].filter(
		(entryId) => Number.isSafeInteger(entryId) && entryId > 0
	);
	if (uniqueIds.length === 0) return new Map();
	try {
		const result = await context.database.query<Row>(ENTRY_CHECKPOINT_SQL, [
			context.currentSeason.seasonId,
			uniqueIds,
			eventId,
		]);
		const requested = new Set(uniqueIds);
		const entries = new Map<number, EntryRead>();
		for (const row of result.rows) {
			const entryId = integer(row.entry_id);
			if (entryId === null || !requested.has(entryId)) continue;
			const parsed = parseDatabaseEntryRow(season, eventId, entryId, row);
			if (parsed && entryMatchesGlobal(parsed, global)) entries.set(entryId, parsed);
		}
		return entries;
	} catch (error) {
		context.logger.warn(
			{ err: error, entryCount: uniqueIds.length, eventId },
			"Entry Live Points V2 PostgreSQL checkpoint batch unavailable"
		);
		return new Map();
	}
};

const requestScope = (context: GraphQLContext): object => context.requestScope ?? context;

const entryMetadataKey = (context: GraphQLContext, entryId: number): string =>
	`${context.currentSeason.seasonCode}:${entryId}`;

const readRedisGlobal = (
	context: GraphQLContext,
	eventId: number,
	expectedPlayerIds: ReadonlySet<number> | undefined,
	expectedFixtureIds: ReadonlySet<number> | null | undefined,
	expectedScoreCoreRevision?: string,
	expectedPublicationRef?: LivePublicationRefV2
): Promise<GlobalRead | null> => {
	const scope = requestScope(context);
	let memo = requestRedisGlobalMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestRedisGlobalMemo.set(scope, memo);
	}
	// Roster validation is part of the read contract. Keep differently sized or
	// revisioned event/core rosters from sharing a memoized publication result.
	// A historical event without an available event roster deliberately relies on
	// the producer's complete publication proof instead of today's core roster.
	const rosterRevision = expectedPlayerIds
		? hash([...expectedPlayerIds].sort((left, right) => left - right))
		: "producer-validated";
	const fixtureRevision =
		expectedFixtureIds === undefined
			? "unchecked"
			: expectedFixtureIds === null
				? "authority-unavailable"
				: hash([...expectedFixtureIds].sort((left, right) => left - right));
	const memoKey =
		String(eventId) +
		":" +
		(expectedScoreCoreRevision ?? "current") +
		":" +
		(expectedPublicationRef
			? `${expectedPublicationRef.publicationId}:${expectedPublicationRef.generation}`
			: "any-publication") +
		":" +
		rosterRevision +
		":" +
		fixtureRevision;
	const existing = memo.get(memoKey);
	if (existing) return existing;
	const load = (async (): Promise<GlobalRead | null> => {
		const season = context.currentSeason.seasonCode;
		try {
			const redis = context.redis;
			const redisValue = await readRedisGlobalCandidate(
				redis,
				season,
				eventId,
				"active",
				expectedPlayerIds,
				expectedFixtureIds
			);
			if (
				redisValue &&
				(expectedScoreCoreRevision === undefined ||
					redisValue.publication.revisions.scoreCore.revision === expectedScoreCoreRevision) &&
				matchesPublicationRef(redisValue.publication, expectedPublicationRef)
			)
				return redisValue;
			const previous = await readRedisGlobalCandidate(
				redis,
				season,
				eventId,
				"previous",
				expectedPlayerIds,
				expectedFixtureIds
			);
			if (
				previous &&
				(expectedScoreCoreRevision === undefined ||
					previous.publication.revisions.scoreCore.revision === expectedScoreCoreRevision) &&
				matchesPublicationRef(previous.publication, expectedPublicationRef)
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
	expectedFixtureIds: ReadonlySet<number> | null,
	expectedScoreCoreRevision?: string,
	expectedPublicationRef?: LivePublicationRefV2
): Promise<GlobalRead | null> => {
	const scope = requestScope(context);
	let memo = requestDatabaseGlobalMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestDatabaseGlobalMemo.set(scope, memo);
	}
	const fixtureRevision =
		expectedFixtureIds === null
			? "authority-unavailable"
			: hash([...expectedFixtureIds].sort((left, right) => left - right));
	const memoKey =
		String(eventId) +
		":" +
		(expectedScoreCoreRevision ?? "current") +
		":" +
		(expectedPublicationRef
			? `${expectedPublicationRef.publicationId}:${expectedPublicationRef.generation}`
			: "any-publication") +
		":" +
		fixtureRevision;
	const existing = memo.get(memoKey);
	if (existing) return existing;
	const load = readDatabaseGlobal(
		context,
		context.currentSeason.seasonCode,
		eventId,
		expectedFixtureIds
	).then((value) =>
		value &&
		(expectedScoreCoreRevision === undefined ||
			value.publication.revisions.scoreCore.revision === expectedScoreCoreRevision) &&
		matchesPublicationRef(value.publication, expectedPublicationRef)
			? value
			: null
	);
	memo.set(memoKey, load);
	return load;
};

const requireCompleteGlobalRoster = (
	context: GraphQLContext,
	global: GlobalRead | null,
	expectedPlayerIds?: ReadonlySet<number>
): GlobalRead | null => {
	if (
		!global ||
		!expectedPlayerIds ||
		hasCompleteEventLiveRoster(global.eventLives, expectedPlayerIds)
	)
		return global;
	metrics.livePublicationEventsTotal.labels("roster_incomplete").inc();
	context.logger.warn(
		{
			eventId: global.publication.eventId,
			actualPlayerCount: global.eventLives.length,
			expectedPlayerCount: expectedPlayerIds.size,
		},
		"Live Points V2 publication has incomplete event-live roster"
	);
	return null;
};

const requireCompleteGlobalPublication = (
	context: GraphQLContext,
	global: GlobalRead | null,
	expectedPlayerIds: ReadonlySet<number> | undefined,
	expectedFixtureIds: ReadonlySet<number> | null
): GlobalRead | null => {
	if (!global || expectedFixtureIds === null) return null;
	const rosterChecked = requireCompleteGlobalRoster(context, global, expectedPlayerIds);
	if (!rosterChecked) return null;
	if (hasCompleteFixtureCoverage(rosterChecked.fixtures, expectedFixtureIds)) {
		return rosterChecked;
	}
	metrics.livePublicationEventsTotal.labels("fixture_incomplete").inc();
	context.logger.warn(
		{
			eventId: rosterChecked.publication.eventId,
			actualFixtureCount: rosterChecked.fixtures.length,
			expectedFixtureCount: expectedFixtureIds.size,
		},
		"Live Points V2 publication has incomplete fixture coverage"
	);
	return null;
};

const readGlobal = async (
	context: GraphQLContext,
	eventId: number,
	expectedScoreCoreRevision?: string,
	expectedPublicationRef?: LivePublicationRefV2
): Promise<GlobalRead | null> => {
	// An exact publication reference is already a producer-side coherence
	// decision.  Read that Redis snapshot before consulting the mutable Core
	// read model so a warm league board remains available during a PostgreSQL
	// incident.  The complete projection still validates Core when it needs to
	// calculate an uncached row; this boundary only prevents an avoidable DB
	// dependency from hiding a valid publication or a warmed projection cache.
	if (expectedPublicationRef) {
		const exactRedis = await readRedisGlobal(
			context,
			eventId,
			undefined,
			undefined,
			expectedScoreCoreRevision,
			expectedPublicationRef
		);
		if (exactRedis) {
			// The producer has already accepted this immutable publication as a
			// coherent event snapshot, and readRedisGlobal has validated its item
			// checksums/schema. An exact retained reference must not acquire a
			// mutable PostgreSQL dependency during a database incident.
			rememberGlobalLkg(context, eventId, exactRedis);
			return exactRedis;
		}
		const exactLkg = readGlobalLkg(
			context,
			eventId,
			expectedScoreCoreRevision,
			expectedPublicationRef
		);
		if (exactLkg) return exactLkg;
	}
	// Probe Redis before consulting process LKG.  A warmed LKG is a fallback, not
	// a reason to ignore a recovered current/previous publication.
	const redisProbe = expectedPublicationRef
		? null
		: await readRedisGlobal(
				context,
				eventId,
				undefined,
				undefined,
				expectedScoreCoreRevision,
				expectedPublicationRef
			);
	if (!redisProbe) {
		const processLkg = readGlobalLkg(
			context,
			eventId,
			expectedScoreCoreRevision,
			expectedPublicationRef
		);
		if (processLkg) return processLkg;
	}
	const core = await readCore(context);
	if (!core) {
		const processLkg = readGlobalLkg(
			context,
			eventId,
			expectedScoreCoreRevision,
			expectedPublicationRef
		);
		return processLkg;
	}
	// Attempt both Redis pointers without a PostgreSQL roster lookup first.  A
	// historical event's roster is mutable in today's database and must never
	// delay or block a complete V2 hot publication.
	const unvalidatedRedis =
		redisProbe ??
		(await readRedisGlobal(
			context,
			eventId,
			undefined,
			undefined,
			expectedScoreCoreRevision,
			expectedPublicationRef
		));
	const expectedPlayerIds = await expectedPlayerIdsForEvent(context, eventId, core);
	const expectedFixtureIds = await expectedFixtureIdsForEvent(context, eventId);
	const redisGlobal = requireCompleteGlobalPublication(
		context,
		unvalidatedRedis,
		expectedPlayerIds,
		expectedFixtureIds
	);
	if (redisGlobal) {
		rememberGlobalLkg(context, eventId, redisGlobal);
		return redisGlobal;
	}
	const validatedRedis = await readRedisGlobal(
		context,
		eventId,
		expectedPlayerIds,
		expectedFixtureIds,
		expectedScoreCoreRevision,
		expectedPublicationRef
	);
	if (validatedRedis) {
		rememberGlobalLkg(context, eventId, validatedRedis);
		return validatedRedis;
	}
	const processLkg = readGlobalLkg(
		context,
		eventId,
		expectedScoreCoreRevision,
		expectedPublicationRef
	);
	if (processLkg) return processLkg;
	const databaseGlobal = await readDatabaseGlobalMemoized(
		context,
		eventId,
		expectedFixtureIds,
		expectedScoreCoreRevision,
		expectedPublicationRef
	);
	const completeDatabaseGlobal = requireCompleteGlobalPublication(
		context,
		databaseGlobal,
		expectedPlayerIds,
		expectedFixtureIds
	);
	if (completeDatabaseGlobal) rememberGlobalLkg(context, eventId, completeDatabaseGlobal);
	return completeDatabaseGlobal;
};

/** Read the complete event publication for non-entry live desks. */
export const readLivePublicationV2 = async (
	context: GraphQLContext,
	eventId: number,
	expectedScoreCoreRevision?: string
): Promise<LivePublicationReadV2 | null> => readGlobal(context, eventId, expectedScoreCoreRevision);

/**
 * Read the exact global publication referenced by a retained league match or
 * board.  A newer global snapshot must never be substituted for an older
 * input vector merely because it is currently active.
 */
export const readLivePublicationByRefV2 = async (
	context: GraphQLContext,
	eventId: number,
	ref: LivePublicationRefV2
): Promise<LivePublicationReadV2 | null> => readGlobal(context, eventId, undefined, ref);

/**
 * Read several historical publications with one event-roster SQL query and
 * batched Redis pointer/item reads.  The payloads still undergo the complete
 * per-publication checksum validation; batching only removes avoidable
 * request-round-trip and pool contention from season-sized transfer history.
 */
export const readLivePublicationsV2 = async (
	context: GraphQLContext,
	eventIds: readonly number[],
	expectedScoreCoreRevision?: string
): Promise<Map<number, LivePublicationReadV2>> => {
	const uniqueEventIds = [...new Set(eventIds)].filter(
		(eventId) => Number.isSafeInteger(eventId) && eventId > 0
	);
	if (uniqueEventIds.length === 0) return new Map();
	const core = await readCore(context);
	if (!core) return new Map();
	// Read both Redis pointers before resolving historical roster expectations.
	// This keeps the batched hot path independent from a PostgreSQL roster read.
	const uncheckedPlayerIdsByEvent = new Map<number, ReadonlySet<number> | undefined>();
	const uncheckedFixtureIdsByEvent = new Map<number, ReadonlySet<number> | null | undefined>();
	const result = new Map<number, GlobalRead>();
	for (const pointer of ["active", "previous"] as const) {
		try {
			const candidates = await readRedisGlobalCandidates(
				context.redis,
				context.currentSeason.seasonCode,
				uniqueEventIds,
				pointer,
				uncheckedPlayerIdsByEvent,
				uncheckedFixtureIdsByEvent
			);
			for (const [eventId, candidate] of candidates) {
				if (
					!result.has(eventId) &&
					(expectedScoreCoreRevision === undefined ||
						candidate.publication.revisions.scoreCore.revision === expectedScoreCoreRevision)
				)
					result.set(eventId, candidate);
			}
		} catch (error) {
			context.logger.warn(
				{ err: error, eventCount: uniqueEventIds.length, pointer },
				"Live Points V2 batched Redis read unavailable"
			);
		}
	}
	const expectedPlayerIdsByEvent = await expectedPlayerIdsForEvents(context, uniqueEventIds, core);
	const expectedFixtureIdsByEvent = await expectedFixtureIdsForEvents(context, uniqueEventIds);
	const invalidRedisEventIds = [...result].flatMap(([eventId, candidate]) =>
		requireCompleteGlobalPublication(
			context,
			candidate,
			expectedPlayerIdsByEvent.get(eventId),
			expectedFixtureIdsByEvent.get(eventId) ?? null
		)
			? []
			: [eventId]
	);
	for (const eventId of invalidRedisEventIds) result.delete(eventId);
	if (invalidRedisEventIds.length > 0) {
		for (const pointer of ["active", "previous"] as const) {
			try {
				const candidates = await readRedisGlobalCandidates(
					context.redis,
					context.currentSeason.seasonCode,
					invalidRedisEventIds,
					pointer,
					expectedPlayerIdsByEvent,
					expectedFixtureIdsByEvent
				);
				for (const [eventId, candidate] of candidates) {
					if (
						!result.has(eventId) &&
						(expectedScoreCoreRevision === undefined ||
							candidate.publication.revisions.scoreCore.revision === expectedScoreCoreRevision)
					)
						result.set(eventId, candidate);
				}
			} catch (error) {
				context.logger.warn(
					{ err: error, eventCount: invalidRedisEventIds.length, pointer },
					"Live Points V2 validated Redis retry unavailable"
				);
			}
		}
	}
	const missingEventIds = uniqueEventIds.filter((eventId) => !result.has(eventId));
	if (missingEventIds.length > 0) {
		const databaseValues = await Promise.all(
			missingEventIds.map(async (eventId) => {
				const value = await readDatabaseGlobalMemoized(
					context,
					eventId,
					expectedFixtureIdsByEvent.get(eventId) ?? null,
					expectedScoreCoreRevision
				);
				return [
					eventId,
					requireCompleteGlobalPublication(
						context,
						value,
						expectedPlayerIdsByEvent.get(eventId),
						expectedFixtureIdsByEvent.get(eventId) ?? null
					),
				] as const;
			})
		);
		for (const [eventId, value] of databaseValues) if (value) result.set(eventId, value);
	}
	return new Map(
		[...result].map(([eventId, value]) => [eventId, value as LivePublicationReadV2] as const)
	);
};

const readRedisEntry = async (
	context: GraphQLContext,
	eventId: number,
	entryId: number,
	global: GlobalRead
): Promise<EntryRead | null> => {
	const season = context.currentSeason.seasonCode;
	try {
		for (const pointer of ["active", "previous"] as const) {
			const candidate = await readRedisEntryCandidate(
				context.redis,
				season,
				eventId,
				entryId,
				pointer
			);
			if (candidate && entryMatchesGlobal(candidate, global)) return candidate;
		}
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

const readCoreFixtures = (context: GraphQLContext): Promise<CoreFixtureSnapshot | null> => {
	const scope = requestScope(context);
	const existing = requestCoreFixtureMemo.get(scope);
	if (existing) return existing;
	const load = getCoreFixtureSnapshot(context).catch((error) => {
		context.logger.warn({ err: error }, "Live Points V2 core fixture authority unavailable");
		return null;
	});
	requestCoreFixtureMemo.set(scope, load);
	return load;
};

/**
 * A live publication can be checksum-valid and still omit a fixture.  Keep
 * the expected fixture set on the coherent Core publication and check it only
 * after the Redis candidate has been attempted, so a historical roster lookup
 * or fixture fallback can never sit in front of the hot read.
 */
const expectedFixtureIdsForEvents = async (
	context: GraphQLContext,
	eventIds: readonly number[]
): Promise<Map<number, ReadonlySet<number> | null>> => {
	const uniqueEventIds = [...new Set(eventIds)].filter(
		(eventId) => Number.isSafeInteger(eventId) && eventId > 0
	);
	const result = new Map<number, ReadonlySet<number> | null>();
	if (uniqueEventIds.length === 0) return result;
	const snapshot = await readCoreFixtures(context);
	if (!snapshot) {
		for (const eventId of uniqueEventIds) result.set(eventId, null);
		return result;
	}
	for (const eventId of uniqueEventIds) {
		result.set(
			eventId,
			new Set(
				snapshot.fixtures
					.filter((fixture) => fixture.eventId === eventId)
					.map((fixture) => fixture.id)
			)
		);
	}
	return result;
};

const expectedFixtureIdsForEvent = async (
	context: GraphQLContext,
	eventId: number
): Promise<ReadonlySet<number> | null> =>
	(await expectedFixtureIdsForEvents(context, [eventId])).get(eventId) ?? null;

type EventRosterRow = Row & {
	event_id: unknown;
	element_id: unknown;
	publication_row_count: unknown;
	publication_expected_row_count: unknown;
};

const eventRosterFromRows = (rows: readonly EventRosterRow[]): ReadonlySet<number> | null => {
	if (rows.length === 0) return null;
	const first = rows[0]!;
	const rowCount = integer(first.publication_row_count);
	const expectedRowCount = integer(first.publication_expected_row_count);
	const playerIds = rows.map((row) => integer(row.element_id));
	if (
		rowCount === null ||
		expectedRowCount === null ||
		rowCount <= 0 ||
		rowCount !== expectedRowCount ||
		rows.length !== expectedRowCount ||
		playerIds.some((playerId) => playerId === null || playerId <= 0) ||
		new Set(playerIds).size !== playerIds.length
	)
		return null;
	return new Set(playerIds as number[]);
};

const readEventScopedRosters = async (
	context: GraphQLContext,
	eventIds: readonly number[]
): Promise<Map<number, ReadonlySet<number> | undefined>> => {
	const uniqueEventIds = [...new Set(eventIds)].filter(
		(eventId) => Number.isSafeInteger(eventId) && eventId > 0
	);
	const result = new Map<number, ReadonlySet<number> | undefined>();
	if (uniqueEventIds.length === 0) return result;
	const scope = requestScope(context);
	let memo = requestEventRosterMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestEventRosterMemo.set(scope, memo);
	}
	const missingEventIds = uniqueEventIds.filter((eventId) => !memo!.has(eventId));
	if (missingEventIds.length > 0) {
		try {
			const query = await context.database.query<EventRosterRow>(EVENT_ROSTER_SQL, [
				context.currentSeason.seasonId,
				missingEventIds,
			]);
			const rowsByEvent = new Map<number, EventRosterRow[]>();
			for (const row of query.rows) {
				const eventId = integer(row.event_id);
				if (eventId === null || !missingEventIds.includes(eventId)) continue;
				const rows = rowsByEvent.get(eventId) ?? [];
				rows.push(row);
				rowsByEvent.set(eventId, rows);
			}
			for (const eventId of missingEventIds) {
				memo.set(eventId, Promise.resolve(eventRosterFromRows(rowsByEvent.get(eventId) ?? [])));
			}
		} catch (error) {
			for (const eventId of missingEventIds) memo.set(eventId, Promise.resolve(null));
			context.logger.warn(
				{ err: error, eventIds: missingEventIds },
				"Historical Live Points V2 event rosters unavailable"
			);
		}
	}
	for (const eventId of uniqueEventIds) {
		const roster = await memo.get(eventId)!;
		result.set(eventId, roster ?? undefined);
	}
	return result;
};

type EventPlayerIdentityRow = Row & {
	event_id: unknown;
	element_id: unknown;
	event_element_type: unknown;
	selected_by_percent: unknown;
	publication_row_count: unknown;
	publication_expected_row_count: unknown;
	code: unknown;
	web_name: unknown;
	first_name: unknown;
	second_name: unknown;
	team_id: unknown;
	price: unknown;
	start_price: unknown;
	total_points: unknown;
};

const nullableText = (value: unknown): string | null =>
	value === null || value === undefined ? null : typeof value === "string" ? value : null;

const nullableDecimal = (value: unknown): number | null => {
	if (value === null || value === undefined) return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const readEventScopedPlayers = async (
	context: GraphQLContext,
	eventId: number
): Promise<ReadonlyMap<number, CorePlayerData>> => {
	const scope = requestScope(context);
	let memo = requestEventPlayerMemo.get(scope);
	if (!memo) {
		memo = new Map();
		requestEventPlayerMemo.set(scope, memo);
	}
	const existing = memo.get(eventId);
	if (existing) return existing;
	const load = (async (): Promise<ReadonlyMap<number, CorePlayerData>> => {
		try {
			const result = await context.database.query<EventPlayerIdentityRow>(
				EVENT_PLAYER_IDENTITY_SQL,
				[context.currentSeason.seasonId, eventId]
			);
			if (result.rows.length === 0) return new Map();
			const first = result.rows[0]!;
			const rowCount = integer(first.publication_row_count);
			const expectedRowCount = integer(first.publication_expected_row_count);
			if (
				rowCount === null ||
				expectedRowCount === null ||
				rowCount <= 0 ||
				rowCount !== expectedRowCount ||
				result.rows.length !== expectedRowCount ||
				result.rows.some((row) => integer(row.event_id) !== eventId)
			)
				return new Map();
			const players = new Map<number, CorePlayerData>();
			for (const row of result.rows) {
				const id = integer(row.element_id);
				const type = integer(row.event_element_type);
				const code = integer(row.code);
				const teamId = integer(row.team_id);
				const price = integer(row.price);
				const startPrice = integer(row.start_price);
				const totalPoints = integer(row.total_points);
				const webName = nullableText(row.web_name);
				if (
					id === null ||
					id <= 0 ||
					type === null ||
					type <= 0 ||
					code === null ||
					code <= 0 ||
					teamId === null ||
					teamId <= 0 ||
					price === null ||
					price < 0 ||
					startPrice === null ||
					startPrice < 0 ||
					totalPoints === null ||
					webName === null ||
					webName.trim().length === 0 ||
					players.has(id)
				)
					return new Map();
				players.set(id, {
					id,
					code,
					type,
					teamId,
					price,
					startPrice,
					firstName: nullableText(row.first_name),
					secondName: nullableText(row.second_name),
					webName,
					totalPoints,
					selectedByPercent: nullableDecimal(row.selected_by_percent),
				});
			}
			return players.size === expectedRowCount ? players : new Map();
		} catch (error) {
			context.logger.warn(
				{ err: error, eventId },
				"Historical Live Points V2 event player identities unavailable"
			);
			return new Map();
		}
	})();
	memo.set(eventId, load);
	return load;
};

const expectedPlayerIdsForEvents = async (
	context: GraphQLContext,
	eventIds: readonly number[],
	core: CoreLiveIdentitySnapshot
): Promise<Map<number, ReadonlySet<number> | undefined>> => {
	const uniqueEventIds = [...new Set(eventIds)];
	const corePlayerIds = new Set(core.players.map((player) => player.id));
	const result = new Map<number, ReadonlySet<number> | undefined>();
	if (uniqueEventIds.length === 0) return result;
	const eventSnapshot = await getCoreEventSnapshot(context).catch((error) => {
		context.logger.warn(
			{ err: error, eventIds: uniqueEventIds },
			"Live Points V2 event lifecycle unavailable"
		);
		return null;
	});
	if (!eventSnapshot) {
		for (const eventId of uniqueEventIds) result.set(eventId, corePlayerIds);
		return result;
	}
	const historicalEventIds: number[] = [];
	for (const eventId of uniqueEventIds) {
		const event = eventSnapshot.events.find((candidate) => candidate.id === eventId);
		const historical =
			event?.finished === true ||
			(eventSnapshot.currentEventId !== null && eventId < eventSnapshot.currentEventId);
		if (historical) historicalEventIds.push(eventId);
		else result.set(eventId, corePlayerIds);
	}
	const historicalRosters = await readEventScopedRosters(context, historicalEventIds);
	for (const eventId of historicalEventIds) result.set(eventId, historicalRosters.get(eventId));
	return result;
};

const expectedPlayerIdsForEvent = async (
	context: GraphQLContext,
	eventId: number,
	core: CoreLiveIdentitySnapshot
): Promise<ReadonlySet<number> | undefined> => {
	// A missing historical roster must not be replaced with today's core set:
	// that would reject a valid old publication when players have since joined.
	// The producer's complete publication proof remains the availability-first
	// fallback until the event-scoped snapshot can be read again.
	return (await expectedPlayerIdsForEvents(context, [eventId], core)).get(eventId);
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

const getEntrySafe = async (
	context: GraphQLContext,
	entryId: number
): Promise<EntryMetadataRead> => {
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
	const load = (async (): Promise<EntryMetadataRead> => {
		if (circuitOpenUntil > Date.now()) {
			return { entry: emptyEntry(entryId), available: false };
		}
		try {
			const value = await entriesRepository.getEntryById(context, entryId);
			entryMetadataCircuit.delete(key);
			return value
				? { entry: value, available: true }
				: { entry: emptyEntry(entryId), available: false };
		} catch (error) {
			entryMetadataCircuit.set(key, Date.now() + ENTRY_METADATA_CIRCUIT_COOLDOWN_MS);
			context.logger.warn({ err: error, entryId }, "Live Points V2 entry metadata unavailable");
			return { entry: emptyEntry(entryId), available: false };
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
			for (const entryId of chunk) {
				const entry = entries.get(entryId);
				memo.set(
					entryId,
					Promise.resolve({
						entry: entry ?? emptyEntry(entryId),
						available: entry !== undefined,
					})
				);
			}
		} catch (error) {
			for (const entryId of chunk) {
				entryMetadataCircuit.set(
					entryMetadataKey(context, entryId),
					Date.now() + ENTRY_METADATA_CIRCUIT_COOLDOWN_MS
				);
				memo.set(entryId, Promise.resolve({ entry: emptyEntry(entryId), available: false }));
			}
			context.logger.warn(
				{ err: error, entryCount: chunk.length, offset },
				"Live Points V2 batch entry metadata chunk unavailable"
			);
		}
	}
};

const playerTypeName = (type: number): string =>
	({ 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" })[type] ?? "";

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

const fixtureHasStarted = (fixture: FixtureRow): boolean =>
	fixture.started === true ||
	fixture.finished ||
	fixture.finishedProvisional ||
	fixture.minutes > 0;

const fixtureHasFinished = (fixture: FixtureRow): boolean =>
	fixture.finished || fixture.finishedProvisional;

const playerFixturesAreFinished = (
	player: CorePlayerData,
	live: EventLiveRow | undefined,
	fixtures: readonly FixtureRow[]
): boolean => {
	const playerFixtures = eventFixturesForPlayer(fixtures, player);
	if (playerFixtures.length === 0) {
		return Array.isArray(live?.fixtureBreakdown) && live.fixtureBreakdown.length === 0;
	}
	return playerFixtures.every(fixtureHasFinished);
};

const playStatusForPlayer = (
	playerFixtures: readonly FixtureRow[],
	live: EventLiveRow | undefined
): number => {
	if (playerFixtures.length === 0) return 0;
	const finishedFixtures = playerFixtures.filter(fixtureHasFinished).length;
	if (finishedFixtures === playerFixtures.length) return 4;
	if (playerFixtures.length > 1 && finishedFixtures > 0) return 3;
	if (playerFixtures.some(fixtureHasStarted) || played(live)) return 2;
	return 1;
};

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
	return !played(live) && playerFixturesAreFinished(player, live, fixtures);
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
		captain &&
		active.has(captain.element) &&
		!playerHasCompletedEvent(
			players.get(captain.element)!,
			liveByElement.get(captain.element),
			fixtures
		)
			? captain
			: vice &&
				  active.has(vice.element) &&
				  !playerHasCompletedEvent(
						players.get(vice.element)!,
						liveByElement.get(vice.element),
						fixtures
				  )
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
	const opponent = fixtureDetails.length === 1 ? (fixtureDetails[0]?.opponentId ?? 0) : 0;
	const opponentNames = fixtureDetails.map((item) => item.opponentTeam?.name ?? "").filter(Boolean);
	const opponentShortNames = fixtureDetails
		.map((item) => item.opponentTeam?.shortName ?? "")
		.filter(Boolean);
	const isGwStarted = playerFixtures.some(fixtureHasStarted);
	// A played player is complete when the player's fixture(s) are complete too.
	// playerHasCompletedEvent intentionally excludes played players because it is
	// used for DNP/auto-sub/captain promotion decisions, not fixture progress.
	const allFinished = playerFixturesAreFinished(player, live, fixtures);
	const isActive = lineup.active.has(pick.element);
	// A projected automatic-substitution entrant normally has the bench's base
	// multiplier (zero). Once the entrant is promoted into the XI, FPL scoring
	// applies a normal one-point multiplier unless captaincy explicitly changes
	// it. Keep the original zero only for genuinely inactive bench picks.
	const effectivePickMultiplier = lineup.autoSubs.has(pick.element)
		? Math.max(1, pick.multiplier)
		: pick.multiplier;
	const captainMultiplier =
		lineup.activeCaptain?.element === pick.element
			? lineup.captainMultiplier
			: isActive
				? effectivePickMultiplier
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
		playStatus: playStatusForPlayer(playerFixtures, live),
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

type FreshnessWindow = {
	staleAtMs: number;
	reasonCode: LivePointsFreshnessReasonCode;
};

export type LivePointsFreshnessReasonCode =
	"SOURCE_OLDER_THAN_30_SECONDS" | "SOURCE_PAST_EXPECTED_REFRESH";

export type LivePointsFreshnessPublication = {
	sourceCheckedAt: string;
	expectedNextCheckAt: string | null;
};

const freshnessWindowFor = (publication: LivePointsFreshnessPublication): FreshnessWindow => {
	const sourceCheckedAtMs = Date.parse(publication.sourceCheckedAt);
	const expectedNextCheckAtMs = publication.expectedNextCheckAt
		? Date.parse(publication.expectedNextCheckAt)
		: Number.NaN;
	if (
		Number.isFinite(expectedNextCheckAtMs) &&
		Number.isFinite(sourceCheckedAtMs) &&
		expectedNextCheckAtMs >= sourceCheckedAtMs
	) {
		return {
			staleAtMs: expectedNextCheckAtMs,
			reasonCode: "SOURCE_PAST_EXPECTED_REFRESH",
		};
	}
	return {
		staleAtMs: sourceCheckedAtMs + LIVE_POINTS_FRESHNESS_SECONDS * 1000,
		reasonCode: "SOURCE_OLDER_THAN_30_SECONDS",
	};
};

export type LivePointsFreshnessV2 = {
	staleAt: string;
	isFresh: boolean;
	reasonCode: LivePointsFreshnessReasonCode;
};

export const getLivePointsFreshnessV2 = (
	publication: LivePointsFreshnessPublication,
	nowMs = Date.now()
): LivePointsFreshnessV2 => {
	const window = freshnessWindowFor(publication);
	return {
		staleAt: new Date(window.staleAtMs).toISOString(),
		isFresh: nowMs <= window.staleAtMs,
		reasonCode: window.reasonCode,
	};
};

const deliveryFor = (
	global: GlobalRead,
	entry: EntryRead,
	_now: string,
	extraReasons: string[] = []
): LiveDeliveryV2 => {
	// Picks are a deadline-scoped immutable input, not a 30-second heartbeat.
	// Only the live score-core publication drives FRESH/STALE.  An older but
	// complete picks input is valid and must not make every live response stale.
	const freshness = freshnessWindowFor(global.publication);
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
			: Date.now() <= freshness.staleAtMs
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
			...(state === "STALE" ? [freshness.reasonCode] : []),
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
	const staleAt = new Date(freshnessWindowFor(global).staleAtMs).toISOString();
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
	entryMetadata: EntryMetadataRead,
	core: CoreLiveIdentitySnapshot | null
): Promise<LiveCalcDataV2> => {
	if (!core) throw new Error("CORE_IDENTITY_UNAVAILABLE");
	const effectiveCore = core;
	const entry = entryMetadata.entry;
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
	let eventScopedPlayers: ReadonlyMap<number, CorePlayerData> | undefined;
	const missingPlayers = projectionPicks.filter((pick) => !players.has(pick.element));
	if (missingPlayers.length > 0) {
		// Historical event publications can contain players that are no longer in
		// today's mutable Core identity slice.  Rehydrate the complete event-time
		// identity once for this request before declaring the projection incomplete.
		eventScopedPlayers = await readEventScopedPlayers(context, global.publication.eventId);
		for (const pick of missingPlayers) {
			const historicalPlayer = eventScopedPlayers.get(pick.element);
			if (historicalPlayer) players.set(pick.element, historicalPlayer);
		}
	}
	const unresolvedPlayers = projectionPicks.filter((pick) => !players.has(pick.element));
	const missingLiveRows = projectionPicks.filter((pick) => !liveByElement.has(pick.element));
	if (unresolvedPlayers.length > 0 || missingLiveRows.length > 0) {
		throw new Error(
			`INCOMPLETE_ROSTER_OR_EVENT_LIVE players=${unresolvedPlayers.length} rows=${missingLiveRows.length}`
		);
	}
	const eventPlayers = new Map<number, CorePlayerData>();
	for (const pick of projectionPicks) {
		const sourcePlayer = players.get(pick.element);
		let resolvedPlayer = sourcePlayer
			? eventPlayer(sourcePlayer, liveByElement.get(pick.element), fixtures)
			: null;
		if (!resolvedPlayer) {
			eventScopedPlayers ??= await readEventScopedPlayers(context, global.publication.eventId);
			const historicalPlayer = eventScopedPlayers.get(pick.element);
			resolvedPlayer = historicalPlayer
				? eventPlayer(historicalPlayer, liveByElement.get(pick.element), fixtures)
				: null;
		}
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
	const delivery = deliveryFor(global, entryRead, now, [
		...(core ? [] : ["CORE_IDENTITY_UNAVAILABLE"]),
		...(entryMetadata.available ? [] : ["ENTRY_METADATA_UNAVAILABLE"]),
	]);
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
		toPlay: rows.filter((row) => row.pickActive && !row.isPlayed && !row.isGwFinished).length,
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

/**
 * Project one entry from a complete league publication.  The league reader
 * has already loaded and checksum-validated the immutable input, so this
 * adapter deliberately does not look up entry metadata or probe the entry
 * Redis/DB paths again.  Core identity remains request-memoized and the
 * projection itself is pure CPU work over the pinned global publication.
 */
export async function projectLivePointsFromPublishedEntryV2(
	context: GraphQLContext,
	global: LivePublicationReadV2,
	input: unknown,
	publicationRef: {
		publicationId: string;
		generation: number;
		sourceCheckedAt: string;
		servedFrom?: LivePublicationReadV2["servedFrom"];
	},
	entry: Entry
): Promise<LiveCalcDataV2> {
	if (
		!validInput(input, global.publication.season, global.publication.eventId, entry.id) ||
		publicationRef.publicationId.length === 0 ||
		!Number.isSafeInteger(publicationRef.generation) ||
		publicationRef.generation <= 0 ||
		!iso(publicationRef.sourceCheckedAt)
	)
		throw new Error("LEAGUE_ENTRY_INPUT_INVALID");
	const entryRead: EntryRead = {
		publication: {
			contractVersion: LIVE_POINTS_CONTRACT_VERSION,
			publicationId: publicationRef.publicationId,
			generation: publicationRef.generation,
			season: global.publication.season,
			eventId: global.publication.eventId,
			entryId: entry.id,
			state: global.publication.state === "FINALIZED" ? "FINAL" : "PROVISIONAL",
			sourceCheckedAt: publicationRef.sourceCheckedAt,
			publishedAt: publicationRef.sourceCheckedAt,
			checkpointedAt: global.publication.checkpointedAt,
			expectedNextCheckAt: global.publication.expectedNextCheckAt,
			item: {
				name: "input",
				key: "league-publication",
				type: "string",
				count: input.picksBase.picks.length,
				bytes: Buffer.byteLength(JSON.stringify(input), "utf8"),
				sha256: hash(input),
			},
		},
		input,
		// The embedded input may be carried by a retained league publication.
		// Preserve that read's provenance instead of making every projected row
		// look like it came from the current entry snapshot.
		servedFrom: publicationRef.servedFrom ?? "REDIS_CURRENT",
	};
	const core = await readCore(context);
	return buildReady(context, global, entryRead, { entry, available: true }, core);
}

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
	const freshness = freshnessWindowFor(global.publication);
	const state: DeliveryState =
		global.publication.state === "FINALIZED"
			? "FINAL"
			: fallback
				? "DEGRADED"
				: Date.now() <= freshness.staleAtMs
					? "FRESH"
					: "STALE";
	return {
		state,
		servedFrom: global.servedFrom,
		reasonCodes: [
			reason,
			...(fallback ? ["FALLBACK_SERVED"] : []),
			...(state === "STALE" ? [freshness.reasonCode] : []),
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
	const snapshotDelivery = globalDelivery(global, reason);
	const delivery: LiveDeliveryV2 = {
		state: "UNAVAILABLE",
		servedFrom: "UNAVAILABLE",
		reasonCodes: [reason],
	};
	const times: LiveTimesV2 = {
		sourceCheckedAt: global.publication.sourceCheckedAt,
		contentUpdatedAt: global.publication.revisions.scoreCore.contentUpdatedAt,
		publishedAt: global.publication.publishedAt,
		checkpointedAt: global.publication.checkpointedAt,
		servedAt: now,
		staleAt: new Date(freshnessWindowFor(global.publication).staleAtMs).toISOString(),
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
			delivery: snapshotDelivery,
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

export const clearLivePointsV2Lkg = (): void => {
	liveLkg.clear();
	globalLkg.clear();
	globalLkgBytes = 0;
};

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
			staleAt: new Date(freshnessWindowFor(global.publication).staleAtMs).toISOString(),
			nextRefreshAt: global.publication.expectedNextCheckAt,
		};
		const fallback = global.servedFrom !== "REDIS_CURRENT";
		const freshness = freshnessWindowFor(global.publication);
		const state: DeliveryState =
			global.publication.state === "FINALIZED"
				? "FINAL"
				: fallback
					? "DEGRADED"
					: Date.now() <= freshness.staleAtMs
						? "FRESH"
						: "STALE";
		const delivery: LiveDeliveryV2 = {
			state,
			servedFrom: global.servedFrom,
			reasonCodes: [
				...(fallback ? ["FALLBACK_SERVED"] : []),
				...(state === "STALE" ? [freshness.reasonCode] : []),
			],
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
	options: { scoreCoreRevision?: string; prefetchedEntry?: EntryRead | null } = {}
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
	const core = await readCore(context);
	const lkgCandidate = readLiveLkg(lkgKey);
	// The first Redis attempt is intentionally unchecked against historical
	// PostgreSQL rosters.  Only after current/previous has been tried do we
	// resolve the authoritative player and fixture sets needed to accept it.
	const unvalidatedRedis = core
		? await readRedisGlobal(context, eventId, undefined, undefined, options.scoreCoreRevision)
		: null;
	if (!unvalidatedRedis && lkgCandidate) {
		return observeLivePointsResult(
			degradedLkg(
				lkgCandidate,
				core ? "GLOBAL_PUBLICATION_UNAVAILABLE" : "CORE_IDENTITY_UNAVAILABLE"
			)
		);
	}
	const expectedPlayerIds = core
		? await expectedPlayerIdsForEvent(context, eventId, core)
		: undefined;
	const expectedFixtureIds = core ? await expectedFixtureIdsForEvent(context, eventId) : null;
	const redisGlobal = core
		? requireCompleteGlobalPublication(
				context,
				unvalidatedRedis,
				expectedPlayerIds,
				expectedFixtureIds
			)
		: null;
	const validatedRedis =
		core && !redisGlobal
			? await readRedisGlobal(
					context,
					eventId,
					expectedPlayerIds,
					expectedFixtureIds,
					options.scoreCoreRevision
				)
			: null;
	const acceptedRedis = redisGlobal ?? validatedRedis;
	// The fallback order is intentional: a process LKG is a complete response
	// for this exact event/entry and is safer than a cold database read that may
	// combine metadata from a different publication.
	const global =
		acceptedRedis ??
		(lkgCandidate || !core
			? null
			: requireCompleteGlobalPublication(
					context,
					await readDatabaseGlobalMemoized(
						context,
						eventId,
						expectedFixtureIds,
						options.scoreCoreRevision
					),
					expectedPlayerIds,
					expectedFixtureIds
				));
	const processLkg =
		lkgCandidate && (!global || lkgMatchesGlobal(lkgCandidate, global)) ? lkgCandidate : null;
	if (global) rememberGlobalLkg(context, eventId, global);
	if (!global) {
		return observeLivePointsResult(
			processLkg
				? degradedLkg(
						processLkg,
						core ? "GLOBAL_PUBLICATION_UNAVAILABLE" : "CORE_IDENTITY_UNAVAILABLE"
					)
				: emptyUnavailable(
						context,
						eventId,
						entryId,
						"UNAVAILABLE",
						"GLOBAL_PUBLICATION_UNAVAILABLE"
					)
		);
	}
	const hasPrefetchedEntry = Object.prototype.hasOwnProperty.call(options, "prefetchedEntry");
	const redisEntry = hasPrefetchedEntry
		? options.prefetchedEntry && entryMatchesGlobal(options.prefetchedEntry, global)
			? options.prefetchedEntry
			: null
		: await readRedisEntry(context, eventId, entryId, global);
	const entryRead =
		redisEntry ??
		(hasPrefetchedEntry || processLkg
			? null
			: await readDatabaseEntry(
					context,
					context.currentSeason.seasonCode,
					eventId,
					entryId,
					global
				));
	if (!entryRead) {
		return observeLivePointsResult(
			processLkg
				? degradedLkg(processLkg, "ENTRY_INPUT_PENDING")
				: emptyFromGlobal(context, global, eventId, entryId, "PENDING", "ENTRY_INPUT_PENDING")
		);
	}
	try {
		const entryMetadata = await getEntrySafe(context, entryId);
		const result = await buildReady(context, global, entryRead, entryMetadata, core);
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
	const prefetchedEntries = new Map<number, EntryRead | null>();
	const processLkgEntryIds = new Set<number>();
	// Resolve the global publication once before probing entry inputs.  If the
	// global authority is unavailable, per-entry calls can use their process LKG
	// without issuing a pointless checkpoint query for every entry.
	const global = await readGlobal(context, eventId, options.scoreCoreRevision);
	if (global) {
		let probeCursor = 0;
		const probeWorker = async (): Promise<void> => {
			for (;;) {
				const index = probeCursor++;
				if (index >= uniqueIds.length) return;
				const entryId = uniqueIds[index]!;
				const lkgKey = [
					context.currentSeason.seasonCode,
					eventId,
					entryId,
					options.scoreCoreRevision ?? "current",
				].join(":");
				// Probe Redis before consulting process LKG. A warmed LKG is only a
				// fallback; it must never suppress a newer healthy entry input.
				const redisEntry = await readRedisEntry(context, eventId, entryId, global);
				if (redisEntry) {
					prefetchedEntries.set(entryId, redisEntry);
					continue;
				}
				const lkg = readLiveLkg(lkgKey);
				if (lkg && lkgMatchesGlobal(lkg, global)) {
					processLkgEntryIds.add(entryId);
					prefetchedEntries.set(entryId, null);
					continue;
				}
				prefetchedEntries.set(entryId, null);
			}
		};
		await Promise.all(Array.from({ length: concurrency }, () => probeWorker()));
		const databaseFallbackIds = uniqueIds.filter(
			(entryId) => !processLkgEntryIds.has(entryId) && prefetchedEntries.get(entryId) === null
		);
		const databaseEntries = await readDatabaseEntries(
			context,
			context.currentSeason.seasonCode,
			eventId,
			databaseFallbackIds,
			global
		);
		for (const entryId of databaseFallbackIds)
			prefetchedEntries.set(entryId, databaseEntries.get(entryId) ?? null);
	}
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= uniqueIds.length) return;
			const entryId = uniqueIds[index]!;
			try {
				const calculationOptions = prefetchedEntries.has(entryId)
					? { ...options, prefetchedEntry: prefetchedEntries.get(entryId) ?? null }
					: options;
				results.set(
					entryId,
					await calcLivePointsByEntryV2(context, eventId, entryId, calculationOptions)
				);
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
