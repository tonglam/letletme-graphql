import type { GraphQLContext } from "../graphql/context";
import { GraphQLError } from "graphql";
import { DateTimeResolver } from "graphql-scalars";
import {
	PRICE_CHANGE_READY_MS,
	PRICE_CHANGE_MAX_AGE_MS,
	parsePriceChangeBoardValue,
	readPriceChangePredictions,
	readPriceChangePredictionsByPublicationId,
	readPriceChangePredictionsCursor,
	type PriceChangeDurableCursor,
	type PriceChangeBoard,
} from "./price-change-predictions-client";
import { isDataPublicationId } from "./data-publication";

const HOT_KEY_PREFIX = "fpl:price-changes:hot";
const HOT_TTL_MS = 15 * 60 * 1000;
const HOT_REVISION_PATTERN = /^[0-9a-f]{16}$/;

export type PriceChangeLiveState = "PROVISIONAL" | "DURABLE" | "UNAVAILABLE";

export type PriceChangeLiveCursor = {
	seasonCode: string;
	revision: string | null;
	state: PriceChangeLiveState;
	detectedAt: string | null;
	fetchedAt: string | null;
	expiresAt: string | null;
};

export type PriceChangeLiveBoard = {
	revision: string;
	state: PriceChangeLiveState;
	detectedAt: string | null;
	expiresAt: string | null;
	durablePublicationId: string | null;
	board: PriceChangeBoard;
};

type HotSnapshot = {
	schemaVersion: 1;
	seasonCode: string;
	revision: string;
	triggerFingerprint: string;
	sourceHash: string;
	artifactId: string | null;
	deadline: string | null;
	detectedAt: string;
	fetchedAt: string;
	expiresAt: string;
	expectedPlayerCount: number;
	observedPlayerCount: number;
	corePlayerCount: number | null;
	corePlayerDelta: number | null;
	board: PriceChangeBoard;
	reconciliation: {
		state: "pending" | "reconciled" | "failed";
		durablePublicationId: string | null;
		durableRevision: number | null;
		error: string | null;
	};
};

type HotSnapshotMetadata = Omit<HotSnapshot, "board">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isDateTimeString = (value: unknown): value is string => {
	if (typeof value !== "string") return false;
	try {
		DateTimeResolver.parseValue(value);
		return true;
	} catch {
		return false;
	}
};

const hotPointerKey = (seasonCode: string): string => `${HOT_KEY_PREFIX}:${seasonCode}:active`;

const parsePointer = (value: string | null): { revision: string; payloadKey: string } | null => {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			!isRecord(parsed) ||
			typeof parsed.revision !== "string" ||
			typeof parsed.payloadKey !== "string"
		) {
			return null;
		}
		return { revision: parsed.revision, payloadKey: parsed.payloadKey };
	} catch {
		return null;
	}
};

