export const MAX_TOURNAMENT_DESK_ENTRIES = 500;

export type TournamentDeskEntryWindow = {
	entryIds: number[];
	deferredEntryIds: number[];
};

export const normalizeTournamentRosterEntryIds = (
	entryIds: readonly number[],
	requestingEntryId: number,
	retainVerifiedViewer: boolean
): number[] =>
	Array.from(
		new Set([
			...(retainVerifiedViewer ? [requestingEntryId] : []),
			...entryIds.filter((entryId) => Number.isSafeInteger(entryId) && entryId > 0),
		])
	).sort((left, right) => left - right);

/**
 * Keep a live tournament request inside the entry-live admission limit.
 * The requesting manager is retained in the foreground window so a large
 * league never hides the viewer's own row merely because it sorts later in
 * the persisted roster.
 */
export const selectTournamentDeskEntryWindow = (
	allEntryIds: readonly number[],
	requestingEntryId: number,
	limit = MAX_TOURNAMENT_DESK_ENTRIES
): TournamentDeskEntryWindow => {
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new RangeError("Tournament desk entry limit must be a positive integer");
	}

	const uniqueEntryIds = Array.from(new Set(allEntryIds));
	if (uniqueEntryIds.length <= limit) {
		return { entryIds: uniqueEntryIds, deferredEntryIds: [] };
	}

	const entryIds = uniqueEntryIds.slice(0, limit);
	if (uniqueEntryIds.includes(requestingEntryId) && !entryIds.includes(requestingEntryId)) {
		entryIds[entryIds.length - 1] = requestingEntryId;
	}
	const selected = new Set(entryIds);
	return {
		entryIds,
		deferredEntryIds: uniqueEntryIds.filter((entryId) => !selected.has(entryId)),
	};
};
