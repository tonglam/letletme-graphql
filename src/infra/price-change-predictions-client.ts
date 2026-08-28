import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
<<<<<<< HEAD
import { DateTimeResolver } from "graphql-scalars";
import type { DataSqlContractProbe } from "../contracts/data-sql-contract";
import type { GraphQLContext } from "../graphql/context";
import {
	parseDataPublicationManifest,
	readDataPublicationItemsAtManifest,
	readDataPublicationManifest,
	readDataPublicationItemsObserved,
	isDataPublicationId,
	type DataPublication,
	type DataPublicationManifest,
} from "./data-publication";
import { hasExactFields } from "./exact-fields";

export const PRICE_CHANGE_READY_MS = 10 * 60 * 1000;
export const PRICE_CHANGE_MAX_AGE_MS = 60 * 60 * 1000;
const PRICE_CHANGE_DATASET = "fpl:price-changes" as const;
const PRICE_CHANGE_ITEMS = ["context", "players"] as const;

export type PriceChangePredictionStatus =
	| "VERY_LIKELY_RISE"
	| "LIKELY_RISE"
	| "UNLIKELY"
	| "LIKELY_FALL"
	| "VERY_LIKELY_FALL"
	| "LOCKED"
	| "CALIBRATING";

export type PriceChangeOwnershipTrend = "UP" | "DOWN" | "FLAT";

export type PriceChangeProjection = {
	offset: number;
	projectedPercent: number;
	likelihood: number;
};

export type PriceChangePlayer = {
	playerId: number;
	playerCode: number;
	webName: string;
	teamId: number;
	teamName: string;
	teamShortName: string;
	position: "GKP" | "DEF" | "MID" | "FWD";
	currentPrice: number;
	selectedByPercent: number;
	progressPercent: number;
	hourlyRate: number;
	status: PriceChangePredictionStatus;
	ownershipTrend: PriceChangeOwnershipTrend;
	transfersInEvent: number;
	transfersOutEvent: number;
	lockedUntil: string | null;
	calibrating: boolean;
	projections: PriceChangeProjection[];
};

export type PriceChangeObservedOutcome = "CHANGED" | "NO_CHANGE";

export type PriceChangeObservedChange = {
	playerId: number;
	oldPrice: number;
	newPrice: number;
};

export type PriceChangeObservedEvent = {
	deadline: string;
	changeDate: string;
	observedAt: string;
	outcome: PriceChangeObservedOutcome;
	baselineRevision: string;
	changedPlayerCount: number;
	changes: PriceChangeObservedChange[];
};

export type PriceChangeBoardStatus = "READY" | "PARTIAL" | "STALE" | "UNAVAILABLE";

export type PriceChangeBoard = {
	status: PriceChangeBoardStatus;
	source: "FPL_BOOTSTRAP";
	deadline: string | null;
	nextDeadlines: string[];
	fetchedAt: string | null;
	/** Provider request-start ordering evidence; internal to GraphQL. */
	sourceCheckedAt?: string | null;
	staleAt: string | null;
	revision: string;
	expectedPlayerCount: number;
	observedPlayerCount: number;
	players: PriceChangePlayer[];
	latestEvent?: PriceChangeObservedEvent | null;
};

export type PriceChangeDurableCursor = Readonly<{
	revision: string;
	fetchedAt: string;
	sourceCheckedAt: string;
	hardExpiresAt: string;
	state: "READY" | "STALE";
}>;

type PriceChangePublicationContext = {
	schemaVersion: 1 | 2;
	source: "FPL_BOOTSTRAP";
	fetchedAt: string;
	staleAt: string;
	hardExpiresAt: string;
	deadline: string;
	nextDeadlines: string[];
	expectedPlayerCount: number;
	observedPlayerCount: number;
	latestEvent?: PriceChangeObservedEvent | null;
};

const CONTEXT_FIELDS_V1 = [
	"schemaVersion",
	"source",
	"fetchedAt",
	"staleAt",
	"hardExpiresAt",
	"deadline",
	"nextDeadlines",
	"expectedPlayerCount",
	"observedPlayerCount",
] as const;