const parseHotSnapshotMetadata = (
	value: unknown,
	seasonCode: string,
	now: Date
): HotSnapshotMetadata | null => {
	if (!isRecord(value)) return null;
	if (
		value.schemaVersion !== 1 ||
		value.seasonCode !== seasonCode ||
		typeof value.revision !== "string" ||
		!/^[0-9a-f]{16}$/.test(value.revision) ||
		typeof value.triggerFingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.triggerFingerprint) ||
		typeof value.sourceHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.sourceHash) ||
		(value.artifactId !== null && typeof value.artifactId !== "string") ||
		(value.deadline !== null && !isDateTimeString(value.deadline)) ||
		!isDateTimeString(value.detectedAt) ||
		!isDateTimeString(value.fetchedAt) ||
		!isDateTimeString(value.expiresAt) ||
		!Number.isSafeInteger(value.expectedPlayerCount) ||
		!Number.isSafeInteger(value.observedPlayerCount) ||
		(value.expectedPlayerCount as number) <= 0 ||
		(value.observedPlayerCount as number) <= 0 ||
		(value.expectedPlayerCount as number) !== (value.observedPlayerCount as number) ||
		(value.corePlayerCount !== null && !Number.isSafeInteger(value.corePlayerCount)) ||
		(value.corePlayerDelta !== null && !Number.isSafeInteger(value.corePlayerDelta)) ||
		!isRecord(value.reconciliation)
	) {
		return null;
	}
	const detectedAt = Date.parse(value.detectedAt);
	const fetchedAt = Date.parse(value.fetchedAt);
	const expiresAt = Date.parse(value.expiresAt);
	if (
		!Number.isFinite(detectedAt) ||
		!Number.isFinite(fetchedAt) ||
		!Number.isFinite(expiresAt) ||
		detectedAt > now.getTime() ||
		fetchedAt > now.getTime() ||
		fetchedAt < now.getTime() - PRICE_CHANGE_MAX_AGE_MS ||
		expiresAt <= now.getTime() ||
		expiresAt !== detectedAt + HOT_TTL_MS
	) {
		return null;
	}
	const reconciliation = value.reconciliation;
	if (
		!["pending", "reconciled", "failed"].includes(String(reconciliation.state)) ||
		(reconciliation.durablePublicationId !== null &&
			typeof reconciliation.durablePublicationId !== "string") ||
		(reconciliation.durableRevision !== null &&
			!Number.isSafeInteger(reconciliation.durableRevision)) ||
		(reconciliation.error !== null && typeof reconciliation.error !== "string")
	) {
		return null;
	}
	if (
		reconciliation.state === "pending" &&
		(reconciliation.durablePublicationId !== null || reconciliation.durableRevision !== null)
	) {
		return null;
	}
	if (
		reconciliation.state === "reconciled" &&
		(reconciliation.durablePublicationId === null ||
			reconciliation.durableRevision === null ||
			!isDataPublicationId(reconciliation.durablePublicationId) ||
			typeof reconciliation.durableRevision !== "number" ||
			reconciliation.durableRevision <= 0 ||
			reconciliation.error !== null)
	) {
		return null;
	}
	if (
		reconciliation.state === "failed" &&
		(reconciliation.error === null ||
			reconciliation.durablePublicationId !== null ||
			reconciliation.durableRevision !== null)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		seasonCode,
		revision: value.revision,
		triggerFingerprint: value.triggerFingerprint,
		sourceHash: value.sourceHash,
		artifactId: value.artifactId,
		deadline: value.deadline,
		detectedAt: value.detectedAt,
		fetchedAt: value.fetchedAt,
		expiresAt: value.expiresAt,
		expectedPlayerCount: value.expectedPlayerCount as number,
		observedPlayerCount: value.observedPlayerCount as number,
		corePlayerCount: value.corePlayerCount as number | null,
		corePlayerDelta: value.corePlayerDelta as number | null,
		reconciliation: {
			state: reconciliation.state as HotSnapshot["reconciliation"]["state"],
			durablePublicationId: reconciliation.durablePublicationId as string | null,
			durableRevision: reconciliation.durableRevision as number | null,
			error: reconciliation.error as string | null,
		},
	};
};

const parseHotSnapshot = (value: unknown, seasonCode: string, now: Date): HotSnapshot | null => {
	const metadata = parseHotSnapshotMetadata(value, seasonCode, now);
	if (!metadata || !isRecord(value)) return null;
	const fetchedAt = Date.parse(metadata.fetchedAt);
	const board = parsePriceChangeBoardValue(value.board, now);
	if (
		!board ||
		(board.status !== "READY" && board.status !== "STALE") ||
		board.revision !== metadata.revision ||
		board.fetchedAt !== metadata.fetchedAt ||
		board.deadline !== metadata.deadline ||
		board.staleAt !== new Date(fetchedAt + PRICE_CHANGE_READY_MS).toISOString() ||
		metadata.expectedPlayerCount !== board.expectedPlayerCount ||
		metadata.observedPlayerCount !== board.observedPlayerCount ||
		metadata.expectedPlayerCount !== metadata.observedPlayerCount
	) {
		return null;
	}
	return {
		...metadata,
		board: {
			...board,
			status: now.getTime() - fetchedAt < PRICE_CHANGE_READY_MS ? "READY" : "STALE",
		},
	};
};

