/**
 * Thin client for the Data service's official manager-live publication.
 *
 * GraphQL treats this endpoint as authoritative for non-H2H manager headlines:
 * a missing/slow Data service must never turn a live board into a 5xx, but an
 * upstream miss is surfaced as UNAVAILABLE and is never replaced by a local
 * calculation or another manager-score source.
 */

import { metrics } from "./metrics";

// A cold classic tournament request can refresh standings and enrich the
// roster with official entry summaries. Keep enough room for that bounded
// upstream crawl before treating the Data service as unavailable.
const MANAGER_LIVE_TIMEOUT_MS = 15_000;

export type ManagerLiveSource = "FPL_ENTRY_SUMMARY" | "FPL_CLASSIC_STANDINGS" | "FPL_FINAL_RESULT";
export type ManagerLiveTotalScope = "OVERALL" | "CLASSIC_PHASE";

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
	rows: ManagerLiveScoreRow[];
	missingEntryIds: number[];
	partial: boolean;
	errorCode: "UNSUPPORTED_H2H_LIVE" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_RATE_LIMITED" | null;
	checkedAt: string;
	nextRefreshAt: string;
};

export type ManagerLiveFetchResult = {
	rows: Map<number, ManagerLiveScoreRow>;
	errorCode: ManagerLiveResolveResult["errorCode"];
	nextRefreshAt: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableNumber = (value: unknown): value is number | null | undefined =>
	value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));

const isNullableString = (value: unknown): value is string | null | undefined =>
	value === null || value === undefined || typeof value === "string";

const readEnv = (key: "LETLETME_DATA_URL" | "LETLETME_DATA_API_KEY"): string => {
	const value = Bun.env[key] ?? process.env[key];
	return typeof value === "string" ? value.trim() : "";
};

const parseRow = (value: unknown): ManagerLiveScoreRow | null => {
	if (!isRecord(value)) return null;
	if (
		typeof value.entryId !== "number" ||
		!Number.isSafeInteger(value.entryId) ||
		typeof value.eventId !== "number" ||
		!Number.isSafeInteger(value.eventId) ||
		typeof value.checkedAt !== "string" ||
		typeof value.revision !== "string" ||
		(value.source !== "FPL_ENTRY_SUMMARY" &&
			value.source !== "FPL_CLASSIC_STANDINGS" &&
			value.source !== "FPL_FINAL_RESULT") ||
		(value.totalScope !== "OVERALL" && value.totalScope !== "CLASSIC_PHASE") ||
		typeof value.season !== "string" ||
		typeof value.staleAt !== "string" ||
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
		!isNullableString(value.upstreamUpdatedAt)
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
	logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<ManagerLiveFetchResult> {
	const baseUrl = readEnv("LETLETME_DATA_URL").replace(/\/+$/, "");
	if (!baseUrl || params.entryIds.length === 0) {
		metrics.managerLiveUpstreamRequestsTotal.labels("not_configured").inc();
		return { rows: new Map(), errorCode: "UPSTREAM_UNAVAILABLE", nextRefreshAt: null };
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
			return {
				rows: new Map(),
				errorCode: response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
				nextRefreshAt: null,
			};
		}
		const body: unknown = await response.json().catch(() => null);
		if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return { rows: new Map(), errorCode: "UPSTREAM_UNAVAILABLE", nextRefreshAt: null };
		}
		const data = body.data;
		if (
			typeof data.eventId !== "number" ||
			!Number.isSafeInteger(data.eventId) ||
			data.eventId !== params.eventId ||
			typeof data.season !== "string" ||
			typeof data.checkedAt !== "string"
		) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return { rows: new Map(), errorCode: "UPSTREAM_UNAVAILABLE", nextRefreshAt: null };
		}
		const parsedRows = Array.isArray(data.rows)
			? data.rows
					.map(parseRow)
					.filter(
						(row): row is ManagerLiveScoreRow => row !== null && row.eventId === params.eventId
					)
			: [];
		const rows = new Map(parsedRows.map((row) => [row.entryId, row]));
		const errorCode =
			data.errorCode === "UNSUPPORTED_H2H_LIVE" ||
			data.errorCode === "UPSTREAM_UNAVAILABLE" ||
			data.errorCode === "UPSTREAM_RATE_LIMITED"
				? data.errorCode
				: null;
		metrics.managerLiveUpstreamRequestsTotal.labels(errorCode ? "partial" : "success").inc();
		return {
			rows,
			errorCode,
			nextRefreshAt: typeof data.nextRefreshAt === "string" ? data.nextRefreshAt : null,
		};
	} catch (error) {
		metrics.managerLiveUpstreamRequestsTotal.labels("error").inc();
		params.logger?.warn(
			{ eventId: params.eventId, error: error instanceof Error ? error.message : String(error) },
			"Official manager live endpoint unavailable"
		);
		return { rows: new Map(), errorCode: "UPSTREAM_UNAVAILABLE", nextRefreshAt: null };
	} finally {
		metrics.managerLiveUpstreamLatencySeconds.observe((performance.now() - startedAt) / 1000);
		clearTimeout(timeoutId);
	}
}
