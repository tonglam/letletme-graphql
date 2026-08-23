/**
 * Thin client for the Data service's official manager-live publication.
 *
 * GraphQL treats this endpoint as authoritative for non-H2H manager headlines:
 * a missing/slow Data service must never turn a live board into a 5xx, but an
 * upstream miss is surfaced as UNAVAILABLE and is never replaced by a local
 * calculation or another manager-score source.
 */

import { metrics } from "./metrics";

// The GraphQL request path is cache-only. Data owns upstream refreshes in its
// manager-live worker, so a slow internal read must degrade to UNAVAILABLE
// instead of consuming the entire live-board latency budget.
const MANAGER_LIVE_TIMEOUT_MS = 1_000;

export type ManagerLiveSource = "FPL_ENTRY_SUMMARY" | "FPL_CLASSIC_STANDINGS" | "FPL_FINAL_RESULT";
export type ManagerLiveTotalScope = "OVERALL" | "CLASSIC_PHASE";
export type ManagerLiveDataAvailability = "FRESH" | "LAST_GOOD" | "PARTIAL" | "UNAVAILABLE";
export type ManagerLiveServedFrom = "REDIS" | "POSTGRES" | "MIXED" | "NONE";

export type ManagerLiveScoreRow = {
	season: string;
	eventId: number;
	entryId: number;
	eventPoints: number | null;
	netEventPoints: number | null;
	totalPoints: number | null;
	totalScope: ManagerLiveTotalScope;
	eventRank: number | null;
	overallRank: number | null;
	leagueRank: number | null;
	source: ManagerLiveSource;
	transferCost: number | null;
	eventPointSemantics: "GROSS" | "NET" | "ZERO_COST_EQUIVALENT" | "UNKNOWN";
	revision: string;
	checkedAt: string;
	upstreamUpdatedAt: string | null;
	staleAt: string;
};

export type ManagerLiveResolveResult = {
	season: string;
	eventId: number;
	managerRevision: string;
	dataAvailability: ManagerLiveDataAvailability;
	servedFrom: ManagerLiveServedFrom;
	refreshQueued: boolean;
	rows: ManagerLiveScoreRow[];
	missingEntryIds: number[];
	partial: boolean;
	errorCode: "UNSUPPORTED_H2H_LIVE" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_RATE_LIMITED" | null;
	checkedAt: string;
	nextRefreshAt: string;
};

export type ManagerLiveFetchResult = {
	season: string | null;
	rows: Map<number, ManagerLiveScoreRow>;
	errorCode: ManagerLiveResolveResult["errorCode"];
	managerRevision: string | null;
	dataAvailability: ManagerLiveDataAvailability;
	servedFrom: ManagerLiveServedFrom;
	refreshQueued: boolean;
	missingEntryIds: number[];
	checkedAt: string | null;
	nextRefreshAt: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableNumber = (value: unknown): value is number | null | undefined =>
	value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));

const isNullableString = (value: unknown): value is string | null | undefined =>
	value === null || value === undefined || typeof value === "string";

const isIsoDateString = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const isSeasonCode = (value: unknown): value is string =>
	typeof value === "string" && /^\d{4}$/.test(value);

const isManagerDataAvailability = (value: unknown): value is ManagerLiveDataAvailability =>
	value === "FRESH" || value === "LAST_GOOD" || value === "PARTIAL" || value === "UNAVAILABLE";

const isManagerServedFrom = (value: unknown): value is ManagerLiveServedFrom =>
	value === "REDIS" || value === "POSTGRES" || value === "MIXED" || value === "NONE";

const parsePositiveIntegerList = (value: unknown): number[] | null => {
	if (!Array.isArray(value)) return null;
	const parsed: number[] = [];
	for (const item of value as unknown[]) {
		if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) return null;
		parsed.push(item);
	}
	return parsed;
};

const readEnv = (key: "LETLETME_DATA_URL" | "LETLETME_DATA_API_KEY"): string => {
	const value = Bun.env[key] ?? process.env[key];
	return typeof value === "string" ? value.trim() : "";
};

const unavailableResult = (
	errorCode: ManagerLiveFetchResult["errorCode"] = "UPSTREAM_UNAVAILABLE"
): ManagerLiveFetchResult => ({
	season: null,
	rows: new Map(),
	errorCode,
	managerRevision: null,
	dataAvailability: "UNAVAILABLE",
	servedFrom: "NONE",
	refreshQueued: false,
	missingEntryIds: [],
	checkedAt: null,
	nextRefreshAt: null,
});

const parseRow = (value: unknown): ManagerLiveScoreRow | null => {
	if (!isRecord(value)) return null;
	if (
		typeof value.entryId !== "number" ||
		!Number.isSafeInteger(value.entryId) ||
		value.entryId <= 0 ||
		typeof value.eventId !== "number" ||
		!Number.isSafeInteger(value.eventId) ||
		value.eventId <= 0 ||
		!isIsoDateString(value.checkedAt) ||
		typeof value.revision !== "string" ||
		value.revision.length === 0 ||
		(value.source !== "FPL_ENTRY_SUMMARY" &&
			value.source !== "FPL_CLASSIC_STANDINGS" &&
			value.source !== "FPL_FINAL_RESULT") ||
		(value.totalScope !== "OVERALL" && value.totalScope !== "CLASSIC_PHASE") ||
		!isSeasonCode(value.season) ||
		!isIsoDateString(value.staleAt) ||
		!isNullableNumber(value.eventPoints) ||
		!isNullableNumber(value.netEventPoints) ||
		!isNullableNumber(value.totalPoints) ||
		!isNullableNumber(value.eventRank) ||
		!isNullableNumber(value.overallRank) ||
		!isNullableNumber(value.leagueRank) ||
		!isNullableNumber(value.transferCost) ||
		(value.eventPointSemantics !== "GROSS" &&
			value.eventPointSemantics !== "NET" &&
			value.eventPointSemantics !== "ZERO_COST_EQUIVALENT" &&
			value.eventPointSemantics !== "UNKNOWN") ||
		!isNullableString(value.upstreamUpdatedAt) ||
		(typeof value.upstreamUpdatedAt === "string" && !isIsoDateString(value.upstreamUpdatedAt))
	) {
		return null;
	}
	return {
		...(value as unknown as ManagerLiveScoreRow),
		netEventPoints: typeof value.netEventPoints === "number" ? value.netEventPoints : null,
	};
};

