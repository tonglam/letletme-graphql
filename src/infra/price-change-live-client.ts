import type { GraphQLContext } from "../graphql/context";
import {
	parsePriceChangeBoardValue,
	readPriceChangePredictions,
	type PriceChangeBoard,
} from "./price-change-predictions-client";

const HOT_KEY_PREFIX = "fpl:price-changes:hot";
const HOT_TTL_MS = 15 * 60 * 1000;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

const parseHotSnapshot = (value: unknown, seasonCode: string, now: Date): HotSnapshot | null => {
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
		(value.deadline !== null && typeof value.deadline !== "string") ||
		typeof value.detectedAt !== "string" ||
		typeof value.fetchedAt !== "string" ||
		typeof value.expiresAt !== "string" ||
		!Number.isSafeInteger(value.expectedPlayerCount) ||
		!Number.isSafeInteger(value.observedPlayerCount) ||
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
		expiresAt <= now.getTime() ||
		expiresAt !== detectedAt + HOT_TTL_MS
	) {
		return null;
	}
	const board = parsePriceChangeBoardValue(value.board, now);
	if (
		!board ||
		board.status !== "READY" ||
		board.revision !== value.revision ||
		board.deadline !== value.deadline ||
		value.expectedPlayerCount !== board.expectedPlayerCount ||
		value.observedPlayerCount !== board.observedPlayerCount ||
		value.expectedPlayerCount !== value.observedPlayerCount
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
		expectedPlayerCount: value.expectedPlayerCount,
		observedPlayerCount: value.observedPlayerCount,
		corePlayerCount:
			value.corePlayerCount === null || Number.isSafeInteger(value.corePlayerCount)
				? (value.corePlayerCount as number | null)
				: null,
		corePlayerDelta:
			value.corePlayerDelta === null || Number.isSafeInteger(value.corePlayerDelta)
				? (value.corePlayerDelta as number | null)
				: null,
		board,
		reconciliation: {
			state: reconciliation.state as HotSnapshot["reconciliation"]["state"],
			durablePublicationId: reconciliation.durablePublicationId as string | null,
			durableRevision: reconciliation.durableRevision as number | null,
			error: reconciliation.error as string | null,
		},
	};
};

async function readHotSnapshot(context: GraphQLContext, now: Date): Promise<HotSnapshot | null> {
	try {
		const pointer = parsePointer(
			await context.redis.get(hotPointerKey(context.currentSeason.seasonCode))
		);
		if (!pointer) return null;
		const raw = await context.redis.get(pointer.payloadKey);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		const snapshot = parseHotSnapshot(parsed, context.currentSeason.seasonCode, now);
		return snapshot?.revision === pointer.revision ? snapshot : null;
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to load price-change hot snapshot");
		return null;
	}
}

function isNewerHotSnapshot(hot: HotSnapshot | null, durable: PriceChangeBoard): boolean {
	if (!hot || durable.status === "UNAVAILABLE" || !durable.fetchedAt) return Boolean(hot);
	const hotAt = Date.parse(hot.fetchedAt);
	const durableAt = Date.parse(durable.fetchedAt);
	return Number.isFinite(hotAt) && (!Number.isFinite(durableAt) || hotAt > durableAt);
}

function durableCursor(seasonCode: string, board: PriceChangeBoard): PriceChangeLiveCursor {
	if (board.status === "UNAVAILABLE") {
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
		revision: board.revision,
		state: "DURABLE",
		detectedAt: board.fetchedAt,
		fetchedAt: board.fetchedAt,
		expiresAt: board.staleAt,
	};
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
		readHotSnapshot(context, now),
		readPriceChangePredictions(context),
	]);
	if (isNewerHotSnapshot(hot, durable)) {
		return {
			seasonCode: context.currentSeason.seasonCode,
			revision: hot!.revision,
			state: "PROVISIONAL",
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
	const [hot, durable] = await Promise.all([
		readHotSnapshot(context, now),
		readPriceChangePredictions(context),
	]);
	if (isNewerHotSnapshot(hot, durable)) {
		return {
			revision: hot!.revision,
			state: "PROVISIONAL",
			detectedAt: hot!.detectedAt,
			expiresAt: hot!.expiresAt,
			durablePublicationId: durablePublicationId(durable, hot),
			board: hot!.board,
		};
	}
	return {
		revision: durable.revision,
		state: durable.status === "UNAVAILABLE" ? "UNAVAILABLE" : "DURABLE",
		detectedAt: durable.fetchedAt,
		expiresAt: durable.staleAt,
		durablePublicationId: durablePublicationId(durable, hot),
		board: durable,
	};
}
