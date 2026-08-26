import type { GraphQLContext } from "../../graphql/context";
import {
	requestManagerLiveScores,
	type EffectiveLineupRow,
	type ManagerLiveFetchResult,
	type ManagerLiveCalculationMode,
	type ManagerLiveScoreRow,
	type ManagerScoreProvenance,
} from "../../infra/manager-live-client";
import { metrics } from "../../infra/metrics";

export type LiveManagerScoreSource = "FPL_EVENT_LIVE" | "FPL_FINAL_RESULT" | "UNAVAILABLE";
export type LiveManagerScoreState = "FRESH" | "STALE" | "SETTLING" | "FINAL" | "UNAVAILABLE";
export type LiveManagerScoreTotalScope = "OVERALL" | "CLASSIC_PHASE" | "UNKNOWN";
export type LiveManagerScoreSemantics = "GROSS" | "NET" | "ZERO_COST_EQUIVALENT" | "UNKNOWN";
export type LiveManagerScoreCalculationMode = ManagerLiveCalculationMode;
export type LiveManagerScoreReconciliation =
	"MATCHED" | "SOURCE_SKEW" | "NOT_COMPARABLE" | "NO_LINEUP";
export type LiveManagerScoreReason =
	| "UPSTREAM_UNAVAILABLE"
	| "UPSTREAM_RATE_LIMITED"
	| "SOURCE_TOO_OLD"
	| "MISSING_SCORE"
	| "MISSING_LINEUP"
	| "UNSUPPORTED_H2H"
	| "SEMANTICS_UNKNOWN"
	| "SOURCE_SKEW";

export type LiveManagerScore = {
	eventPoints: number | null;
	netEventPoints: number | null;
	totalPoints: number | null;
	totalScope: LiveManagerScoreTotalScope;
	eventRank: number | null;
	overallRank: number | null;
	leagueRank: number | null;
	transferCost: number;
	source: LiveManagerScoreSource;
	state: LiveManagerScoreState;
	eventPointSemantics: LiveManagerScoreSemantics;
	revision: string | null;
	checkedAt: string | null;
	upstreamUpdatedAt: string | null;
	staleAt: string | null;
	nextRefreshAt: string | null;
	reconciliation: LiveManagerScoreReconciliation;
	reasonCodes: LiveManagerScoreReason[];
	calculationMode?: LiveManagerScoreCalculationMode | null;
	algorithmVersion?: string | null;
	provenance?: ManagerScoreProvenance | null;
	effectiveLineup?: EffectiveLineupRow[] | null;
};

export type ManagerScoreLoad = ManagerLiveFetchResult;

export type OfficialManagerScoreRow = ManagerLiveScoreRow;

export const MANAGER_SCORE_REFRESH_SECONDS = 30;

const ageSeconds = (checkedAt: string, now = Date.now()): number => {
	const timestamp = Date.parse(checkedAt);
	return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 1000) : Infinity;
};

const plusSeconds = (iso: string, seconds: number): string => {
	const value = Date.parse(iso);
	return Number.isFinite(value)
		? new Date(value + seconds * 1000).toISOString()
		: new Date(Date.now() + seconds * 1000).toISOString();
};

const hasTraceableRevision = (value: string | null | undefined): value is string =>
	typeof value === "string" && value.trim().length > 0;

const hasTraceableCheckedAt = (value: string | null | undefined): value is string =>
	typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));

const asOfficialTransferCost = (value: number | null | undefined): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const isTraceableOfficialManagerScore = (score: LiveManagerScore): boolean => {
	if (!hasTraceableRevision(score.revision) || !hasTraceableCheckedAt(score.checkedAt))
		return false;
	if (score.source === "FPL_FINAL_RESULT") return score.state === "FINAL";
	return (
		score.source === "FPL_EVENT_LIVE" &&
		(score.state === "FRESH" || score.state === "STALE" || score.state === "SETTLING")
	);
};

export async function loadManagerScores(
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[],
	tournamentId?: number,
	options: {
		includeEffectiveLineup?: boolean;
		liveRef?: { publicationId: string; revision: string };
	} = {}
): Promise<ManagerScoreLoad> {
	return requestManagerLiveScores({
		eventId,
		entryIds,
		tournamentId,
		...options,
		logger: context.logger,
	});
}