const CONTEXT_FIELDS_V2 = [...CONTEXT_FIELDS_V1, "latestEvent"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isGraphQLInt = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value >= -2_147_483_648 &&
	value <= 2_147_483_647;

const isDateTimeString = (value: unknown): value is string => {
	if (typeof value !== "string") return false;
	try {
		DateTimeResolver.parseValue(value);
		return true;
	} catch {
		return false;
	}
};

const isNullableDateTimeString = (value: unknown): value is string | null =>
	value === null || isDateTimeString(value);

const isDateString = (value: unknown): value is string => {
	if (typeof value !== "string") return false;
	try {
		DateResolver.parseValue(value);
		return true;
	} catch {
		return false;
	}
};

const utc8DateFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Asia/Shanghai",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

const utc8CalendarDate = (value: string): string | null => {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? utc8DateFormatter.format(new Date(timestamp)) : null;
};

const isStatus = (value: unknown): value is PriceChangePredictionStatus =>
	value === "VERY_LIKELY_RISE" ||
	value === "LIKELY_RISE" ||
	value === "UNLIKELY" ||
	value === "LIKELY_FALL" ||
	value === "VERY_LIKELY_FALL" ||
	value === "LOCKED" ||
	value === "CALIBRATING";

const isOwnershipTrend = (value: unknown): value is PriceChangeOwnershipTrend =>
	value === "UP" || value === "DOWN" || value === "FLAT";

const parseObservedEvent = (
	value: unknown,
	players?: readonly PriceChangePlayer[],
	now: Date = new Date()
): PriceChangeObservedEvent | null => {
	if (value === null) return null;
	if (
		!isRecord(value) ||
		!hasExactFields(value, [
			"deadline",
			"changeDate",
			"observedAt",
			"outcome",
			"baselineRevision",
			"changedPlayerCount",
			"changes",
		]) ||
		!isDateTimeString(value.deadline) ||
		!isDateString(value.changeDate) ||
		!isDateTimeString(value.observedAt) ||
		(value.outcome !== "CHANGED" && value.outcome !== "NO_CHANGE") ||
		typeof value.baselineRevision !== "string" ||
		value.baselineRevision.trim().length === 0 ||
		!isGraphQLInt(value.changedPlayerCount) ||
		value.changedPlayerCount < 0 ||
		!Array.isArray(value.changes)
	) {
		return null;
	}
	const deadlineMs = Date.parse(value.deadline);
	const observedAtMs = Date.parse(value.observedAt);
	if (
		!Number.isFinite(deadlineMs) ||
		!Number.isFinite(observedAtMs) ||
		deadlineMs > observedAtMs ||
		observedAtMs > now.getTime() ||
		utc8CalendarDate(value.deadline) !== value.changeDate
	) {
		return null;
	}
	const playersById = players ? new Map(players.map((player) => [player.playerId, player])) : null;
	const changes: PriceChangeObservedChange[] = [];
	let previousPlayerId = 0;
	for (const rawChange of value.changes) {
		if (
			!isRecord(rawChange) ||
			!hasExactFields(rawChange, ["playerId", "oldPrice", "newPrice"]) ||
			!isGraphQLInt(rawChange.playerId) ||
			rawChange.playerId <= 0 ||
			rawChange.playerId <= previousPlayerId ||
			!isGraphQLInt(rawChange.oldPrice) ||
			rawChange.oldPrice < 0 ||
			!isGraphQLInt(rawChange.newPrice) ||
			rawChange.newPrice < 0 ||
			rawChange.oldPrice === rawChange.newPrice ||
			(playersById !== null &&
				(!playersById.has(rawChange.playerId) ||
					playersById.get(rawChange.playerId)?.currentPrice !== rawChange.newPrice))
		) {
			return null;
		}
		changes.push({
			playerId: rawChange.playerId,
			oldPrice: rawChange.oldPrice,
			newPrice: rawChange.newPrice,
		});
		previousPlayerId = rawChange.playerId;
	}
	if (
		value.changedPlayerCount !== changes.length ||
		(value.outcome === "CHANGED" && changes.length === 0) ||
		(value.outcome === "NO_CHANGE" && changes.length !== 0)
	) {
		return null;
	}
	return {
		deadline: value.deadline,
		changeDate: value.changeDate,
		observedAt: value.observedAt,
		outcome: value.outcome,
		baselineRevision: value.baselineRevision,
		changedPlayerCount: value.changedPlayerCount,
		changes,
	};
};

const parseProjection = (value: unknown): PriceChangeProjection | null => {
	if (!isRecord(value)) return null;
	if (
		!isGraphQLInt(value.offset) ||
		value.offset < 0 ||
		!isFiniteNumber(value.projectedPercent) ||
		!isFiniteNumber(value.likelihood) ||
		value.likelihood < -5 ||
		value.likelihood > 5
	) {
		return null;
	}
	return {
		offset: value.offset,
		projectedPercent: value.projectedPercent,
		likelihood: value.likelihood,
	};
};

const parsePlayer = (value: unknown): PriceChangePlayer | null => {
	if (!isRecord(value)) return null;
	if (
		!isGraphQLInt(value.playerId) ||
		value.playerId <= 0 ||
		!isGraphQLInt(value.playerCode) ||
		value.playerCode <= 0 ||
		typeof value.webName !== "string" ||
		value.webName.trim().length === 0 ||
		!isGraphQLInt(value.teamId) ||
		value.teamId <= 0 ||
		typeof value.teamName !== "string" ||
		value.teamName.length === 0 ||
		typeof value.teamShortName !== "string" ||
		value.teamShortName.length === 0 ||
		(value.position !== "GKP" &&
			value.position !== "DEF" &&
			value.position !== "MID" &&
			value.position !== "FWD") ||
		!isGraphQLInt(value.currentPrice) ||
		value.currentPrice < 0 ||
		!isFiniteNumber(value.selectedByPercent) ||
		!isFiniteNumber(value.progressPercent) ||
		!isFiniteNumber(value.hourlyRate) ||
		!isStatus(value.status) ||
		!isOwnershipTrend(value.ownershipTrend) ||
		!isGraphQLInt(value.transfersInEvent) ||
		value.transfersInEvent < 0 ||
		!isGraphQLInt(value.transfersOutEvent) ||
		value.transfersOutEvent < 0 ||
		!isNullableDateTimeString(value.lockedUntil) ||
		typeof value.calibrating !== "boolean" ||
		!Array.isArray(value.projections) ||
		value.projections.length === 0
	) {
		return null;
	}
	const projections = value.projections.map(parseProjection);
	if (
		projections.some((projection) => projection === null) ||
		new Set(projections.map((projection) => projection?.offset)).size !== projections.length
	) {
		return null;
	}
	return {
		playerId: value.playerId,
		playerCode: value.playerCode,
		webName: value.webName,
		teamId: value.teamId,
		teamName: value.teamName,
		teamShortName: value.teamShortName,
		position: value.position,
		currentPrice: value.currentPrice,
		selectedByPercent: value.selectedByPercent,
		progressPercent: value.progressPercent,
		hourlyRate: value.hourlyRate,
		status: value.status,
		ownershipTrend: value.ownershipTrend,
		transfersInEvent: value.transfersInEvent,
		transfersOutEvent: value.transfersOutEvent,
		lockedUntil: value.lockedUntil,
		calibrating: value.calibrating,
		projections: projections as PriceChangeProjection[],
	};
};

/** Validate a board carried by the provisional Redis hot envelope. */
export const parsePriceChangeBoardValue = (
	value: unknown,
	now: Date = new Date()
): PriceChangeBoard | null => {
	if (!isRecord(value)) return null;
	if (
		(value.status !== "READY" && value.status !== "PARTIAL" && value.status !== "STALE") ||
		value.source !== "FPL_BOOTSTRAP" ||
		(value.deadline !== null && !isDateTimeString(value.deadline)) ||
		!Array.isArray(value.nextDeadlines) ||
		!value.nextDeadlines.every(isDateTimeString) ||
		(value.fetchedAt !== null && !isDateTimeString(value.fetchedAt)) ||
		(value.staleAt !== null && !isDateTimeString(value.staleAt)) ||
		typeof value.revision !== "string" ||
		!isGraphQLInt(value.expectedPlayerCount) ||
		!isGraphQLInt(value.observedPlayerCount) ||
		!Array.isArray(value.players)
	) {
		return null;
	}
	if (
		value.nextDeadlines.length === 0 ||
		value.deadline === null ||
		value.deadline !== value.nextDeadlines[0]
	) {
		return null;
	}
	const players = value.players.map(parsePlayer);
	if (
		players.some((player) => player === null) ||
		value.expectedPlayerCount <= 0 ||
		value.observedPlayerCount <= 0 ||
		value.expectedPlayerCount !== value.observedPlayerCount ||
		value.players.length !== value.observedPlayerCount
	) {
		return null;
	}
	const parsedPlayers = players as PriceChangePlayer[];
	const nextDeadlines = value.nextDeadlines as string[];
	for (let index = 1; index < nextDeadlines.length; index += 1) {
		if (Date.parse(nextDeadlines[index - 1]!) >= Date.parse(nextDeadlines[index]!)) {
			return null;
		}
	}
	if (
		parsedPlayers.some(
			(player) =>
				player.projections.length !== nextDeadlines.length ||
				player.projections.some(
					(projection) => projection.offset < 0 || projection.offset >= nextDeadlines.length
				)
		)
	) {
		return null;
	}
	const playerIds = new Set(parsedPlayers.map((player) => player.playerId));
	if (playerIds.size !== parsedPlayers.length || playerIds.size !== value.expectedPlayerCount) {
		return null;
	}
	const hasLatestEvent = Object.prototype.hasOwnProperty.call(value, "latestEvent");
	const latestEvent = parseObservedEvent(
		hasLatestEvent ? value.latestEvent : null,
		parsedPlayers,
		now
	);
	if (hasLatestEvent && value.latestEvent !== null && latestEvent === null) return null;
	if (value.fetchedAt !== null) {
		const fetchedAt = Date.parse(value.fetchedAt);
		if (
			!Number.isFinite(fetchedAt) ||
			now.getTime() < fetchedAt ||
			now.getTime() - fetchedAt > PRICE_CHANGE_MAX_AGE_MS ||
			(latestEvent !== null && Date.parse(latestEvent.observedAt) > fetchedAt)
		) {
			return null;
		}
	}
	return {
		status: value.status,
		source: "FPL_BOOTSTRAP",
		deadline: value.deadline,
		nextDeadlines: [...nextDeadlines],
		fetchedAt: value.fetchedAt,
		staleAt: value.staleAt,
		revision: value.revision,
		expectedPlayerCount: value.expectedPlayerCount,
		observedPlayerCount: value.observedPlayerCount,
		players: [...parsedPlayers].sort((left, right) => left.playerId - right.playerId),
		latestEvent,
	};
};

const unavailableBoard = (): PriceChangeBoard => ({
	status: "UNAVAILABLE",
	source: "FPL_BOOTSTRAP",
	deadline: null,
	nextDeadlines: [],
	fetchedAt: null,
	staleAt: null,
	revision: "unavailable",
	expectedPlayerCount: 0,
	observedPlayerCount: 0,
	players: [],
	latestEvent: null,
});

const parseContext = (value: unknown): PriceChangePublicationContext | null => {
	if (!isRecord(value)) return null;
	const schemaVersion = value.schemaVersion;
	if (
		(schemaVersion !== 1 && schemaVersion !== 2) ||
		!hasExactFields(value, schemaVersion === 1 ? CONTEXT_FIELDS_V1 : CONTEXT_FIELDS_V2)
	) {
		return null;
	}
	if (
		value.source !== "FPL_BOOTSTRAP" ||
		!isDateTimeString(value.fetchedAt) ||
		!isDateTimeString(value.staleAt) ||
		!isDateTimeString(value.hardExpiresAt) ||
		!isDateTimeString(value.deadline) ||
		!Array.isArray(value.nextDeadlines) ||
		value.nextDeadlines.length === 0 ||
		!value.nextDeadlines.every(isDateTimeString) ||
		value.deadline !== value.nextDeadlines[0] ||
		!isGraphQLInt(value.expectedPlayerCount) ||
		value.expectedPlayerCount <= 0 ||
		!isGraphQLInt(value.observedPlayerCount) ||
		value.observedPlayerCount <= 0 ||
		value.expectedPlayerCount !== value.observedPlayerCount
	) {
		return null;
	}
	const fetchedAt = Date.parse(value.fetchedAt);
	const staleAt = Date.parse(value.staleAt);
	const hardExpiresAt = Date.parse(value.hardExpiresAt);
	if (
		staleAt !== fetchedAt + PRICE_CHANGE_READY_MS ||
		hardExpiresAt !== fetchedAt + PRICE_CHANGE_MAX_AGE_MS
	) {
		return null;
	}
	for (let index = 1; index < value.nextDeadlines.length; index += 1) {
		if (Date.parse(value.nextDeadlines[index - 1]) >= Date.parse(value.nextDeadlines[index])) {
			return null;
		}
	}
	const latestEvent = schemaVersion === 2 ? parseObservedEvent(value.latestEvent) : null;
	if (schemaVersion === 2 && value.latestEvent !== null && latestEvent === null) {
		return null;
	}
	return {
		schemaVersion,
		source: "FPL_BOOTSTRAP",
		fetchedAt: value.fetchedAt,
		staleAt: value.staleAt,
		hardExpiresAt: value.hardExpiresAt,
		deadline: value.deadline,
		nextDeadlines: value.nextDeadlines,
		expectedPlayerCount: value.expectedPlayerCount,
		observedPlayerCount: value.observedPlayerCount,
		latestEvent,
	};
};

const parsePublicationBoard = (
	publication: DataPublication,
	now: Date
): PriceChangeBoard | null => {
	if (
		publication.manifest.dataset !== PRICE_CHANGE_DATASET ||
		publication.manifest.eventId !== null ||
		publication.manifest.state !== "active" ||
		publication.manifest.items.length !== PRICE_CHANGE_ITEMS.length ||
		publication.manifest.items
			.map((item) => item.name)
			.sort()
			.join(",") !== [...PRICE_CHANGE_ITEMS].sort().join(",")
	) {
		return null;
	}
	const context = parseContext(publication.items.context);
	if (!context || !Array.isArray(publication.items.players)) return null;
	const parsedPlayers = publication.items.players.map(parsePlayer);
	if (
		parsedPlayers.some((player) => player === null) ||
		parsedPlayers.length !== context.observedPlayerCount ||
		context.expectedPlayerCount !== context.observedPlayerCount
	) {
		return null;
	}
	const players = parsedPlayers as PriceChangePlayer[];
	if (
		players.some(
			(player) =>
				player.projections.length !== context.nextDeadlines.length ||
				player.projections.some(
					(projection) => projection.offset < 0 || projection.offset >= context.nextDeadlines.length
				)
		) ||
		players.some(
			(player) =>
				new Set(player.projections.map((projection) => projection.offset)).size !==
				player.projections.length
		)
	) {
		return null;
	}
	const playerIds = new Set(players.map((player) => player.playerId));
	if (playerIds.size !== players.length || playerIds.size !== context.expectedPlayerCount) {
		return null;
	}
	const latestEvent = context.latestEvent
		? parseObservedEvent(context.latestEvent, players, now)
		: null;
	if (context.latestEvent && latestEvent === null) return null;
	if (latestEvent && Date.parse(latestEvent.observedAt) > Date.parse(context.fetchedAt))
		return null;
	const ageMs = now.getTime() - Date.parse(context.fetchedAt);
	if (ageMs < 0 || ageMs >= PRICE_CHANGE_MAX_AGE_MS) return null;
	return {
		status: ageMs < PRICE_CHANGE_READY_MS ? "READY" : "STALE",
		source: "FPL_BOOTSTRAP",
		deadline: context.deadline,
		nextDeadlines: [...context.nextDeadlines],
		fetchedAt: context.fetchedAt,
		sourceCheckedAt: publication.manifest.sourceCheckedAt,
		staleAt: context.staleAt,
		revision: publication.manifest.publicationId,
		expectedPlayerCount: context.expectedPlayerCount,
		observedPlayerCount: context.observedPlayerCount,
		players: [...players].sort((left, right) => left.playerId - right.playerId),
		latestEvent,
	};
};

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalize(record[key])])
		);
	}
	return value;
};

