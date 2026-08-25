import type { GraphQLContext } from "../../graphql/context";
import {
	requestManagerLiveScores,
	type ManagerLiveFetchResult,
	type ManagerLiveScoreRow,
} from "../../infra/manager-live-client";
import { metrics } from "../../infra/metrics";

export type LiveManagerScoreSource =
	| "FPL_EVENT_LIVE"
	| "FPL_ENTRY_SUMMARY"
	| "FPL_CLASSIC_STANDINGS"
	| "FPL_FINAL_RESULT"
	| "UNAVAILABLE";
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

export type EventLiveScoreAuthority = {
	revision: string;
	checkedAt: string;
};

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

const isWithinStaleWindow = (
	row: Pick<OfficialManagerScoreRow, "checkedAt" | "staleAt">
): boolean => {
	// staleAt is a freshness signal for the score state, not a hard deletion
	// boundary. Keep the last official row until a newer official/final row
	// replaces it; a temporary upstream miss must not erase the headline.
	return Number.isFinite(Date.parse(row.checkedAt));
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
		readMode: "CACHE_ONLY",
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

/** Build the additive score contract and the legacy flat headline aliases. */
export function buildManagerScore(params: {
	row?: OfficialManagerScoreRow;
	upstreamErrorCode: ManagerScoreLoad["errorCode"];
	provisional: boolean;
	available: boolean;
	transferCost: number | null;
	detailEventPoints: number;
	previousOverallPoints?: number | null;
	eventLiveAuthority?: EventLiveScoreAuthority | null;
	projectedLineup?: boolean;
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
	const suppliedTransferCost = asOfficialTransferCost(transferCost);
	const rowTransferCost = asOfficialTransferCost(row?.transferCost);
	const finalTransferCost = rowTransferCost ?? suppliedTransferCost;
	if (
		!provisional &&
		row?.source === "FPL_FINAL_RESULT" &&
		hasTraceableRevision(row.revision) &&
		hasTraceableCheckedAt(row.checkedAt) &&
		finalTransferCost !== null &&
		isWithinStaleWindow(row)
	) {
		const effectiveTransferCost = finalTransferCost;
		const detailNetEventPoints = detailEventPoints - effectiveTransferCost;
		const reconciliation: LiveManagerScoreReconciliation = !available
			? "NO_LINEUP"
			: typeof row.eventPoints === "number"
				? rowMatchesEventLiveScore(row, detailEventPoints, detailNetEventPoints)
					? "MATCHED"
					: "SOURCE_SKEW"
				: "NOT_COMPARABLE";
		const reasons: LiveManagerScoreReason[] = [];
		if (!available) reasons.push("MISSING_LINEUP");
		if (reconciliation === "SOURCE_SKEW") reasons.push("SOURCE_SKEW");
		if (row.eventPoints === null && row.totalPoints === null) reasons.push("MISSING_SCORE");
		const eventPoints = row.eventPoints;
		let eventPointSemantics = row.eventPointSemantics ?? "UNKNOWN";
		// Gross and net event points are mathematically identical when there is
		// no transfer deduction. This is enough evidence for provisional H2H even
		// when GW1 has no previous-overall baseline to compare against.
		if (eventPointSemantics === "UNKNOWN" && eventPoints !== null && effectiveTransferCost === 0) {
			eventPointSemantics = "ZERO_COST_EQUIVALENT";
		}
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
				state: "FINAL",
				eventPointSemantics,
				revision: row.revision,
				checkedAt: row.checkedAt,
				upstreamUpdatedAt: row.upstreamUpdatedAt,
				staleAt: row.staleAt,
				nextRefreshAt: null,
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

	// During an active or settling event, the only score authority is the
	// revisioned official event/{event}/live player payload combined with the
	// official picks and, while provisional, the FPL automatic-substitution and
	// captain-promotion rules. Manager summary and league rows are retained solely
	// as rank metadata and reconciliation evidence.
	if (
		available &&
		suppliedTransferCost !== null &&
		params.eventLiveAuthority &&
		hasTraceableRevision(params.eventLiveAuthority.revision) &&
		hasTraceableCheckedAt(params.eventLiveAuthority.checkedAt)
	) {
		const authority = params.eventLiveAuthority;
		const checkedAt = authority.checkedAt;
		const fresh = ageSeconds(checkedAt) <= MANAGER_SCORE_REFRESH_SECONDS;
		const effectiveTransferCost = suppliedTransferCost;
		const eventPoints = detailEventPoints;
		const netEventPoints = eventPoints - effectiveTransferCost;
		const totalPoints =
			previousOverallPoints === null ? null : previousOverallPoints + netEventPoints;
		const reconciliation: LiveManagerScoreReconciliation = params.projectedLineup
			? "NOT_COMPARABLE"
			: row && typeof row.eventPoints === "number"
				? rowMatchesEventLiveScore(row, eventPoints, netEventPoints)
					? "MATCHED"
					: "SOURCE_SKEW"
				: "NOT_COMPARABLE";
		const reasons: LiveManagerScoreReason[] = [];
		if (upstreamErrorCode === "UPSTREAM_RATE_LIMITED") reasons.push("UPSTREAM_RATE_LIMITED");
		else if (upstreamErrorCode && upstreamErrorCode !== "UNSUPPORTED_H2H_LIVE")
			reasons.push("UPSTREAM_UNAVAILABLE");
		if (!fresh) reasons.push("SOURCE_TOO_OLD");
		if (reconciliation === "SOURCE_SKEW") reasons.push("SOURCE_SKEW");

		const score: LiveManagerScore = {
			eventPoints,
			netEventPoints,
			totalPoints,
			totalScope: totalPoints === null ? "UNKNOWN" : "OVERALL",
			eventRank: row?.eventRank ?? null,
			overallRank: row?.overallRank ?? null,
			leagueRank: row?.leagueRank ?? null,
			transferCost: effectiveTransferCost,
			source: "FPL_EVENT_LIVE",
			state: !provisional ? "SETTLING" : fresh ? "FRESH" : "STALE",
			eventPointSemantics: effectiveTransferCost === 0 ? "ZERO_COST_EQUIVALENT" : "GROSS",
			revision: `event-live:${authority.revision}:lineup:${params.projectedLineup ? "projected" : "official"}:${eventPoints}:${effectiveTransferCost}:total:${totalPoints ?? "none"}:${totalPoints === null ? "UNKNOWN" : "OVERALL"}:rank:${row?.eventRank ?? "none"}:${row?.overallRank ?? "none"}:${row?.leagueRank ?? "none"}`,
			checkedAt,
			upstreamUpdatedAt: checkedAt,
			staleAt: plusSeconds(checkedAt, MANAGER_SCORE_REFRESH_SECONDS * 3),
			nextRefreshAt: params.nextRefreshAt ?? plusSeconds(checkedAt, MANAGER_SCORE_REFRESH_SECONDS),
			reconciliation,
			reasonCodes: reasons,
		};
		const result = {
			score,
			headline: {
				rank: row?.eventRank ?? row?.leagueRank ?? 0,
				livePoints: eventPoints,
				liveNetPoints: netEventPoints,
				liveTotalPoints: totalPoints ?? 0,
			},
		};
		recordScoreMetrics(score);
		return result;
	}

	const reasons: LiveManagerScoreReason[] = [];
	if (upstreamErrorCode === "UNSUPPORTED_H2H_LIVE") reasons.push("UNSUPPORTED_H2H");
	else if (upstreamErrorCode === "UPSTREAM_RATE_LIMITED") reasons.push("UPSTREAM_RATE_LIMITED");
	else if (upstreamErrorCode) reasons.push("UPSTREAM_UNAVAILABLE");
	if (row || !params.eventLiveAuthority) reasons.push("SOURCE_TOO_OLD");
	if (!available) reasons.push("MISSING_LINEUP");
	if (suppliedTransferCost === null) reasons.push("MISSING_SCORE");
	const unavailable = baseScore(suppliedTransferCost ?? 0);
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
