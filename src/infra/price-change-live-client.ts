import { createHash } from "node:crypto";
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
// The metadata-only cursor carries the validated deadline horizon. Keep an
// explicit envelope version so older hot payloads without that evidence are
// ignored rather than advertised by the lightweight cursor path.
const HOT_SCHEMA_VERSION = 3;
const HOT_REVISION_PATTERN = /^[0-9a-f]{16}$/;
const HOT_SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
	schemaVersion: typeof HOT_SCHEMA_VERSION;
	seasonCode: string;
	revision: string;
	triggerFingerprint: string;
	sourceHash: string;
	payloadHash: string;
	metadataHash: string;
	artifactId: string | null;
	deadline: string | null;
	nextDeadlines: string[];
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

const hotPayloadHash = (value: Record<string, unknown>): string => {
	const {
		payloadHash: _payloadHash,
		metadataHash: _metadataHash,
		reconciliation: _reconciliation,
		...immutable
	} = value;
	return createHash("sha256").update(JSON.stringify(immutable), "utf8").digest("hex");
};

const hotMetadataHash = (value: Record<string, unknown>): string => {
	const {
		metadataHash: _metadataHash,
		reconciliation: _reconciliation,
		board: _board,
		...immutable
	} = value;
	return createHash("sha256").update(JSON.stringify(immutable), "utf8").digest("hex");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

const isStrictlyIncreasingDateTimeList = (value: unknown): value is string[] => {
	if (!Array.isArray(value) || value.length === 0 || !value.every(isDateTimeString)) return false;
	for (let index = 1; index < value.length; index += 1) {
		if (Date.parse(value[index - 1]!) >= Date.parse(value[index]!)) return false;
	}
	return true;
};

const hotPointerKey = (seasonCode: string): string => `${HOT_KEY_PREFIX}:${seasonCode}:active`;

const parsePointer = (
	value: string | null
): { revision: string; payloadKey: string; payloadHash: string; metadataHash: string } | null => {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			!isRecord(parsed) ||
			typeof parsed.revision !== "string" ||
			typeof parsed.payloadKey !== "string" ||
			typeof parsed.payloadHash !== "string" ||
			!/^[0-9a-f]{64}$/.test(parsed.payloadHash) ||
			typeof parsed.metadataHash !== "string" ||
			!/^[0-9a-f]{64}$/.test(parsed.metadataHash)
		) {
			return null;
		}
		return {
			revision: parsed.revision,
			payloadKey: parsed.payloadKey,
			payloadHash: parsed.payloadHash,
			metadataHash: parsed.metadataHash,
		};
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
		value.schemaVersion !== HOT_SCHEMA_VERSION ||
		value.seasonCode !== seasonCode ||
		typeof value.revision !== "string" ||
		!/^[0-9a-f]{16}$/.test(value.revision) ||
		typeof value.triggerFingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.triggerFingerprint) ||
		typeof value.sourceHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.sourceHash) ||
		typeof value.payloadHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.payloadHash) ||
		typeof value.metadataHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.metadataHash) ||
		(value.artifactId !== null && typeof value.artifactId !== "string") ||
		!isDateTimeString(value.deadline) ||
		!isStrictlyIncreasingDateTimeList(value.nextDeadlines) ||
		value.deadline !== value.nextDeadlines[0] ||
		!isDateTimeString(value.detectedAt) ||
		!isDateTimeString(value.fetchedAt) ||
		!isDateTimeString(value.expiresAt) ||
		!Number.isSafeInteger(value.expectedPlayerCount) ||
		!isGraphQLInt(value.expectedPlayerCount) ||
		!Number.isSafeInteger(value.observedPlayerCount) ||
		!isGraphQLInt(value.observedPlayerCount) ||
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
		fetchedAt < detectedAt ||
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
	if (hotMetadataHash(value) !== value.metadataHash) return null;
	return {
		schemaVersion: HOT_SCHEMA_VERSION,
		seasonCode,
		revision: value.revision,
		triggerFingerprint: value.triggerFingerprint,
		sourceHash: value.sourceHash,
		payloadHash: value.payloadHash,
		metadataHash: value.metadataHash,
		artifactId: value.artifactId,
		deadline: value.deadline,
		nextDeadlines: value.nextDeadlines,
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
	if (hotPayloadHash(value) !== metadata.payloadHash) return null;
	const fetchedAt = Date.parse(metadata.fetchedAt);
	const board = parsePriceChangeBoardValue(value.board, now);
	if (
		!board ||
		(board.status !== "READY" && board.status !== "STALE") ||
		board.revision !== metadata.revision ||
		board.fetchedAt !== metadata.fetchedAt ||
		board.deadline !== metadata.deadline ||
		board.nextDeadlines.length !== metadata.nextDeadlines.length ||
		board.nextDeadlines.some((deadline, index) => deadline !== metadata.nextDeadlines[index]) ||
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

const sourceBoundHotPayloadKey = (
	seasonCode: string,
	revision: string,
	sourceHash: string
): string => `${HOT_KEY_PREFIX}:${seasonCode}:${revision}:${sourceHash}`;

const hotRevisionIndexKey = (seasonCode: string, revision: string): string =>
	`${HOT_KEY_PREFIX}:${seasonCode}:revision:${revision}:sources`;

const hotMetadataKey = (payloadKey: string): string => `${payloadKey}:metadata`;

const isSourceBoundHotPayloadKey = (
	seasonCode: string,
	revision: string,
	sourceHash: string,
	payloadKey: string
): boolean => payloadKey === sourceBoundHotPayloadKey(seasonCode, revision, sourceHash);

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
		if (pointer && !HOT_REVISION_PATTERN.test(pointer.revision)) return null;
		const payloadKeys = requestedRevision
			? await context.redis.smembers(
					hotRevisionIndexKey(context.currentSeason.seasonCode, requestedRevision)
				)
			: [pointer!.payloadKey];
		let newest: HotSnapshot | null = null;
		for (const payloadKey of payloadKeys) {
			const raw = await context.redis.get(payloadKey);
			if (!raw) continue;
			const parsed: unknown = JSON.parse(raw);
			const snapshot = parseHotSnapshot(parsed, context.currentSeason.seasonCode, now);
			if (
				!snapshot ||
				!HOT_REVISION_PATTERN.test(snapshot.revision) ||
				!HOT_SOURCE_HASH_PATTERN.test(snapshot.sourceHash) ||
				!isSourceBoundHotPayloadKey(
					context.currentSeason.seasonCode,
					snapshot.revision,
					snapshot.sourceHash,
					payloadKey
				) ||
				(requestedRevision !== undefined &&
					requestedRevision !== null &&
					snapshot.revision !== requestedRevision) ||
				(pointer &&
					(snapshot.revision !== pointer.revision ||
						snapshot.payloadHash !== pointer.payloadHash ||
						snapshot.metadataHash !== pointer.metadataHash))
			) {
				continue;
			}
			if (!newest || Date.parse(snapshot.detectedAt) > Date.parse(newest.detectedAt)) {
				newest = snapshot;
			}
		}
		return newest;
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
		if (!pointer || !HOT_REVISION_PATTERN.test(pointer.revision)) {
			return null;
		}
		const raw = await context.redis.get(hotMetadataKey(pointer.payloadKey));
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		const metadata = parseHotSnapshotMetadata(parsed, context.currentSeason.seasonCode, now);
		return metadata &&
			metadata.revision === pointer.revision &&
			metadata.payloadHash === pointer.payloadHash &&
			metadata.metadataHash === pointer.metadataHash &&
			HOT_SOURCE_HASH_PATTERN.test(metadata.sourceHash) &&
			isSourceBoundHotPayloadKey(
				context.currentSeason.seasonCode,
				metadata.revision,
				metadata.sourceHash,
				pointer.payloadKey
			)
			? metadata
			: null;
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
	if (!hot) return false;
	const hotDetectedAt = Date.parse(hot.detectedAt);
	const hotFetchedAt = Date.parse(hot.fetchedAt);
	const now = Date.now();
	if (
		!Number.isFinite(hotDetectedAt) ||
		!Number.isFinite(hotFetchedAt) ||
		hotDetectedAt > now ||
		hotFetchedAt > now ||
		hotFetchedAt < hotDetectedAt
	) {
		return false;
	}
	const durableStatus = durable && "status" in durable ? durable.status : durable?.state;
	if (!durable || durableStatus === "UNAVAILABLE" || !durable.fetchedAt) return true;
	const sourceCheckedAt = Date.parse(durable.sourceCheckedAt ?? "");
	const fetchedAt = Date.parse(durable.fetchedAt);
	// A future source timestamp cannot be ordering evidence. It may be clock
	// skew or corrupted publication metadata; fall back to the validated fetch
	// timestamp rather than suppressing a newer hot snapshot indefinitely.
	const durableAt =
		Number.isFinite(sourceCheckedAt) && sourceCheckedAt <= now
			? sourceCheckedAt
			: Number.isFinite(fetchedAt) && fetchedAt <= now
				? fetchedAt
				: NaN;
	// A hot response whose source was fetched before the durable boundary cannot
	// replace that durable publication, even when its request-start timestamp is
	// newer. This keeps slow/replayed provider bytes from winning the race.
	if (Number.isFinite(durableAt) && hotFetchedAt < durableAt) return false;
	return !Number.isFinite(durableAt) || hotFetchedAt > durableAt;
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
	const requestedRevisionInput = _requestedRevision;
	const requestedRevision =
		requestedRevisionInput === undefined || requestedRevisionInput === null
			? null
			: requestedRevisionInput.trim();
	if (
		requestedRevisionInput !== undefined &&
		requestedRevisionInput !== null &&
		!requestedRevision
	) {
		throw new GraphQLError("The requested live price revision is invalid", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	const requestedHotRevision = requestedRevision && HOT_REVISION_PATTERN.test(requestedRevision);
	const requestedDurableRevision =
		requestedRevision && isDataPublicationId(requestedRevision)
			? requestedRevision.toLowerCase()
			: null;
	if (requestedRevision && !requestedHotRevision && !requestedDurableRevision) {
		throw new GraphQLError("The requested live price revision is invalid", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	if (requestedRevision && requestedHotRevision) {
		const hot = await readHotSnapshot(context, now, requestedRevision);
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
			durablePublicationId: hot.reconciliation.durablePublicationId,
			board: hot.board,
		};
	}
	if (requestedRevision && requestedDurableRevision) {
		// The active durable Redis publication is already validated by the normal
		// reader. Prefer it for the cursor's exact active revision so a temporary
		// PostgreSQL outage does not turn an otherwise available board into a 503.
		const activeDurable = await readPriceChangePredictions(context);
		if (activeDurable.status !== "UNAVAILABLE" && activeDurable.revision === requestedRevision) {
			return {
				revision: activeDurable.revision,
				state: "DURABLE",
				detectedAt: activeDurable.fetchedAt,
				expiresAt: durableHardExpiresAt(activeDurable),
				durablePublicationId: activeDurable.revision,
				board: activeDurable,
			};
		}
		const requestedDurable = await readPriceChangePredictionsByPublicationId(
			context,
			requestedRevision
		);
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
	const [hot, durable] = await Promise.all([
		readHotSnapshot(context, now, requestedRevision),
		readPriceChangePredictions(context),
	]);
	if (requestedRevision) {
		if (!hot)
			throw new GraphQLError("The requested live price revision is unavailable", {
				extensions: { code: "PRICE_CHANGE_LIVE_REVISION_UNAVAILABLE" },
			});
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