const canonicalJson = (value: unknown): string => {
	const serialized = JSON.stringify(canonicalize(value));
	if (serialized === undefined) throw new Error("Publication payload is not JSON serializable");
	return serialized;
};

const payloadCount = (value: unknown): number => {
	if (Array.isArray(value)) return value.length;
	if (isRecord(value)) return Object.keys(value).length;
	return value === null || value === undefined ? 0 : 1;
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

type PublicationCandidateRow = QueryResultRow & {
	publication_id: string;
	revision: string | number;
	status: "active" | "retired";
	manifest: unknown;
};

type PublicationItemRow = QueryResultRow & {
	publication_id: string;
	item_name: string;
	item_count: string | number;
	checksum: string;
	payload: unknown;
};

type PublicationItemMetadataRow = QueryResultRow & {
	publication_id: string;
	item_name: string;
	item_count: string | number;
	checksum: string;
};

type ParsedPriceChangePublicationCandidate = {
	status: "active" | "retired";
	publicationId: string;
	revision: number;
	manifest: DataPublication["manifest"];
};

type LoadedPriceChangePublicationCandidate = {
	status: "active" | "retired";
	publication: DataPublication;
};

// Price predictions publish every five minutes; twelve retired candidates cover
// the complete one-hour hard-expiry window without an unbounded history scan.
const RETIRED_PUBLICATION_LIMIT = 12;

export const PUBLICATION_CANDIDATES_SQL = `
	WITH active_candidates AS (
		SELECT publication_id::text AS publication_id, revision::text AS revision, status, manifest
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:price-changes'
		  AND season_id = $1
		  AND event_id IS NULL
		  AND status = 'active'
		  AND (expires_at IS NULL OR expires_at > now())
		ORDER BY revision DESC
		LIMIT 2
	), retired_candidates AS (
		SELECT publication_id::text AS publication_id, revision::text AS revision, status, manifest
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:price-changes'
		  AND season_id = $1
		  AND event_id IS NULL
		  AND status = 'retired'
		  AND (expires_at IS NULL OR expires_at > now())
		ORDER BY revision DESC
		LIMIT ${RETIRED_PUBLICATION_LIMIT}
	)
	SELECT publication_id, revision, status, manifest FROM active_candidates
	UNION ALL
	SELECT publication_id, revision, status, manifest FROM retired_candidates
`;

export const PUBLICATION_BY_ID_SQL = `
	SELECT publication_id::text AS publication_id, revision::text AS revision, status, manifest
	FROM ops.dataset_publications
	WHERE publication_id = $1::uuid
	  AND dataset = 'fpl:price-changes'
	  AND season_id = $2
	  AND event_id IS NULL
	  AND status IN ('active', 'retired')
	  AND (expires_at IS NULL OR expires_at > now())
	LIMIT 1
`;

export const PUBLICATION_ITEMS_SQL = `
	SELECT publication_id::text AS publication_id, item_name, item_count, checksum, payload
	FROM ops.dataset_publication_items
	WHERE publication_id = ANY($1::uuid[])
	ORDER BY publication_id, item_name
`;

export const PUBLICATION_CONTEXT_ITEMS_SQL = `
	SELECT publication_id::text AS publication_id, item_name, item_count, checksum, payload
	FROM ops.dataset_publication_items
	WHERE publication_id = ANY($1::uuid[])
	  AND item_name = 'context'
	ORDER BY publication_id
`;

export const PUBLICATION_ITEM_METADATA_SQL = `
	SELECT publication_id::text AS publication_id, item_name, item_count, checksum
	FROM ops.dataset_publication_items
	WHERE publication_id = ANY($1::uuid[])
	  AND item_name = ANY($2::text[])
	ORDER BY publication_id, item_name
`;

const PRICE_CHANGE_CONTRACT_PUBLICATION_ID = "00000000-0000-4000-8000-000000000001";

export const PRICE_CHANGE_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "price-change.publication-candidates",
		sql: PUBLICATION_CANDIDATES_SQL,
		values: [2026],
	},
	{
		name: "price-change.publication-by-id",
		sql: PUBLICATION_BY_ID_SQL,
		values: [PRICE_CHANGE_CONTRACT_PUBLICATION_ID, 2026],
	},
	{
		name: "price-change.publication-items",
		sql: PUBLICATION_ITEMS_SQL,
		values: [[PRICE_CHANGE_CONTRACT_PUBLICATION_ID]],
	},
	{
		name: "price-change.publication-context-items",
		sql: PUBLICATION_CONTEXT_ITEMS_SQL,
		values: [[PRICE_CHANGE_CONTRACT_PUBLICATION_ID]],
	},
	{
		name: "price-change.publication-item-metadata",
		sql: PUBLICATION_ITEM_METADATA_SQL,
		values: [[PRICE_CHANGE_CONTRACT_PUBLICATION_ID], PRICE_CHANGE_ITEMS],
	},
];

