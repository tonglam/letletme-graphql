import type { GraphQLContext } from "../../graphql/context";
import {
	requestManagerLiveScores,
	type ManagerLiveFetchResult,
	type ManagerLiveScoreRow,
} from "../../infra/manager-live-client";
import { metrics } from "../../infra/metrics";

export type LiveManagerScoreSource =
	"FPL_ENTRY_SUMMARY" | "FPL_CLASSIC_STANDINGS" | "FPL_FINAL_RESULT" | "UNAVAILABLE";
export type LiveManagerScoreState = "FRESH" | "STALE" | "SETTLING" | "FINAL" | "UNAVAILABLE";
export type LiveManagerScoreTotalScope = "OVERALL" | "CLASSIC_PHASE" | "UNKNOWN";
export type LiveManagerScoreSemantics = "GROSS" | "NET" | "ZERO_COST_EQUIVALENT" | "UNKNOWN";
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
};

export type ManagerScoreLoad = ManagerLiveFetchResult;

export type OfficialManagerScoreRow =
	ManagerLiveScoreRow | (Omit<ManagerLiveScoreRow, "source"> & { source: "FPL_FINAL_RESULT" });

const REFRESH_SECONDS = 30;
const STALE_SECONDS = Math.max(90, 3 * REFRESH_SECONDS);

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

const isWithinStaleWindow = (
	row: Pick<OfficialManagerScoreRow, "checkedAt" | "staleAt">
): boolean => {
	const expiry = Date.parse(row.staleAt);
	if (Number.isFinite(expiry)) return Date.now() <= expiry;
	return ageSeconds(row.checkedAt) <= STALE_SECONDS;
};

