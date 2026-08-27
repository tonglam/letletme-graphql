export const MAX_TOURNAMENT_DESK_ENTRIES = 500;

export type TournamentDeskEntryWindow = {
	entryIds: number[];
	deferredEntryIds: number[];
};

export type TournamentEventEntryStart = {
	startedEvent?: number | null;
};

export type TournamentEventEligibility<TEntry extends TournamentEventEntryStart> = {
	entryIds: number[];
	entriesById: Map<number, TEntry>;
};

/**
 * A tournament roster is current membership, not historical event membership.
 * Entries that joined FPL after the requested event have no lineup to recover
 * and must not reduce coverage or keep a finalized board in a retry loop.
 * Missing entry metadata remains eligible, matching Data's fail-open identity
 * rule while downstream score provenance still fails closed.
 */
export const filterTournamentEventEligibleEntryIds = (
	allEntryIds: readonly number[],
	entriesById: ReadonlyMap<number, TournamentEventEntryStart>,
	eventId: number
): number[] => {
	if (!Number.isSafeInteger(eventId) || eventId <= 0) {
		throw new RangeError("Tournament event must be a positive integer");
	}

	return Array.from(new Set(allEntryIds)).filter((entryId) => {
		const startedEvent = entriesById.get(entryId)?.startedEvent;
		return startedEvent === undefined || startedEvent === null || startedEvent <= eventId;
	});
};

export const loadTournamentEventEligibility = async <TEntry extends TournamentEventEntryStart>(
	allEntryIds: readonly number[],
	eventId: number,
	loadEntries: (entryIds: number[]) => Promise<ReadonlyMap<number, TEntry>>,
	chunkSize = MAX_TOURNAMENT_DESK_ENTRIES
): Promise<TournamentEventEligibility<TEntry>> => {
	if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
		throw new RangeError("Tournament eligibility chunk size must be a positive integer");
	}

	const uniqueEntryIds = Array.from(new Set(allEntryIds));
	const chunks: number[][] = [];
	for (let index = 0; index < uniqueEntryIds.length; index += chunkSize) {
		chunks.push(uniqueEntryIds.slice(index, index + chunkSize));
	}
	const loaded = await Promise.all(chunks.map((entryIds) => loadEntries(entryIds)));
	const entriesById = new Map<number, TEntry>();
	for (const entries of loaded) {
		for (const [entryId, entry] of entries) entriesById.set(entryId, entry);
	}

	return {
		entryIds: filterTournamentEventEligibleEntryIds(uniqueEntryIds, entriesById, eventId),
		entriesById,
	};
};

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