const hotPayloadKey = (seasonCode: string, revision: string): string =>
	`${HOT_KEY_PREFIX}:${seasonCode}:${revision}`;

const hotMetadataKey = (seasonCode: string, revision: string): string =>
	`${HOT_KEY_PREFIX}:${seasonCode}:${revision}:metadata`;

async function readHotSnapshot(
	context: GraphQLContext,
	now: Date,
	requestedRevision?: string | null
): Promise<HotSnapshot | null> {
	try {
		const pointer = requestedRevision
			? null
			: parsePointer(await context.redis.get(hotPointerKey(context.currentSeason.seasonCode)));
		if (!requestedRevision && !pointer) return null;
		if (
			pointer &&
			(pointer.payloadKey !== hotPayloadKey(context.currentSeason.seasonCode, pointer.revision) ||
				!HOT_REVISION_PATTERN.test(pointer.revision))
		) {
			return null;
		}
		const payloadKey = requestedRevision
			? hotPayloadKey(context.currentSeason.seasonCode, requestedRevision)
			: pointer!.payloadKey;
		const raw = await context.redis.get(payloadKey);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		const snapshot = parseHotSnapshot(parsed, context.currentSeason.seasonCode, now);
		if (!snapshot) return null;
		return requestedRevision
			? snapshot.revision === requestedRevision
				? snapshot
				: null
			: snapshot.revision === pointer!.revision
				? snapshot
				: null;
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to load price-change hot snapshot");
		return null;
	}
}

/**
 * Read only the active hot envelope metadata for cursor polling. The board
 * payload is intentionally not touched here; it is fetched only after the
 * client observes a new revision and asks for the revision-bound board.
 */
async function readHotSnapshotMetadata(
	context: GraphQLContext,
	now: Date
): Promise<HotSnapshotMetadata | null> {
	try {
		const pointer = parsePointer(
			await context.redis.get(hotPointerKey(context.currentSeason.seasonCode))
		);
		if (
			!pointer ||
			pointer.payloadKey !== hotPayloadKey(context.currentSeason.seasonCode, pointer.revision) ||
			!HOT_REVISION_PATTERN.test(pointer.revision)
		) {
			return null;
		}
		const raw = await context.redis.get(
			hotMetadataKey(context.currentSeason.seasonCode, pointer.revision)
		);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		const metadata = parseHotSnapshotMetadata(parsed, context.currentSeason.seasonCode, now);
		return metadata?.revision === pointer.revision ? metadata : null;
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to load price-change hot snapshot metadata");
		return null;
	}
}

function isNewerHotSnapshot(
	hot: HotSnapshotMetadata | null,
	durable:
		| Pick<PriceChangeBoard, "status" | "fetchedAt" | "sourceCheckedAt">
		| PriceChangeDurableCursor
		| null
): boolean {
	const durableStatus = durable && "status" in durable ? durable.status : durable?.state;
	if (!hot || !durable || durableStatus === "UNAVAILABLE" || !durable.fetchedAt)
		return Boolean(hot);
	const hotAt = Date.parse(hot.detectedAt);
	const durableAt = Date.parse(durable.sourceCheckedAt ?? durable.fetchedAt);
	return Number.isFinite(hotAt) && (!Number.isFinite(durableAt) || hotAt > durableAt);
}

function durableCursor(
	seasonCode: string,
	durable: PriceChangeDurableCursor | null
): PriceChangeLiveCursor {
	if (!durable) {
		return {
			seasonCode,
			revision: null,
			state: "UNAVAILABLE",
			detectedAt: null,
			fetchedAt: null,
			expiresAt: null,
		};
	}
	return {
		seasonCode,
		revision: durable.revision,
		state: "DURABLE",
		detectedAt: durable.fetchedAt,
		fetchedAt: durable.fetchedAt,
		expiresAt: durable.hardExpiresAt,
	};
}

function durableHardExpiresAt(board: PriceChangeBoard): string | null {
	if (!board.fetchedAt) return null;
	const fetchedAt = Date.parse(board.fetchedAt);
	return Number.isFinite(fetchedAt)
		? new Date(fetchedAt + PRICE_CHANGE_MAX_AGE_MS).toISOString()
		: null;
}