const loadPriceChangePublicationItems = async (
	context: GraphQLContext,
	candidates: ParsedPriceChangePublicationCandidate[]
): Promise<LoadedPriceChangePublicationCandidate[]> => {
	if (candidates.length === 0) return [];
	const publicationIds = candidates.map((candidate) => candidate.publicationId);
	const publicationIdSet = new Set(publicationIds);
	const itemResult = await context.database.query<PublicationItemRow>(PUBLICATION_ITEMS_SQL, [
		publicationIds,
	]);
	const rowsByPublication = new Map<string, PublicationItemRow[]>();
	for (const item of itemResult.rows) {
		if (!publicationIdSet.has(item.publication_id)) continue;
		const rows = rowsByPublication.get(item.publication_id) ?? [];
		rows.push(item);
		rowsByPublication.set(item.publication_id, rows);
	}
	const publications: LoadedPriceChangePublicationCandidate[] = [];
	for (const candidate of candidates) {
		const publicationItems = rowsByPublication.get(candidate.publicationId) ?? [];
		if (publicationItems.length !== PRICE_CHANGE_ITEMS.length) continue;
		const items: Record<string, unknown> = {};
		const seen = new Set<string>();
		let valid = true;
		for (const item of publicationItems) {
			if (
				seen.has(item.item_name) ||
				!PRICE_CHANGE_ITEMS.includes(item.item_name as (typeof PRICE_CHANGE_ITEMS)[number])
			) {
				valid = false;
				break;
			}
			const manifestItem = candidate.manifest.items.find(
				(manifestCandidate) => manifestCandidate.name === item.item_name
			);
			if (
				!manifestItem ||
				typeof item.checksum !== "string" ||
				item.checksum !== manifestItem.sha256
			) {
				valid = false;
				break;
			}
			try {
				const payload: unknown =
					typeof item.payload === "string" ? (JSON.parse(item.payload) as unknown) : item.payload;
				const serialized = canonicalJson(payload);
				if (
					Number(item.item_count) !== manifestItem.count ||
					payloadCount(payload) !== manifestItem.count ||
					Buffer.byteLength(serialized, "utf8") !== manifestItem.bytes ||
					sha256(serialized) !== manifestItem.sha256
				) {
					valid = false;
					break;
				}
				seen.add(item.item_name);
				items[item.item_name] = payload;
			} catch {
				valid = false;
				break;
			}
		}
		if (!valid || seen.size !== PRICE_CHANGE_ITEMS.length) continue;
		publications.push({
			status: candidate.status,
			publication: { manifest: candidate.manifest, items },
		});
	}
	return publications;
};

