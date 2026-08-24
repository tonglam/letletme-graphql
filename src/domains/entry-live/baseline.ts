import type { Entry, EntryEventResult } from "../entries/repository";

export type EntryBaseline = {
	overallPoints: number;
	overallRank: number | null;
	teamValue: number | null;
	/** Whether overallPoints is an authoritative event N-1 value, not a display fallback. */
	resolved: boolean;
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
		return { overallPoints: 0, overallRank: null, teamValue: null, resolved: true };
	}

	if (entry?.lastEventId === eventId - 1 && entry.overallPoints !== null) {
		return {
			overallPoints: entry.overallPoints,
			overallRank: entry.overallRank,
			teamValue: entry.teamValue,
			resolved: true,
		};
	}

	if (previousResult?.eventId === eventId - 1) {
		return {
			overallPoints: previousResult.overallPoints,
			overallRank: previousResult.overallRank,
			teamValue: previousResult.teamValue,
			resolved: true,
		};
	}

	return { overallPoints: 0, overallRank: null, teamValue: null, resolved: false };
};
