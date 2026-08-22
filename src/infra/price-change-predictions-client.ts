/**
 * Thin client for the Data service's official FPL price-change prediction
 * publication. This is intentionally a separate source from the historical
 * Market snapshot domain: an upstream miss is surfaced as UNAVAILABLE and is
 * never filled from historical price changes.
 */

import { DateTimeResolver } from "graphql-scalars";

const PRICE_CHANGE_TIMEOUT_MS = 5_000;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value);

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
		!isFiniteNumber(value.offset) ||
		!isFiniteNumber(value.projectedPercent) ||
		!isFiniteNumber(value.likelihood)
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
		!isSafeInteger(value.playerId) ||
		!isSafeInteger(value.playerCode) ||
		typeof value.webName !== "string" ||
		!isSafeInteger(value.teamId) ||
		typeof value.teamName !== "string" ||
		typeof value.teamShortName !== "string" ||
		(value.position !== "GKP" &&
			value.position !== "DEF" &&
			value.position !== "MID" &&
			value.position !== "FWD") ||
		!isFiniteNumber(value.currentPrice) ||
		!isFiniteNumber(value.selectedByPercent) ||
		!isFiniteNumber(value.progressPercent) ||
		!isFiniteNumber(value.hourlyRate) ||
		!isStatus(value.status) ||
		!isOwnershipTrend(value.ownershipTrend) ||
		!isSafeInteger(value.transfersInEvent) ||
		!isSafeInteger(value.transfersOutEvent) ||
		!isNullableDateTimeString(value.lockedUntil) ||
		typeof value.calibrating !== "boolean" ||
		!Array.isArray(value.projections)
	) {
		return null;
	}
	const projections = value.projections.map(parseProjection);
	if (projections.some((projection) => projection === null)) return null;
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

const parseBoard = (value: unknown): PriceChangeBoard | null => {
	if (!isRecord(value)) return null;
	if (
		(value.status !== "READY" &&
			value.status !== "PARTIAL" &&
			value.status !== "STALE" &&
			value.status !== "UNAVAILABLE") ||
		value.source !== "FPL_BOOTSTRAP" ||
		!isNullableDateTimeString(value.deadline) ||
		!Array.isArray(value.nextDeadlines) ||
		!value.nextDeadlines.every(isDateTimeString) ||
		!isNullableDateTimeString(value.fetchedAt) ||
		!isNullableDateTimeString(value.staleAt) ||
		typeof value.revision !== "string" ||
		!isSafeInteger(value.expectedPlayerCount) ||
		!isSafeInteger(value.observedPlayerCount) ||
		!Array.isArray(value.players)
	) {
		return null;
	}
	const players = value.players.map(parsePlayer);
	if (players.some((player) => player === null)) return null;
	return {
		status: value.status,
		source: "FPL_BOOTSTRAP",
		deadline: value.deadline,
		nextDeadlines: value.nextDeadlines,
		fetchedAt: value.fetchedAt,
		staleAt: value.staleAt,
		revision: value.revision,
		expectedPlayerCount: value.expectedPlayerCount,
		observedPlayerCount: value.observedPlayerCount,
		players: players as PriceChangePlayer[],
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

const readEnv = (key: "LETLETME_DATA_URL" | "LETLETME_DATA_API_KEY"): string => {
	const value = Bun.env[key] ?? process.env[key];
	return typeof value === "string" ? value.trim() : "";
};

export async function requestPriceChangePredictions(params?: {
	logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<PriceChangeBoard> {
	const baseUrl = readEnv("LETLETME_DATA_URL").replace(/\/+$/, "");
	if (!baseUrl) return unavailableBoard();

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), PRICE_CHANGE_TIMEOUT_MS);
	const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
	const apiKey = readEnv("LETLETME_DATA_API_KEY");
	if (apiKey) headers.set("x-api-key", apiKey);

	try {
		const response = await fetch(`${baseUrl}/internal/price-change-predictions/resolve`, {
			method: "POST",
			headers,
			body: "{}",
			signal: controller.signal,
		});
		if (!response.ok) {
			params?.logger?.warn(
				{ status: response.status },
				"Official price-change prediction endpoint returned a non-success response"
			);
			return unavailableBoard();
		}
		const body: unknown = await response.json().catch(() => null);
		if (!isRecord(body) || body.success !== true) return unavailableBoard();
		return parseBoard(body.data) ?? unavailableBoard();
	} catch (error) {
		params?.logger?.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Official price-change prediction endpoint unavailable"
		);
		return unavailableBoard();
	} finally {
		clearTimeout(timeoutId);
	}
}