const loadPriceChangeBoardFromPostgres = async (
	context: GraphQLContext,
	now: Date
): Promise<PriceChangeBoard | null> => {
	const authority = await context.database.query<PublicationCandidateRow>(
		PUBLICATION_CANDIDATES_SQL,
		[context.currentSeason.seasonId]
	);
	const activeRows = authority.rows.filter((row) => row.status === "active");
	if (activeRows.length > 1) return null;
	const activeRevision = activeRows.length === 1 ? Number(activeRows[0]!.revision) : null;
	const parsedCandidates = authority.rows
		.filter((row) => row.status === "active" || row.status === "retired")
		.map((row) => ({ row, revision: Number(row.revision) }))
		.filter(
			(candidate) =>
				Number.isSafeInteger(candidate.revision) &&
				candidate.revision > 0 &&
				(candidate.row.status === "active" ||
					activeRevision === null ||
					!Number.isSafeInteger(activeRevision) ||
					candidate.revision < activeRevision)
		)
		.sort((left, right) => {
			if (left.row.status !== right.row.status) return left.row.status === "active" ? -1 : 1;
			return right.revision - left.revision;
		})
		.flatMap<ParsedPriceChangePublicationCandidate>(({ row, revision }) => {
			const rawManifest =
				typeof row.manifest === "string" ? row.manifest : (JSON.stringify(row.manifest) ?? "");
			const manifest = parseDataPublicationManifest(rawManifest, {
				dataset: PRICE_CHANGE_DATASET,
				seasonCode: context.currentSeason.seasonCode,
			});
			if (
				!manifest ||
				manifest.publicationId !== row.publication_id ||
				manifest.revision !== revision ||
				manifest.items.length !== PRICE_CHANGE_ITEMS.length
			) {
				return [];
			}
			return [
				{
					status: row.status,
					publicationId: row.publication_id,
					revision,
					manifest,
				},
			];
		});
	const activeCandidate = parsedCandidates.find((candidate) => candidate.status === "active");
	if (activeCandidate) {
		const [activePublication] = await loadPriceChangePublicationItems(context, [activeCandidate]);
		if (activePublication) {
			const board = parsePublicationBoard(activePublication.publication, now);
			if (board) return board;
		}
	}
	const retiredCandidates = parsedCandidates.filter((candidate) => candidate.status === "retired");
	const retiredPublications = await loadPriceChangePublicationItems(context, retiredCandidates);
	for (const candidate of retiredPublications) {
		const board = parsePublicationBoard(candidate.publication, now);
		// A coherent retired revision remains usable, but it is never the current authority.
		if (board) return { ...board, status: "STALE" };
	}
	return null;
};

