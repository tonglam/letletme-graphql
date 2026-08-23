import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { DateTimeResolver } from "graphql-scalars";
import type { GraphQLContext } from "../graphql/context";
import {
	parseDataPublicationManifest,
	readDataPublicationItemsObserved,
	type DataPublication,
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

export type PriceChangeBoardStatus = "READY" | "PARTIAL" | "STALE" | "UNAVAILABLE";

export type PriceChangeBoard = {
	status: PriceChangeBoardStatus;
	source: "FPL_BOOTSTRAP";
	deadline: string | null;
	nextDeadlines: string[];
	fetchedAt: string | null;
	staleAt: string | null;
	revision: string;
	expectedPlayerCount: number;
	observedPlayerCount: number;
	players: PriceChangePlayer[];
};

type PriceChangePublicationContext = {
	schemaVersion: 1;
	source: "FPL_BOOTSTRAP";
	fetchedAt: string;
	staleAt: string;
	hardExpiresAt: string;
	deadline: string;
	nextDeadlines: string[];
	expectedPlayerCount: number;
	observedPlayerCount: number;
};

const CONTEXT_FIELDS = [
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
});

const parseContext = (value: unknown): PriceChangePublicationContext | null => {
	if (!isRecord(value) || !hasExactFields(value, CONTEXT_FIELDS)) return null;
	if (
		value.schemaVersion !== 1 ||
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
	return {
		schemaVersion: 1,
		source: "FPL_BOOTSTRAP",
		fetchedAt: value.fetchedAt,
		staleAt: value.staleAt,
		hardExpiresAt: value.hardExpiresAt,
		deadline: value.deadline,
		nextDeadlines: value.nextDeadlines,
		expectedPlayerCount: value.expectedPlayerCount,
		observedPlayerCount: value.observedPlayerCount,
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
	const ageMs = now.getTime() - Date.parse(context.fetchedAt);
	if (ageMs > PRICE_CHANGE_MAX_AGE_MS) return unavailableBoard();
	return {
		status: ageMs < PRICE_CHANGE_READY_MS ? "READY" : "STALE",
		source: "FPL_BOOTSTRAP",
		deadline: context.deadline,
		nextDeadlines: [...context.nextDeadlines],
		fetchedAt: context.fetchedAt,
		staleAt: context.staleAt,
		revision: publication.manifest.publicationId,
		expectedPlayerCount: context.expectedPlayerCount,
		observedPlayerCount: context.observedPlayerCount,
		players: [...players].sort((left, right) => left.playerId - right.playerId),
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

type ActivePublicationRow = QueryResultRow & {
	publication_id: string;
	revision: string | number;
	manifest: unknown;
};

type PublicationItemRow = QueryResultRow & {
	item_name: string;
	item_count: string | number;
	checksum: string;
	payload: unknown;
};

const ACTIVE_PUBLICATION_SQL = `
	SELECT publication_id::text AS publication_id, revision::text AS revision, manifest
	FROM ops.dataset_publications
	WHERE dataset = 'fpl:price-changes'
	  AND season_id = $1
	  AND event_id IS NULL
	  AND status = 'active'
	ORDER BY revision DESC
	LIMIT 2
`;

const PUBLICATION_ITEMS_SQL = `
	SELECT item_name, item_count, checksum, payload
	FROM ops.dataset_publication_items
	WHERE publication_id = $1::uuid
	ORDER BY item_name
`;

const loadPriceChangePublicationFromPostgres = async (
	context: GraphQLContext
): Promise<DataPublication | null> => {
	const authority = await context.database.query<ActivePublicationRow>(ACTIVE_PUBLICATION_SQL, [
		context.currentSeason.seasonId,
	]);
	if (authority.rows.length !== 1) return null;
	const row = authority.rows[0];
	const rawManifest =
		typeof row.manifest === "string" ? row.manifest : (JSON.stringify(row.manifest) ?? "");
	const manifest = parseDataPublicationManifest(rawManifest, {
		dataset: PRICE_CHANGE_DATASET,
		seasonCode: context.currentSeason.seasonCode,
	});
	const revision = Number(row.revision);
	if (
		!manifest ||
		!Number.isSafeInteger(revision) ||
		manifest.publicationId !== row.publication_id ||
		manifest.revision !== revision ||
		manifest.items.length !== PRICE_CHANGE_ITEMS.length
	) {
		return null;
	}
	const itemResult = await context.database.query<PublicationItemRow>(PUBLICATION_ITEMS_SQL, [
		row.publication_id,
	]);
	if (itemResult.rows.length !== PRICE_CHANGE_ITEMS.length) return null;
	const items: Record<string, unknown> = {};
	const seen = new Set<string>();
	for (const item of itemResult.rows) {
		if (
			seen.has(item.item_name) ||
			!PRICE_CHANGE_ITEMS.includes(item.item_name as (typeof PRICE_CHANGE_ITEMS)[number])
		) {
			return null;
		}
		const manifestItem = manifest.items.find((candidate) => candidate.name === item.item_name);
		if (
			!manifestItem ||
			typeof item.checksum !== "string" ||
			item.checksum !== manifestItem.sha256
		) {
			return null;
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
				return null;
			}
		} catch {
			return null;
		}
		seen.add(item.item_name);
		items[item.item_name] = payload;
	}
	if (seen.size !== PRICE_CHANGE_ITEMS.length) return null;
	return { manifest, items };
};

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
	const postgresPublication = await loadPriceChangePublicationFromPostgres(context).catch(
		() => null
	);
	if (postgresPublication) {
		const board = parsePublicationBoard(postgresPublication, new Date());
		if (board) return board;
	}
	return unavailableBoard();
}

/** Kept as a local name for callers while the implementation is now a pure publication reader. */
export const requestPriceChangePredictions = readPriceChangePredictions;