const baseScore = (transferCost: number): LiveManagerScore => ({
	eventPoints: null,
	netEventPoints: null,
	totalPoints: null,
	totalScope: "UNKNOWN",
	eventRank: null,
	overallRank: null,
	leagueRank: null,
	transferCost,
	source: "UNAVAILABLE",
	state: "UNAVAILABLE",
	eventPointSemantics: "UNKNOWN",
	revision: null,
	checkedAt: null,
	upstreamUpdatedAt: null,
	staleAt: null,
	nextRefreshAt: null,
	reconciliation: "NOT_COMPARABLE",
	reasonCodes: [],
	calculationMode: null,
	algorithmVersion: null,
	provenance: null,
	effectiveLineup: null,
});

const recordScoreMetrics = (score: LiveManagerScore): void => {
	metrics.managerLiveScoreSourceTotal.labels(score.source).inc();
	metrics.managerLiveScoreReconciliationTotal.labels(score.reconciliation).inc();
	if (score.checkedAt) {
		const age = ageSeconds(score.checkedAt);
		if (Number.isFinite(age)) metrics.managerLiveScoreAgeSeconds.labels(score.source).set(age);
	}
};

const rowMatchesEventLiveScore = (
	row: OfficialManagerScoreRow,
	grossEventPoints: number,
	netEventPoints: number
): boolean => {
	if (row.eventPointSemantics === "NET") return row.eventPoints === netEventPoints;
	if (row.eventPointSemantics === "GROSS" || row.eventPointSemantics === "ZERO_COST_EQUIVALENT") {
		return row.eventPoints === grossEventPoints;
	}
	if (typeof row.netEventPoints === "number") return row.netEventPoints === netEventPoints;
	return row.eventPoints === grossEventPoints;
};

/** Build the score contract and flat headline aliases from the single Data authority row. */
export function buildManagerScore(params: {
	row?: OfficialManagerScoreRow;
	upstreamErrorCode: ManagerScoreLoad["errorCode"];
	provisional: boolean;
	available: boolean;
	transferCost: number | null;
	detailEventPoints: number;
	nextRefreshAt?: string | null;
}): {
	score: LiveManagerScore;
	headline: { rank: number; livePoints: number; liveNetPoints: number; liveTotalPoints: number };
} {
	const { row, upstreamErrorCode, provisional, available, transferCost, detailEventPoints } =
		params;
	const suppliedTransferCost = asOfficialTransferCost(transferCost);
	const rowTransferCost = asOfficialTransferCost(row?.transferCost);
	const finalTransferCost = rowTransferCost ?? suppliedTransferCost;
	const isFinalRow =
		!provisional && row?.source === "FPL_FINAL_RESULT" && row.calculationMode === "FINAL_RESULT";
	const isProjectedRow =
		provisional && row?.source === "FPL_EVENT_LIVE" && row.calculationMode === "PROJECTED_AUTOSUBS";
	if (
		!row ||
		(!isFinalRow && !isProjectedRow) ||
		!hasTraceableRevision(row.revision) ||
		!hasTraceableCheckedAt(row.checkedAt) ||
		finalTransferCost === null
	) {
		const reasons: LiveManagerScoreReason[] = [];
		if (upstreamErrorCode === "UNSUPPORTED_H2H_LIVE") reasons.push("UNSUPPORTED_H2H");
		else if (upstreamErrorCode === "UPSTREAM_RATE_LIMITED") reasons.push("UPSTREAM_RATE_LIMITED");
		else if (upstreamErrorCode) reasons.push("UPSTREAM_UNAVAILABLE");
		if (!row || !hasTraceableCheckedAt(row?.checkedAt)) reasons.push("SOURCE_TOO_OLD");
		if (!available) reasons.push("MISSING_LINEUP");
		if (finalTransferCost === null) reasons.push("MISSING_SCORE");
		const unavailable = baseScore(finalTransferCost ?? 0);
		unavailable.checkedAt = row?.checkedAt ?? null;
		unavailable.staleAt = row?.staleAt ?? null;
		unavailable.nextRefreshAt = params.nextRefreshAt ?? null;
		unavailable.reconciliation = !available ? "NO_LINEUP" : "NOT_COMPARABLE";
		unavailable.reasonCodes = reasons;
		const result = {
			score: unavailable,
			headline: { rank: 0, livePoints: 0, liveNetPoints: 0, liveTotalPoints: 0 },
		};
		recordScoreMetrics(result.score);
		return result;
	}

	const effectiveTransferCost = finalTransferCost;
	const eventPoints = row.eventPoints;
	const netEventPoints = row.netEventPoints;
	const detailNetEventPoints = detailEventPoints - effectiveTransferCost;
	const reconciliation: LiveManagerScoreReconciliation = !available
		? "NO_LINEUP"
		: typeof eventPoints === "number" && typeof netEventPoints === "number"
			? rowMatchesEventLiveScore(row, detailEventPoints, detailNetEventPoints) &&
				netEventPoints === eventPoints - effectiveTransferCost
				? "MATCHED"
				: "SOURCE_SKEW"
			: "NOT_COMPARABLE";
	const fresh = ageSeconds(row.checkedAt) <= MANAGER_SCORE_REFRESH_SECONDS;
	const reasons: LiveManagerScoreReason[] = [];
	if (upstreamErrorCode === "UPSTREAM_RATE_LIMITED") reasons.push("UPSTREAM_RATE_LIMITED");
	else if (upstreamErrorCode && upstreamErrorCode !== "UNSUPPORTED_H2H_LIVE")
		reasons.push("UPSTREAM_UNAVAILABLE");
	if (isProjectedRow && !fresh) reasons.push("SOURCE_TOO_OLD");
	if (!available) reasons.push("MISSING_LINEUP");
	if (reconciliation === "SOURCE_SKEW") reasons.push("SOURCE_SKEW");
	if (eventPoints === null || netEventPoints === null || row.totalPoints === null)
		reasons.push("MISSING_SCORE");
	const score: LiveManagerScore = {
		eventPoints,
		netEventPoints,
		totalPoints: row.totalPoints,
		totalScope: row.totalScope,
		eventRank: row.eventRank,
		overallRank: row.overallRank,
		leagueRank: row.leagueRank,
		transferCost: effectiveTransferCost,
		source: row.source,
		state: isFinalRow ? "FINAL" : fresh ? "FRESH" : "STALE",
		eventPointSemantics: row.eventPointSemantics,
		revision: row.revision,
		checkedAt: row.checkedAt,
		upstreamUpdatedAt: row.upstreamUpdatedAt,
		staleAt: row.staleAt,
		nextRefreshAt: isFinalRow
			? null
			: (params.nextRefreshAt ?? plusSeconds(row.checkedAt, MANAGER_SCORE_REFRESH_SECONDS)),
		reconciliation,
		reasonCodes: reasons,
		calculationMode: row.calculationMode,
		algorithmVersion: row.algorithmVersion ?? null,
		provenance: row.provenance ?? null,
		effectiveLineup: row.effectiveLineup ?? null,
	};
	const result = {
		score,
		headline: {
			rank: row.eventRank ?? row.leagueRank ?? 0,
			livePoints: eventPoints ?? 0,
			liveNetPoints: netEventPoints ?? eventPoints ?? 0,
			liveTotalPoints: row.totalScope === "OVERALL" ? (row.totalPoints ?? 0) : 0,
		},
	};
	recordScoreMetrics(score);
	return result;
}

