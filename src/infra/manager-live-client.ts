/**
 * Thin client for the Data service's official manager-live publication.
 *
 * Data is the sole manager-score authority. Active events use the projected
 * event-live materialization; after data_checked the final result row is used.
 */

import { metrics } from "./metrics";

// A cold classic tournament request can refresh standings and enrich the
// roster with official entry summaries. Keep enough room for that bounded
// upstream crawl before treating the Data service as unavailable.
const MANAGER_LIVE_TIMEOUT_MS = 15_000;
const PROJECTED_ALGORITHM_VERSION = "fpl-projected-autosubs-v1";

export type ManagerLiveSource = "FPL_EVENT_LIVE" | "FPL_FINAL_RESULT";
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

export type ManagerLiveCalculationMode = "PROJECTED_AUTOSUBS" | "FINAL_RESULT";

export type ManagerScoreProvenance = {
	scoreSource: "FPL_EVENT_LIVE" | "FPL_FINAL_RESULT";
	calculationMode: ManagerLiveCalculationMode;
	algorithmVersion: string | null;
	inputRevision: string;
	scoreRevision: string;
	rankRevision: string | null;
	livePublicationId: string | null;
	liveRevision: string | null;
	liveCheckedAt: string | null;
	picksRevision: string | null;
	picksCheckedAt: string | null;
	previousTotalsRevision: string | null;
	previousTotalsThroughEventId: number | null;
	resultRevision: string | null;
	resultCheckedAt: string | null;
	dataCheckedAt: string | null;
	rankSource: "FPL_ENTRY_SUMMARY" | "FPL_CLASSIC_STANDINGS" | null;
	rankCheckedAt: string | null;
};

export type EffectiveLineupRow = {
	elementId: number;
	position: number;
	sourceMultiplier: number;
	effectiveMultiplier: number;
	pickActive: boolean;
	autoSub: boolean;
	isCaptain: boolean;
	isViceCaptain: boolean;
	captainForScoring: boolean;
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
	calculationMode: ManagerLiveCalculationMode;
	algorithmVersion: string | null;
	provenance: ManagerScoreProvenance;
	effectiveLineup?: EffectiveLineupRow[];
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
	errorCode:
		| "UNSUPPORTED_H2H_LIVE"
		| "UPSTREAM_UNAVAILABLE"
		| "UPSTREAM_RATE_LIMITED"
		| "REVISION_UNAVAILABLE"
		| "INPUT_INCOMPLETE"
		| null;
	checkedAt: string;
	servedAt?: string;
	calculationMode: ManagerLiveCalculationMode;
	nextRefreshAt: string;
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
	servedAt?: string;
	calculationMode?: ManagerLiveCalculationMode;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableSafeInteger = (value: unknown): value is number | null =>
	value === null || (typeof value === "number" && Number.isSafeInteger(value));

const isIsoDateTime = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));

const isNullableIsoDateTime = (value: unknown): value is string | null =>
	value === null || isIsoDateTime(value);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isCalculationMode = (value: unknown): value is ManagerLiveCalculationMode =>
	value === "PROJECTED_AUTOSUBS" || value === "FINAL_RESULT";

const parsePositiveSafeIntegerArray = (value: unknown): number[] | null => {
	if (!Array.isArray(value)) return null;
	const result: number[] = [];
	for (const item of value as unknown[]) {
		if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) return null;
		result.push(item);
	}
	return result;
};

const parseProvenance = (value: unknown): ManagerScoreProvenance | null => {
	if (!isRecord(value)) return null;
	if (
		(value.scoreSource !== "FPL_EVENT_LIVE" && value.scoreSource !== "FPL_FINAL_RESULT") ||
		!isCalculationMode(value.calculationMode) ||
		(value.algorithmVersion !== null && !isNonEmptyString(value.algorithmVersion)) ||
		!isNonEmptyString(value.inputRevision) ||
		!isNonEmptyString(value.scoreRevision) ||
		(value.rankRevision !== null && !isNonEmptyString(value.rankRevision)) ||
		(value.livePublicationId !== null &&
			(!isNonEmptyString(value.livePublicationId) || !UUID_RE.test(value.livePublicationId))) ||
		(value.liveRevision !== null && !isNonEmptyString(value.liveRevision)) ||
		!isNullableIsoDateTime(value.liveCheckedAt) ||
		(value.picksRevision !== null && !isNonEmptyString(value.picksRevision)) ||
		!isNullableIsoDateTime(value.picksCheckedAt) ||
		(value.previousTotalsRevision !== null && !isNonEmptyString(value.previousTotalsRevision)) ||
		!isNullableSafeInteger(value.previousTotalsThroughEventId) ||
		(value.previousTotalsThroughEventId !== null && value.previousTotalsThroughEventId < 0) ||
		(value.resultRevision !== null && !isNonEmptyString(value.resultRevision)) ||
		!isNullableIsoDateTime(value.resultCheckedAt) ||
		!isNullableIsoDateTime(value.dataCheckedAt) ||
		(value.rankSource !== "FPL_ENTRY_SUMMARY" &&
			value.rankSource !== "FPL_CLASSIC_STANDINGS" &&
			value.rankSource !== null) ||
		!isNullableIsoDateTime(value.rankCheckedAt)
	) {
		return null;
	}
	return value as unknown as ManagerScoreProvenance;
};