const loadPriceChangePublicationById = async (
	context: GraphQLContext,
	publicationId: string
): Promise<LoadedPriceChangePublicationCandidate | null> => {
	const normalizedPublicationId = publicationId.toLowerCase();
	const authority = await context.database.query<PublicationCandidateRow>(PUBLICATION_BY_ID_SQL, [
		normalizedPublicationId,
		context.currentSeason.seasonId,
	]);
	if (authority.rows.length !== 1) return null;
	const row = authority.rows[0];
	const revision = Number(row.revision);
	const rawManifest =
		typeof row.manifest === "string" ? row.manifest : (JSON.stringify(row.manifest) ?? "");
	const manifest = parseDataPublicationManifest(rawManifest, {
		dataset: PRICE_CHANGE_DATASET,
		seasonCode: context.currentSeason.seasonCode,
	});
	if (
		!manifest ||
		manifest.publicationId !== row.publication_id ||
		!Number.isSafeInteger(revision) ||
		manifest.revision !== revision ||
		manifest.items.length !== PRICE_CHANGE_ITEMS.length
	)
		return null;
	const [loaded] = await loadPriceChangePublicationItems(context, [
		{ status: row.status, publicationId: row.publication_id, revision, manifest },
	]);
	return loaded ?? null;
};

/** Read one retained durable publication by its immutable UUID. */
export async function readPriceChangePredictionsByPublicationId(
	context: GraphQLContext,
	publicationId: string
): Promise<PriceChangeBoard | null> {
	if (!isDataPublicationId(publicationId)) return null;
	try {
		const loaded = await loadPriceChangePublicationById(context, publicationId);
		if (!loaded) return null;
		const board = parsePublicationBoard(loaded.publication, new Date());
		return board && loaded.status === "retired" ? { ...board, status: "STALE" } : board;
	} catch (error) {
		context.logger.warn(
			{
				err: error,
				dataset: PRICE_CHANGE_DATASET,
				seasonCode: context.currentSeason.seasonCode,
				publicationId,
			},
			"Failed to load requested price-change publication from PostgreSQL"
		);
		return null;
	}
}

