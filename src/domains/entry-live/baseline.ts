import type { Entry, EntryEventResult } from "../entries/repository";

export type EntryBaseline = {
	overallPoints: number;
	overallRank: number | null;
	teamValue: number | null;
};

/** Resolve the snapshot immediately before event N, never an unrelated current snapshot. */
export const resolvePreviousEventBaseline = (
	entry: Entry | null,
	eventId: number,
	previousResult: EntryEventResult | null
): EntryBaseline => {
	if (
		eventId <= 1 ||
		(entry?.startedEvent !== null &&
			entry?.startedEvent !== undefined &&
			entry.startedEvent >= eventId)
	) {
		return { overallPoints: 0, overallRank: null, teamValue: null };
	}

	if (entry?.lastEventId === eventId - 1) {
		return {
			overallPoints: entry.overallPoints ?? 0,
			overallRank: entry.overallRank,
			teamValue: entry.teamValue,
		};
	}

	if (previousResult?.eventId === eventId - 1) {
		return {
			overallPoints: previousResult.overallPoints,
			overallRank: previousResult.overallRank,
			teamValue: previousResult.teamValue,
		};
	}

	return { overallPoints: 0, overallRank: null, teamValue: null };
};