const parseEffectiveLineup = (value: unknown): EffectiveLineupRow[] | undefined => {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length !== 15) return undefined;
	const rows: EffectiveLineupRow[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		if (
			typeof item.elementId !== "number" ||
			!Number.isSafeInteger(item.elementId) ||
			item.elementId <= 0 ||
			typeof item.position !== "number" ||
			!Number.isSafeInteger(item.position) ||
			item.position < 1 ||
			item.position > 15 ||
			typeof item.sourceMultiplier !== "number" ||
			!Number.isSafeInteger(item.sourceMultiplier) ||
			item.sourceMultiplier < 0 ||
			item.sourceMultiplier > 3 ||
			typeof item.effectiveMultiplier !== "number" ||
			!Number.isSafeInteger(item.effectiveMultiplier) ||
			item.effectiveMultiplier < 0 ||
			item.effectiveMultiplier > 3 ||
			typeof item.pickActive !== "boolean" ||
			typeof item.autoSub !== "boolean" ||
			typeof item.isCaptain !== "boolean" ||
			typeof item.isViceCaptain !== "boolean" ||
			typeof item.captainForScoring !== "boolean"
		) {
			return undefined;
		}
		if (item.pickActive ? item.effectiveMultiplier <= 0 : item.effectiveMultiplier !== 0) {
			return undefined;
		}
		rows.push(item as unknown as EffectiveLineupRow);
	}
	if (
		new Set(rows.map((row) => row.elementId)).size !== rows.length ||
		new Set(rows.map((row) => row.position)).size !== rows.length ||
		rows.filter((row) => row.isCaptain).length !== 1 ||
		rows.filter((row) => row.isViceCaptain).length !== 1 ||
		rows.some((row) => row.isCaptain && row.isViceCaptain) ||
		rows.filter((row) => row.captainForScoring).length > 1 ||
		rows.some((row) => row.captainForScoring && (!row.pickActive || row.effectiveMultiplier <= 0))
	) {
		return undefined;
	}
	return rows;
};

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
		value.entryId <= 0 ||
		typeof value.eventId !== "number" ||
		!Number.isSafeInteger(value.eventId) ||
		value.eventId <= 0 ||
		!isIsoDateTime(value.checkedAt) ||
		!isNonEmptyString(value.revision) ||
		(value.source !== "FPL_EVENT_LIVE" && value.source !== "FPL_FINAL_RESULT") ||
		(value.totalScope !== "OVERALL" && value.totalScope !== "CLASSIC_PHASE") ||
		typeof value.season !== "string" ||
		value.season.trim() === "" ||
		!isIsoDateTime(value.staleAt) ||
		!isNullableSafeInteger(value.eventPoints) ||
		!isNullableSafeInteger(value.netEventPoints) ||
		!isNullableSafeInteger(value.totalPoints) ||
		!isNullableSafeInteger(value.eventRank) ||
		!isNullableSafeInteger(value.overallRank) ||
		!isNullableSafeInteger(value.leagueRank) ||
		!isNullableSafeInteger(value.transferCost) ||
		(value.eventPointSemantics !== "GROSS" &&
			value.eventPointSemantics !== "NET" &&
			value.eventPointSemantics !== "ZERO_COST_EQUIVALENT" &&
			value.eventPointSemantics !== "UNKNOWN") ||
		!isNullableIsoDateTime(value.upstreamUpdatedAt)
	) {
		return null;
	}
	const calculationMode = value.calculationMode;
	if (!isCalculationMode(calculationMode)) return null;
	if (
		value.algorithmVersion === undefined ||
		(value.algorithmVersion !== null && !isNonEmptyString(value.algorithmVersion))
	)
		return null;
	const provenance = parseProvenance(value.provenance);
	if (!provenance) return null;
	if (
		provenance.scoreSource !== value.source ||
		provenance.calculationMode !== calculationMode ||
		provenance.algorithmVersion !== value.algorithmVersion ||
		(provenance.rankSource !== null &&
			(provenance.rankRevision === null || provenance.rankCheckedAt === null))
	)
		return null;
	if (calculationMode === "PROJECTED_AUTOSUBS") {
		if (
			value.source !== "FPL_EVENT_LIVE" ||
			value.algorithmVersion !== PROJECTED_ALGORITHM_VERSION ||
			provenance.livePublicationId === null ||
			provenance.liveRevision === null ||
			provenance.liveCheckedAt === null ||
			provenance.picksRevision === null ||
			provenance.picksCheckedAt === null ||
			provenance.previousTotalsRevision === null ||
			provenance.resultRevision !== null ||
			provenance.resultCheckedAt !== null ||
			provenance.dataCheckedAt !== null
		)
			return null;
	} else if (
		value.source !== "FPL_FINAL_RESULT" ||
		value.algorithmVersion !== null ||
		provenance.livePublicationId !== null ||
		provenance.liveRevision !== null ||
		provenance.liveCheckedAt !== null ||
		provenance.picksRevision === null ||
		provenance.picksCheckedAt === null ||
		provenance.previousTotalsRevision !== null ||
		provenance.resultRevision === null ||
		provenance.resultCheckedAt === null ||
		provenance.dataCheckedAt === null
	) {
		return null;
	}
	if (
		value.eventPoints !== null &&
		value.netEventPoints !== null &&
		value.transferCost !== null &&
		(value.eventPointSemantics === "GROSS" ||
			value.eventPointSemantics === "ZERO_COST_EQUIVALENT") &&
		value.netEventPoints !== value.eventPoints - value.transferCost
	)
		return null;
	const effectiveLineup = parseEffectiveLineup(value.effectiveLineup);
	if (value.effectiveLineup !== undefined && effectiveLineup === undefined) return null;
	return {
		...(value as unknown as ManagerLiveScoreRow),
		netEventPoints: typeof value.netEventPoints === "number" ? value.netEventPoints : null,
		calculationMode,
		algorithmVersion: value.algorithmVersion as string | null,
		provenance,
		...(effectiveLineup === undefined ? {} : { effectiveLineup }),
	};
};