export const unavailableManagerScore = (transferCost = 0): LiveManagerScore =>
	baseScore(transferCost);

/**
 * Tournament boards do not reuse the Classic league's season rank. They rank
 * the official event headline within the tournament desk, keeping ties on the same competition
 * rank and leaving rows without an official event value at their existing rank.
 */
export function rankTournamentRowsByOfficialEventPoints<
	T extends { entry: number; rank: number; score: LiveManagerScore },
>(rows: readonly T[], options: { useNet?: boolean } = {}): T[] {
	const metric = (row: T): number | null =>
		options.useNet
			? typeof row.score.netEventPoints === "number" && row.score.eventPointSemantics !== "UNKNOWN"
				? row.score.netEventPoints
				: null
			: typeof row.score.eventPoints === "number"
				? row.score.eventPoints
				: null;
	const ranked = rows
		.filter((row) => metric(row) !== null && isTraceableOfficialManagerScore(row.score))
		.sort((left, right) => (metric(right) ?? 0) - (metric(left) ?? 0));
	const ranks = new Map<number, number>();
	let previousPoints: number | null = null;
	let previousRank = 0;
	for (let index = 0; index < ranked.length; index += 1) {
		const points = metric(ranked[index]!) ?? 0;
		if (previousPoints === null || points !== previousPoints) previousRank = index + 1;
		ranks.set(ranked[index]!.entry, previousRank);
		previousPoints = points;
	}
	return rows.map((row) => ({ ...row, rank: ranks.get(row.entry) ?? row.rank }));
}

export function managerScoreBoardIsFinal(
	rows: ReadonlyArray<{ score?: { source?: string; state?: string } }>
): boolean {
	return rows.every(
		(row) => row.score?.source === "FPL_FINAL_RESULT" && row.score.state === "FINAL"
	);
}
