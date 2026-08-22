import { describe, expect, it } from "bun:test";
import {
	MAX_TOURNAMENT_DESK_ENTRIES,
	selectTournamentDeskEntryWindow,
} from "../../../src/domains/live-desks/tournament-entry-window";

describe("live tournament entry window", () => {
	it("keeps ordinary tournaments complete", () => {
		expect(selectTournamentDeskEntryWindow([1, 2, 3], 2)).toEqual({
			entryIds: [1, 2, 3],
			deferredEntryIds: [],
		});
	});

	it("bounds a large tournament and retains the requesting manager", () => {
		const allEntryIds = Array.from({ length: 567 }, (_, index) => index + 1);
		const result = selectTournamentDeskEntryWindow(allEntryIds, 567);

		expect(result.entryIds).toHaveLength(MAX_TOURNAMENT_DESK_ENTRIES);
		expect(result.entryIds).toContain(567);
		expect(result.entryIds).not.toContain(500);
		expect(result.deferredEntryIds).toHaveLength(67);
		expect(result.deferredEntryIds).toContain(500);
		expect(new Set([...result.entryIds, ...result.deferredEntryIds]).size).toBe(567);
	});

	it("deduplicates the roster before applying the limit", () => {
		expect(selectTournamentDeskEntryWindow([1, 1, 2], 1, 2)).toEqual({
			entryIds: [1, 2],
			deferredEntryIds: [],
		});
	});
});
