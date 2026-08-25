import { createHash } from "node:crypto";
import type {
	ManagerLiveCoverageState,
	ManagerLiveServedFrom,
	ManagerLiveScoreRow,
	ManagerLiveTournamentCoverage,
} from "../../infra/manager-live-client";
import type { ManagerScoreLoad } from "./manager-score";

export const MANAGER_LIVE_SCORE_BATCH_SIZE = 500;
export const MANAGER_LIVE_SCORE_BATCH_CONCURRENCY = 2;

export const splitManagerLiveEntryIds = (
	entryIds: readonly number[],
	chunkSize = MANAGER_LIVE_SCORE_BATCH_SIZE
): number[][] => {
	if (
		!Number.isSafeInteger(chunkSize) ||
		chunkSize < 1 ||
		chunkSize > MANAGER_LIVE_SCORE_BATCH_SIZE
	) {
		throw new RangeError("chunkSize must be between 1 and 500");
	}
	const normalized = Array.from(new Set(entryIds)).sort((left, right) => left - right);
	const chunks: number[][] = [];
	for (let offset = 0; offset < normalized.length; offset += chunkSize) {
		chunks.push(normalized.slice(offset, offset + chunkSize));
	}
	return chunks;
};

const errorPriority: Record<NonNullable<ManagerScoreLoad["errorCode"]>, number> = {
	UPSTREAM_RATE_LIMITED: 3,
	UPSTREAM_UNAVAILABLE: 2,
	UNSUPPORTED_H2H_LIVE: 1,
};

const chooseError = (loads: readonly ManagerScoreLoad[]): ManagerScoreLoad["errorCode"] =>
	loads.reduce<ManagerScoreLoad["errorCode"]>((selected, load) => {
		if (!load.errorCode) return selected;
		if (!selected || errorPriority[load.errorCode] > errorPriority[selected]) return load.errorCode;
		return selected;
	}, null);

const chooseAvailability = (
	rows: number,
	expected: number,
	errorCode: ManagerScoreLoad["errorCode"],
	loads: readonly ManagerScoreLoad[]
): ManagerScoreLoad["dataAvailability"] => {
	if (rows === 0 && errorCode) return "UNAVAILABLE";
	if (rows < expected || errorCode) return "PARTIAL";
	return loads.every((load) => load.dataAvailability === "FRESH") ? "FRESH" : "LAST_GOOD";
};

const chooseServedFrom = (loads: readonly ManagerScoreLoad[]): ManagerLiveServedFrom => {
	const sources = new Set(
		loads.map((load) => load.servedFrom).filter((source) => source !== "NONE")
	);
	if (sources.size === 0) return "NONE";
	if (sources.size === 1) return sources.values().next().value as ManagerLiveServedFrom;
	return "MIXED";
};

const latestTimestamp = (values: readonly (string | null)[]): string | null => {
	const valid = values
		.map((value) => (value ? Date.parse(value) : NaN))
		.filter((value) => Number.isFinite(value));
	return valid.length === 0 ? null : new Date(Math.max(...valid)).toISOString();
};

const earliestTimestamp = (values: readonly (string | null)[]): string | null => {
	const valid = values
		.map((value) => (value ? Date.parse(value) : NaN))
		.filter((value) => Number.isFinite(value));
	return valid.length === 0 ? null : new Date(Math.min(...valid)).toISOString();
};