/** Fetch official manager rows for one GraphQL batch. Never throws on upstream failure. */
export async function requestManagerLiveScores(params: {
	eventId: number;
	entryIds: readonly number[];
	tournamentId?: number;
	readMode?: "CACHE_ONLY" | "READ_THROUGH";
	logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
	includeEffectiveLineup?: boolean;
	liveRef?: { publicationId: string; revision: string };
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
				readMode: params.readMode ?? "READ_THROUGH",
				...(params.includeEffectiveLineup === undefined
					? {}
					: { includeEffectiveLineup: params.includeEffectiveLineup }),
				...(params.liveRef === undefined ? {} : { liveRef: params.liveRef }),
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
			data.season.trim() === "" ||
			!isIsoDateTime(data.checkedAt) ||
			!isCalculationMode(data.calculationMode)
		) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return emptyResult();
		}
		if (!Array.isArray(data.rows)) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return emptyResult();
		}
		const missingEntryIds = parsePositiveSafeIntegerArray(data.missingEntryIds);
		if (
			missingEntryIds === null ||
			new Set(missingEntryIds).size !== missingEntryIds.length ||
			typeof data.partial !== "boolean" ||
			data.partial !== missingEntryIds.length > 0 ||
			(data.errorCode !== null &&
				data.errorCode !== "UNSUPPORTED_H2H_LIVE" &&
				data.errorCode !== "UPSTREAM_UNAVAILABLE" &&
				data.errorCode !== "UPSTREAM_RATE_LIMITED" &&
				data.errorCode !== "REVISION_UNAVAILABLE" &&
				data.errorCode !== "INPUT_INCOMPLETE") ||
			!isIsoDateTime(data.servedAt) ||
			!isIsoDateTime(data.nextRefreshAt)
		) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return emptyResult();
		}
		const parsedRows: ManagerLiveScoreRow[] = [];
		for (const rawRow of data.rows) {
			const row = parseRow(rawRow);
			if (!row || row.eventId !== params.eventId || row.season !== data.season) {
				metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
				return emptyResult();
			}
			parsedRows.push(row);
		}
		if (
			new Set(parsedRows.map((row) => row.entryId)).size !== parsedRows.length ||
			parsedRows.some((row) => row.calculationMode !== data.calculationMode) ||
			parsedRows.some((row) => !params.entryIds.includes(row.entryId)) ||
			new Set([...parsedRows.map((row) => row.entryId), ...missingEntryIds]).size !==
				new Set(params.entryIds).size ||
			params.entryIds.some(
				(entryId) =>
					!parsedRows.some((row) => row.entryId === entryId) && !missingEntryIds.includes(entryId)
			) ||
			(data.calculationMode === "PROJECTED_AUTOSUBS" &&
				params.liveRef !== undefined &&
				parsedRows.some(
					(row) =>
						row.provenance.livePublicationId !== params.liveRef?.publicationId ||
						row.provenance.liveRevision !== params.liveRef?.revision
				))
		) {
			metrics.managerLiveUpstreamRequestsTotal.labels("invalid_response").inc();
			return emptyResult();
		}
		const rows = new Map(parsedRows.map((row) => [row.entryId, row]));
		const errorCode =
			data.errorCode === "UNSUPPORTED_H2H_LIVE" ||
			data.errorCode === "UPSTREAM_UNAVAILABLE" ||
			data.errorCode === "UPSTREAM_RATE_LIMITED" ||
			data.errorCode === "REVISION_UNAVAILABLE" ||
			data.errorCode === "INPUT_INCOMPLETE"
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
			calculationMode: data.calculationMode,
			servedAt: data.servedAt,
			nextRefreshAt: data.nextRefreshAt,
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
