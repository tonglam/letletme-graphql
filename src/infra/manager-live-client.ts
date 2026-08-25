/**
 * Thin client for the Data service's official manager-live publication.
 *
 * During an active event, GraphQL uses this endpoint only for manager/rank
 * metadata and reconciliation. The score itself is rebuilt from the coherent
 * event-live publication. After data_checked, the final result row is
 * authoritative.
 */

import { metrics } from "./metrics";

// GraphQL only reads Data's cache/checkpoint. Refresh work belongs to the Data
// worker, so an internal miss must degrade to a bounded unavailable result
// instead of consuming the Web/GraphQL 15-second request budget.
const MANAGER_LIVE_TIMEOUT_MS = 1_000;

export type ManagerLiveSource =
	"FPL_EVENT_LIVE" | "FPL_ENTRY_SUMMARY" | "FPL_CLASSIC_STANDINGS" | "FPL_FINAL_RESULT";
export type ManagerLiveTotalScope = "OVERALL" | "CLASSIC_PHASE";
export type ManagerLiveDataAvailability = "FRESH" | "LAST_GOOD" | "PARTIAL" | "UNAVAILABLE";
export type ManagerLiveServedFrom = "REDIS" | "POSTGRES" | "MIXED" | "NONE";
export type ManagerLiveCoverageState = "WARMING" | "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export type ManagerLiveTournamentCoverage = {
	rosterRevision: string | null;
	expectedEntries: number;
	resolvedEntries: number;
	fullyFetchedAt: string | null;
	managerRevision: string | null;
	error: string | null;
	state: ManagerLiveCoverageState;
};

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
	managerRevision?: string | null;
	dataAvailability?: ManagerLiveDataAvailability;
	servedFrom?: ManagerLiveServedFrom;
	refreshQueued?: boolean;
	rows: ManagerLiveScoreRow[];
	missingEntryIds: number[];
	partial: boolean;
	errorCode: "UNSUPPORTED_H2H_LIVE" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_RATE_LIMITED" | null;
	checkedAt: string;
	nextRefreshAt: string | null;
	tournamentCoverage?: ManagerLiveTournamentCoverage | null;
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
	tournamentCoverage?: ManagerLiveTournamentCoverage | null;
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

const emptyResult = (
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
	tournamentCoverage: null,
	nextRefreshAt: null,
});

const parseCoverage = (value: unknown): ManagerLiveTournamentCoverage | null => {
	if (!isRecord(value)) return null;
	const state = value.state;
	if (
		(state !== "WARMING" &&
			state !== "COMPLETE" &&
			state !== "PARTIAL" &&
			state !== "UNAVAILABLE") ||
		typeof value.expectedEntries !== "number" ||
		!Number.isSafeInteger(value.expectedEntries) ||
		typeof value.resolvedEntries !== "number" ||
		!Number.isSafeInteger(value.resolvedEntries)
	) {
		return null;
	}
	return {
		rosterRevision: typeof value.rosterRevision === "string" ? value.rosterRevision : null,
		expectedEntries: value.expectedEntries,
		resolvedEntries: value.resolvedEntries,
		fullyFetchedAt: typeof value.fullyFetchedAt === "string" ? value.fullyFetchedAt : null,
		managerRevision: typeof value.managerRevision === "string" ? value.managerRevision : null,
		error: typeof value.error === "string" ? value.error : null,
		state,
	};
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
		(value.source !== "FPL_EVENT_LIVE" &&
			value.source !== "FPL_ENTRY_SUMMARY" &&
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
	readMode?: "CACHE_ONLY" | "READ_THROUGH";
	logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<ManagerLiveFetchResult> {
	const baseUrl = readEnv("LETLETME_DATA_URL").replace(/\/+$/, "");
	if (!baseUrl || params.entryIds.length === 0) {
		metrics.managerLiveUpstreamRequestsTotal.labels("not_configured").inc();
		return emptyResult();
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
				readMode: params.readMode ?? "CACHE_ONLY",
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
			return emptyResult(
				response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE"
			);
		}
		const body: unknown = await response.json().catch(() => null);
		if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return emptyResult();
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
			return emptyResult();
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
			season: data.season,
			rows,
			errorCode,
			managerRevision: typeof data.managerRevision === "string" ? data.managerRevision : null,
			dataAvailability:
				data.dataAvailability === "FRESH" ||
				data.dataAvailability === "LAST_GOOD" ||
				data.dataAvailability === "PARTIAL" ||
				data.dataAvailability === "UNAVAILABLE"
					? data.dataAvailability
					: rows.size > 0
						? "PARTIAL"
						: "UNAVAILABLE",
			servedFrom:
				data.servedFrom === "REDIS" ||
				data.servedFrom === "POSTGRES" ||
				data.servedFrom === "MIXED" ||
				data.servedFrom === "NONE"
					? data.servedFrom
					: "NONE",
			refreshQueued: data.refreshQueued === true,
			missingEntryIds: Array.isArray(data.missingEntryIds)
				? data.missingEntryIds.filter(
						(value): value is number =>
							typeof value === "number" && Number.isSafeInteger(value) && value > 0
					)
				: params.entryIds.filter((entryId) => !rows.has(entryId)),
			checkedAt: data.checkedAt,
			tournamentCoverage: parseCoverage(data.tournamentCoverage),
			nextRefreshAt: typeof data.nextRefreshAt === "string" ? data.nextRefreshAt : null,
		};
	} catch (error) {
		metrics.managerLiveUpstreamRequestsTotal.labels("error").inc();
		params.logger?.warn(
			{ eventId: params.eventId, error: error instanceof Error ? error.message : String(error) },
			"Official manager live endpoint unavailable"
		);
		return emptyResult();
	} finally {
		metrics.managerLiveUpstreamLatencySeconds.observe((performance.now() - startedAt) / 1000);
		clearTimeout(timeoutId);
	}
}