export async function loadManagerScores(
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[],
	tournamentId?: number
): Promise<ManagerScoreLoad> {
	return requestManagerLiveScores({
		eventId,
		entryIds,
		tournamentId,
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
});

const recordScoreMetrics = (score: LiveManagerScore): void => {
	metrics.managerLiveScoreSourceTotal.labels(score.source).inc();
	metrics.managerLiveScoreReconciliationTotal.labels(score.reconciliation).inc();
	if (score.checkedAt) {
		const age = ageSeconds(score.checkedAt);
		if (Number.isFinite(age)) metrics.managerLiveScoreAgeSeconds.labels(score.source).set(age);
	}
};

/** Build the additive score contract and the legacy flat headline aliases. */
export function buildManagerScore(params: {
	row?: OfficialManagerScoreRow;
	upstreamErrorCode: ManagerScoreLoad["errorCode"];
	provisional: boolean;
	available: boolean;
	transferCost: number;
	detailEventPoints: number;
	previousOverallPoints?: number | null;
	nextRefreshAt?: string | null;
}): {
	score: LiveManagerScore;
	headline: { rank: number; livePoints: number; liveNetPoints: number; liveTotalPoints: number };
} {
	const {
		row,
		upstreamErrorCode,
		provisional,
		available,
		transferCost,
		detailEventPoints,
		previousOverallPoints = null,
	} = params;
	const effectiveTransferCost = row?.transferCost ?? transferCost;
	const score = baseScore(effectiveTransferCost);
	const reconciliation: LiveManagerScoreReconciliation = !available
		? "NO_LINEUP"
		: row && typeof row.eventPoints === "number"
			? row.eventPoints === detailEventPoints
				? "MATCHED"
				: "SOURCE_SKEW"
			: "NOT_COMPARABLE";

	if (row && isWithinStaleWindow(row)) {
		const reasons: LiveManagerScoreReason[] = [];
		if (upstreamErrorCode === "UNSUPPORTED_H2H_LIVE") reasons.push("UNSUPPORTED_H2H");
		else if (upstreamErrorCode === "UPSTREAM_RATE_LIMITED") reasons.push("UPSTREAM_RATE_LIMITED");
		else if (upstreamErrorCode) reasons.push("UPSTREAM_UNAVAILABLE");
		if (!available) reasons.push("MISSING_LINEUP");
		if (reconciliation === "SOURCE_SKEW") reasons.push("SOURCE_SKEW");
		if (row.eventPoints === null && row.totalPoints === null) reasons.push("MISSING_SCORE");
		const finalEvidence = row.source === "FPL_FINAL_RESULT";
		const fresh = ageSeconds(row.checkedAt) <= REFRESH_SECONDS;
		const state: LiveManagerScoreState =
			!provisional && finalEvidence
				? "FINAL"
				: !fresh
					? "STALE"
					: !provisional
						? "SETTLING"
						: "FRESH";
		const eventPoints = row.eventPoints;
		let eventPointSemantics = row.eventPointSemantics ?? "UNKNOWN";
		if (
			eventPointSemantics === "UNKNOWN" &&
			row.totalScope === "OVERALL" &&
			eventPoints !== null &&
			row.totalPoints !== null &&
			previousOverallPoints !== null
		) {
			const officialDelta = row.totalPoints - previousOverallPoints;
			if (eventPoints === officialDelta) {
				eventPointSemantics = effectiveTransferCost === 0 ? "ZERO_COST_EQUIVALENT" : "NET";
			} else if (eventPoints - effectiveTransferCost === officialDelta) {
				eventPointSemantics = "GROSS";
			}
		}
		if (
			row.eventPoints !== null &&
			effectiveTransferCost > 0 &&
			eventPointSemantics === "UNKNOWN"
		) {
			reasons.push("SEMANTICS_UNKNOWN");
		}
		const netEventPoints =
			row.netEventPoints ??
			(eventPoints === null
				? null
				: eventPointSemantics === "NET" || eventPointSemantics === "ZERO_COST_EQUIVALENT"
					? eventPoints
					: eventPointSemantics === "GROSS"
						? eventPoints - effectiveTransferCost
						: null);
		const totalPoints = row.totalPoints;
		const result: {
			score: LiveManagerScore;
			headline: {
				rank: number;
				livePoints: number;
				liveNetPoints: number;
				liveTotalPoints: number;
			};
		} = {
			score: {
				eventPoints,
				netEventPoints,
				totalPoints,
				totalScope: row.totalScope,
				eventRank: row.eventRank,
				overallRank: row.overallRank,
				leagueRank: row.leagueRank,
				transferCost: effectiveTransferCost,
				source: row.source,
				state,
				eventPointSemantics,
				revision: row.revision,
				checkedAt: row.checkedAt,
				upstreamUpdatedAt: row.upstreamUpdatedAt,
				staleAt: row.staleAt,
				nextRefreshAt:
					state === "FINAL"
						? null
						: (params.nextRefreshAt ?? plusSeconds(row.checkedAt, REFRESH_SECONDS)),
				reconciliation,
				reasonCodes: reasons,
			},
			headline: {
				rank: row.eventRank ?? row.leagueRank ?? 0,
				livePoints: eventPoints ?? 0,
				liveNetPoints: netEventPoints ?? eventPoints ?? 0,
				liveTotalPoints: row.totalScope === "OVERALL" ? (totalPoints ?? 0) : 0,
			},
		};
		recordScoreMetrics(result.score);
		return result;
	}

	const reasons: LiveManagerScoreReason[] = [];
	if (upstreamErrorCode === "UNSUPPORTED_H2H_LIVE") reasons.push("UNSUPPORTED_H2H");
	else if (upstreamErrorCode === "UPSTREAM_RATE_LIMITED") reasons.push("UPSTREAM_RATE_LIMITED");
	else if (upstreamErrorCode) reasons.push("UPSTREAM_UNAVAILABLE");
	if (row) reasons.push("SOURCE_TOO_OLD");
	if (!available) reasons.push("MISSING_LINEUP");
	if (available && !row) reasons.push("MISSING_SCORE");
	const unavailable = baseScore(transferCost);
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

export const unavailableManagerScore = (transferCost = 0): LiveManagerScore =>
	baseScore(transferCost);

/**
 * Tournament boards do not reuse the Classic league's season rank. They rank
 * the official event headline within the tournament desk, keeping ties on the same competition
 * rank and leaving rows without an official event value at their legacy rank.
 */
export function rankTournamentRowsByOfficialEventPoints<
	T extends { entry: number; rank: number; score: LiveManagerScore },
>(rows: readonly T[]): T[] {
	const ranked = rows
		.filter(
			(row) =>
				typeof row.score.eventPoints === "number" &&
				(row.score.source === "FPL_ENTRY_SUMMARY" ||
					row.score.source === "FPL_CLASSIC_STANDINGS" ||
					row.score.source === "FPL_FINAL_RESULT")
		)
		.sort((left, right) => (right.score.eventPoints ?? 0) - (left.score.eventPoints ?? 0));
	const ranks = new Map<number, number>();
	let previousPoints: number | null = null;
	let previousRank = 0;
	for (let index = 0; index < ranked.length; index += 1) {
		const points = ranked[index]?.score.eventPoints ?? 0;
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