function durablePublicationId(durable: PriceChangeBoard, hot: HotSnapshot | null): string | null {
	if (durable.status !== "UNAVAILABLE") return durable.revision;
	return hot?.reconciliation.state === "reconciled"
		? hot.reconciliation.durablePublicationId
		: null;
}

export async function readPriceChangeLiveCursor(
	context: GraphQLContext
): Promise<PriceChangeLiveCursor> {
	const now = new Date();
	const [hot, durable] = await Promise.all([
		readHotSnapshotMetadata(context, now),
		readPriceChangePredictionsCursor(context, now),
	]);
	if (isNewerHotSnapshot(hot, durable)) {
		return {
			seasonCode: context.currentSeason.seasonCode,
			revision: hot!.revision,
			state: hot!.reconciliation.state === "reconciled" ? "DURABLE" : "PROVISIONAL",
			detectedAt: hot!.detectedAt,
			fetchedAt: hot!.fetchedAt,
			expiresAt: hot!.expiresAt,
		};
	}
	return durableCursor(context.currentSeason.seasonCode, durable);
}

export async function readPriceChangeLiveBoard(
	context: GraphQLContext,
	_requestedRevision?: string | null
): Promise<PriceChangeLiveBoard> {
	const now = new Date();
	const requestedRevision = _requestedRevision?.trim() || null;
	const requestedHotRevision = requestedRevision && HOT_REVISION_PATTERN.test(requestedRevision);
	const requestedDurableRevision = requestedRevision && isDataPublicationId(requestedRevision);
	if (requestedRevision && !requestedHotRevision && !requestedDurableRevision) {
		throw new GraphQLError("The requested live price revision is invalid", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	const [hot, durable] = await Promise.all([
		readHotSnapshot(context, now, requestedRevision),
		readPriceChangePredictions(context),
	]);
	if (requestedRevision) {
		if (requestedDurableRevision) {
			const requestedDurable =
				durable.revision === requestedRevision
					? durable
					: await readPriceChangePredictionsByPublicationId(context, requestedRevision);
			if (!requestedDurable || requestedDurable.status === "UNAVAILABLE") {
				throw new GraphQLError("The requested durable price revision is unavailable", {
					extensions: { code: "PRICE_CHANGE_LIVE_REVISION_UNAVAILABLE" },
				});
			}
			return {
				revision: requestedDurable.revision,
				state: "DURABLE",
				detectedAt: requestedDurable.fetchedAt,
				expiresAt: durableHardExpiresAt(requestedDurable),
				durablePublicationId: requestedDurable.revision,
				board: requestedDurable,
			};
		}
		if (!hot) {
			throw new GraphQLError("The requested live price revision is unavailable", {
				extensions: { code: "PRICE_CHANGE_LIVE_REVISION_UNAVAILABLE" },
			});
		}
		return {
			revision: hot.revision,
			state: hot.reconciliation.state === "reconciled" ? "DURABLE" : "PROVISIONAL",
			detectedAt: hot.detectedAt,
			expiresAt: hot.expiresAt,
			durablePublicationId:
				hot.reconciliation.durablePublicationId ?? durablePublicationId(durable, hot),
			board: hot.board,
		};
	}
	if (isNewerHotSnapshot(hot, durable)) {
		return {
			revision: hot!.revision,
			state: hot!.reconciliation.state === "reconciled" ? "DURABLE" : "PROVISIONAL",
			detectedAt: hot!.detectedAt,
			expiresAt: hot!.expiresAt,
			durablePublicationId:
				hot!.reconciliation.durablePublicationId ?? durablePublicationId(durable, hot),
			board: hot!.board,
		};
	}
	return {
		revision: durable.revision,
		state: durable.status === "UNAVAILABLE" ? "UNAVAILABLE" : "DURABLE",
		detectedAt: durable.fetchedAt,
		expiresAt: durableHardExpiresAt(durable),
		durablePublicationId: durablePublicationId(durable, hot),
		board: durable,
	};
}