export async function readPriceChangePredictions(
	context: GraphQLContext
): Promise<PriceChangeBoard> {
	const scope = {
		dataset: PRICE_CHANGE_DATASET,
		seasonCode: context.currentSeason.seasonCode,
	} as const;
	const redisRead = await readDataPublicationItemsObserved(
		context.redis,
		scope,
		PRICE_CHANGE_ITEMS
	);
	if (redisRead.publication) {
		const board = parsePublicationBoard(redisRead.publication, new Date());
		if (board) return board;
	}
	let postgresBoard: PriceChangeBoard | null = null;
	try {
		postgresBoard = await loadPriceChangeBoardFromPostgres(context, new Date());
	} catch (error) {
		context.logger.warn(
			{
				err: error,
				dataset: PRICE_CHANGE_DATASET,
				seasonCode: context.currentSeason.seasonCode,
			},
			"Failed to load price-change publication from PostgreSQL"
		);
	}
	if (postgresBoard) return postgresBoard;
	return unavailableBoard();
}

/**
 * Read only the active publication manifest and context for cursor polling.
 * The cursor never needs to materialize the player array; a full board read is
 * reserved for the subsequent revision-bound board request.
 */
export async function readPriceChangePredictionsCursor(
	context: GraphQLContext,
	now: Date = new Date()
): Promise<PriceChangeDurableCursor | null> {
	const scope = {
		dataset: PRICE_CHANGE_DATASET,
		seasonCode: context.currentSeason.seasonCode,
	} as const;
	const isPriceChangeManifest = (
		manifest: DataPublicationManifest | null
	): manifest is DataPublicationManifest =>
		Boolean(
			manifest &&
			manifest.eventId === null &&
			manifest.state === "active" &&
			manifest.items.length === PRICE_CHANGE_ITEMS.length &&
			manifest.items
				.map((item) => item.name)
				.sort()
				.join(",") === [...PRICE_CHANGE_ITEMS].sort().join(",")
		);
	const cursorFromContext = (
		manifest: DataPublicationManifest,
		publicationContext: PriceChangePublicationContext
	): PriceChangeDurableCursor | null => {
		const fetchedAt = Date.parse(publicationContext.fetchedAt);
		const hardExpiresAt = Date.parse(publicationContext.hardExpiresAt);
		const ageMs = now.getTime() - fetchedAt;
		if (
			!Number.isFinite(fetchedAt) ||
			!Number.isFinite(hardExpiresAt) ||
			ageMs < 0 ||
			ageMs >= PRICE_CHANGE_MAX_AGE_MS
		) {
			return null;
		}
		return {
			revision: manifest.publicationId,
			fetchedAt: publicationContext.fetchedAt,
			sourceCheckedAt: manifest.sourceCheckedAt,
			hardExpiresAt: publicationContext.hardExpiresAt,
			state: ageMs < PRICE_CHANGE_READY_MS ? "READY" : "STALE",
		};
	};

	// Redis is the normal low-latency path. If its pointer or context payload
	// is missing/stale, fall through to PostgreSQL instead of reporting an
	// unavailable cursor while a durable publication still exists.
	try {
		const manifest = await readDataPublicationManifest(context.redis, scope);
		if (isPriceChangeManifest(manifest)) {
			const publication = await readDataPublicationItemsAtManifest(context.redis, manifest, [
				"context",
			]);
			const publicationContext = publication ? parseContext(publication.items.context) : null;
			if (publicationContext) {
				const cursor = cursorFromContext(manifest, publicationContext);
				if (cursor) return cursor;
			}
		}
	} catch (error) {
		context.logger.warn(
			{
				err: error,
				dataset: PRICE_CHANGE_DATASET,
				seasonCode: context.currentSeason.seasonCode,
			},
			"Failed to load price-change cursor metadata"
		);
	}

	try {
		// Keep the cursor fallback bounded to the same active plus twelve retained
		// candidates used by the board reader. Only the context item is fetched;
		// player arrays remain exclusive to the revision-bound board query. The
		// metadata row is checked against the manifest checksum and count; the
		// fetched context payload is then verified byte-for-byte below.
		const authority = await context.database.query<PublicationCandidateRow>(
			PUBLICATION_CANDIDATES_SQL,
			[context.currentSeason.seasonId]
		);
		const activeRows = authority.rows.filter((row) => row.status === "active");
		if (activeRows.length > 1) return null;
		const activeRevision = activeRows.length === 1 ? Number(activeRows[0]!.revision) : null;
		const candidates = authority.rows
			.filter((row) => row.status === "active" || row.status === "retired")
			.map((row) => ({ row, revision: Number(row.revision) }))
			.filter(
				(candidate) =>
					Number.isSafeInteger(candidate.revision) &&
					candidate.revision > 0 &&
					(candidate.row.status === "active" ||
						activeRevision === null ||
						!Number.isSafeInteger(activeRevision) ||
						candidate.revision < activeRevision)
			)
			.sort((left, right) => {
				if (left.row.status !== right.row.status) return left.row.status === "active" ? -1 : 1;
				return right.revision - left.revision;
			});
		const itemMetadata = await context.database.query<PublicationItemMetadataRow>(
			PUBLICATION_ITEM_METADATA_SQL,
			[candidates.map(({ row }) => row.publication_id), [...PRICE_CHANGE_ITEMS]]
		);
		const metadataRowsByPublication = new Map<string, PublicationItemMetadataRow[]>();
		for (const item of itemMetadata.rows) {
			const rows = metadataRowsByPublication.get(item.publication_id) ?? [];
			rows.push(item);
			metadataRowsByPublication.set(item.publication_id, rows);
		}
		const contextRows = await context.database.query<PublicationItemRow>(
			PUBLICATION_CONTEXT_ITEMS_SQL,
			[candidates.map(({ row }) => row.publication_id)]
		);
		const contextRowsByPublication = new Map<string, PublicationItemRow[]>();
		for (const item of contextRows.rows) {
			const rows = contextRowsByPublication.get(item.publication_id) ?? [];
			rows.push(item);
			contextRowsByPublication.set(item.publication_id, rows);
		}
		for (const { row, revision } of candidates) {
			const rawManifest =
				typeof row.manifest === "string" ? row.manifest : (JSON.stringify(row.manifest) ?? "");
			const manifest = parseDataPublicationManifest(rawManifest, scope);
			if (
				!manifest ||
				!isPriceChangeManifest(manifest) ||
				!Number.isSafeInteger(revision) ||
				manifest.publicationId !== row.publication_id ||
				manifest.revision !== revision
			) {
				continue;
			}
			const metadataRows = metadataRowsByPublication.get(row.publication_id) ?? [];
			if (metadataRows.length !== PRICE_CHANGE_ITEMS.length) continue;
			const metadataByName = new Map(metadataRows.map((item) => [item.item_name, item]));
			if (metadataByName.size !== PRICE_CHANGE_ITEMS.length) continue;
			let metadataValid = true;
			for (const itemName of PRICE_CHANGE_ITEMS) {
				const item = metadataByName.get(itemName);
				const manifestItem = manifest.items.find((candidate) => candidate.name === itemName);
				if (
					!item ||
					!manifestItem ||
					Number(item.item_count) !== manifestItem.count ||
					item.checksum !== manifestItem.sha256
				) {
					metadataValid = false;
					break;
				}
			}
			if (!metadataValid) continue;
			const itemRows = contextRowsByPublication.get(row.publication_id) ?? [];
			if (itemRows.length !== 1) continue;
			const item = itemRows[0];
			const manifestItem = manifest.items.find((candidate) => candidate.name === "context");
			if (
				item.item_name !== "context" ||
				!manifestItem ||
				typeof item.checksum !== "string" ||
				item.checksum !== manifestItem.sha256
			) {
				continue;
			}
			let payload: unknown;
			try {
				payload = typeof item.payload === "string" ? JSON.parse(item.payload) : item.payload;
				const serialized = canonicalJson(payload);
				if (
					Number(item.item_count) !== manifestItem.count ||
					payloadCount(payload) !== manifestItem.count ||
					Buffer.byteLength(serialized, "utf8") !== manifestItem.bytes ||
					sha256(serialized) !== manifestItem.sha256
				) {
					continue;
				}
			} catch {
				continue;
			}
			const publicationContext = parseContext(payload);
			const cursor = publicationContext ? cursorFromContext(manifest, publicationContext) : null;
			if (cursor) return row.status === "retired" ? { ...cursor, state: "STALE" } : cursor;
		}
		return null;
	} catch (error) {
		context.logger.warn(
			{
				err: error,
				dataset: PRICE_CHANGE_DATASET,
				seasonCode: context.currentSeason.seasonCode,
			},
			"Failed to load price-change cursor metadata from PostgreSQL"
		);
		return null;
	}
}

/** Kept as a local name for callers while the implementation is now a pure publication reader. */
export const requestPriceChangePredictions = readPriceChangePredictions;