/** Fetch official manager rows for one GraphQL batch. Never throws on upstream failure. */
export async function requestManagerLiveScores(params: {
	eventId: number;
	entryIds: readonly number[];
	tournamentId?: number;
	expectedSeason?: string;
	logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<ManagerLiveFetchResult> {
	const baseUrl = readEnv("LETLETME_DATA_URL").replace(/\/+$/, "");
	if (!baseUrl || params.entryIds.length === 0) {
		metrics.managerLiveUpstreamRequestsTotal.labels("not_configured").inc();
		return unavailableResult();
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), MANAGER_LIVE_TIMEOUT_MS);
	const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
	const apiKey = readEnv("LETLETME_DATA_API_KEY");
	if (apiKey) headers.set("x-api-key", apiKey);
	const startedAt = performance.now();

	try {
		const response = await fetch(`${baseUrl}/internal/manager-live/resolve`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				eventId: params.eventId,
				entryIds: params.entryIds,
				readMode: "CACHE_ONLY",
				...(params.tournamentId === undefined ? {} : { tournamentId: params.tournamentId }),
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			metrics.managerLiveUpstreamRequestsTotal
				.labels(`http_${response.status >= 500 ? "5xx" : response.status === 429 ? "429" : "4xx"}`)
				.inc();
			params.logger?.warn(
				{ eventId: params.eventId, status: response.status },
				"Official manager live endpoint returned a non-success response"
			);
			return unavailableResult(
				response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE"
			);
		}
		const body: unknown = await response.json().catch(() => null);
		if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return unavailableResult();
		}
		const data = body.data;
		if (
			typeof data.eventId !== "number" ||
			!Number.isSafeInteger(data.eventId) ||
			data.eventId !== params.eventId ||
			!isSeasonCode(data.season) ||
			(params.expectedSeason !== undefined && data.season !== params.expectedSeason) ||
			typeof data.managerRevision !== "string" ||
			data.managerRevision.length === 0 ||
			!isManagerDataAvailability(data.dataAvailability) ||
			!isManagerServedFrom(data.servedFrom) ||
			typeof data.refreshQueued !== "boolean" ||
			!Array.isArray(data.rows) ||
			!Array.isArray(data.missingEntryIds) ||
			typeof data.partial !== "boolean" ||
			(data.errorCode !== null &&
				data.errorCode !== "UNSUPPORTED_H2H_LIVE" &&
				data.errorCode !== "UPSTREAM_UNAVAILABLE" &&
				data.errorCode !== "UPSTREAM_RATE_LIMITED") ||
			!isIsoDateString(data.checkedAt) ||
			!isIsoDateString(data.nextRefreshAt)
		) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return unavailableResult();
		}
		const parsedRows = data.rows.map(parseRow);
		if (parsedRows.some((row) => row === null)) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return unavailableResult();
		}
		const validRows = parsedRows as ManagerLiveScoreRow[];
		const requestedEntryIds = new Set(params.entryIds);
		const rowEntryIds = validRows.map((row) => row.entryId);
		const missingEntryIds = parsePositiveIntegerList(data.missingEntryIds);
		if (!missingEntryIds) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return unavailableResult();
		}
		if (
			rowEntryIds.some(
				(entryId, index) =>
					!requestedEntryIds.has(entryId) || rowEntryIds.indexOf(entryId) !== index
			) ||
			missingEntryIds.some(
				(entryId, index) =>
					!requestedEntryIds.has(entryId) ||
					missingEntryIds.indexOf(entryId) !== index ||
					rowEntryIds.includes(entryId)
			) ||
			new Set([...rowEntryIds, ...missingEntryIds]).size !== requestedEntryIds.size ||
			validRows.some((row) => row.eventId !== params.eventId || row.season !== data.season) ||
			data.partial !== missingEntryIds.length > 0
		) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return unavailableResult();
		}
		const rows = new Map(validRows.map((row) => [row.entryId, row]));
		const errorCode =
			data.errorCode === "UNSUPPORTED_H2H_LIVE" ||
			data.errorCode === "UPSTREAM_UNAVAILABLE" ||
			data.errorCode === "UPSTREAM_RATE_LIMITED"
				? data.errorCode
				: null;
		metrics.managerLiveUpstreamRequestsTotal.labels(errorCode ? "partial" : "success").inc();
		return {
			season: data.season,
			rows,
			errorCode,
			managerRevision: data.managerRevision,
			dataAvailability: data.dataAvailability,
			servedFrom: data.servedFrom,
			refreshQueued: data.refreshQueued,
			missingEntryIds,
			checkedAt: data.checkedAt,
			nextRefreshAt: data.nextRefreshAt,
		};
	} catch (error) {
		metrics.managerLiveUpstreamRequestsTotal.labels("error").inc();
		params.logger?.warn(
			{ eventId: params.eventId, error: error instanceof Error ? error.message : String(error) },
			"Official manager live endpoint unavailable"
		);
		return unavailableResult();
	} finally {
		metrics.managerLiveUpstreamLatencySeconds.observe((performance.now() - startedAt) / 1000);
		clearTimeout(timeoutId);
	}
}