const mergeCoverage = (
	loads: readonly ManagerScoreLoad[],
	expectedEntries: number,
	resolvedEntries: number,
	managerRevision: string | null,
	errorCode: ManagerScoreLoad["errorCode"]
): ManagerLiveTournamentCoverage | null => {
	const coverages = loads
		.map((load) => load.tournamentCoverage)
		.filter(
			(coverage): coverage is ManagerLiveTournamentCoverage =>
				coverage !== null && coverage !== undefined
		);
	if (coverages.length === 0) return null;
	const rosterRevisions = new Set(
		coverages
			.map((coverage) => coverage.rosterRevision)
			.filter((revision): revision is string => revision !== null)
	);
	const fullyFetchedAt = latestTimestamp(coverages.map((coverage) => coverage.fullyFetchedAt));
	const state: ManagerLiveCoverageState =
		errorCode || resolvedEntries < expectedEntries
			? resolvedEntries === 0
				? "UNAVAILABLE"
				: "PARTIAL"
			: coverages.some((coverage) => coverage.state === "WARMING")
				? "WARMING"
				: "COMPLETE";
	return {
		rosterRevision: rosterRevisions.size === 1 ? [...rosterRevisions][0]! : null,
		expectedEntries: Math.max(
			expectedEntries,
			...coverages.map((coverage) => coverage.expectedEntries)
		),
		resolvedEntries: Math.min(
			Math.max(expectedEntries, ...coverages.map((coverage) => coverage.expectedEntries)),
			resolvedEntries
		),
		fullyFetchedAt,
		managerRevision:
			managerRevision ??
			coverages.find((coverage) => coverage.managerRevision)?.managerRevision ??
			null,
		error: errorCode ?? coverages.find((coverage) => coverage.error)?.error ?? null,
		state,
	};
};

/** Merge bounded Data reads without making a request larger than 500 entries. */
export const mergeManagerScoreLoads = (
	loads: readonly ManagerScoreLoad[],
	expectedEntryIds: readonly number[]
): ManagerScoreLoad => {
	const expected = Array.from(new Set(expectedEntryIds)).sort((left, right) => left - right);
	const rows = new Map<number, ManagerLiveScoreRow>();
	for (const load of loads) {
		for (const [entryId, row] of load.rows) rows.set(entryId, row);
	}
	const missingEntryIds = expected.filter((entryId) => !rows.has(entryId));
	const errorCode = chooseError(loads);
	const managerRevision =
		rows.size === 0 && missingEntryIds.length === 0
			? null
			: createHash("sha256")
					.update(
						JSON.stringify({
							rows: Array.from(rows, ([entryId, row]) => [entryId, row.revision]).sort(
								(left, right) => Number(left[0]) - Number(right[0])
							),
							missingEntryIds,
						})
					)
					.digest("hex")
					.slice(0, 20);
	const checkedAt = latestTimestamp(loads.map((load) => load.checkedAt));
	const nextRefreshAt = earliestTimestamp(loads.map((load) => load.nextRefreshAt));
	return {
		season: loads.find((load) => load.season)?.season ?? null,
		rows,
		errorCode,
		managerRevision,
		dataAvailability: chooseAvailability(rows.size, expected.length, errorCode, loads),
		servedFrom: chooseServedFrom(loads),
		refreshQueued: loads.some((load) => load.refreshQueued),
		missingEntryIds,
		checkedAt,
		tournamentCoverage: mergeCoverage(
			loads,
			expected.length,
			rows.size,
			managerRevision,
			errorCode
		),
		nextRefreshAt,
	};
};

export const mergeManagerLiveFetchResults = (
	loads: readonly ManagerScoreLoad[],
	expectedEntryIds: readonly number[]
): ManagerScoreLoad => mergeManagerScoreLoads(loads, expectedEntryIds);

export type ManagerLiveScoreChunkLoader = (
	entryIds: readonly number[]
) => Promise<ManagerScoreLoad>;

/** Fetch tournament manager rows in bounded chunks with limited parallelism. */
export const loadManagerScoresInChunks = async (
	entryIds: readonly number[],
	load: ManagerLiveScoreChunkLoader,
	concurrency = MANAGER_LIVE_SCORE_BATCH_CONCURRENCY
): Promise<ManagerScoreLoad> => {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
		throw new RangeError("concurrency must be between 1 and 4");
	}
	const chunks = splitManagerLiveEntryIds(entryIds);
	const loads: ManagerScoreLoad[] = [];
	for (let offset = 0; offset < chunks.length; offset += concurrency) {
		const batch = await Promise.all(chunks.slice(offset, offset + concurrency).map(load));
		loads.push(...batch);
	}
	return mergeManagerScoreLoads(loads, entryIds);
};
