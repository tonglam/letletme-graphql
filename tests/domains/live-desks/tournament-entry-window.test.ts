import { describe, expect, it } from "bun:test";
import {
	MAX_TOURNAMENT_DESK_ENTRIES,
	normalizeTournamentRosterEntryIds,
	selectTournamentComparisonEntryIds,
	selectTournamentDeskEntryWindow,
} from "../../../src/domains/live-desks/tournament-entry-window";

describe("live tournament entry window", () => {
	it("retains a verified member missing from an incomplete roster read", () => {
		expect(normalizeTournamentRosterEntryIds([202, 101], 303, true)).toEqual([101, 202, 303]);
	});

	it("does not inject an administrator who is not a tournament member", () => {
		expect(normalizeTournamentRosterEntryIds([202, 101], 303, false)).toEqual([101, 202]);
		expect(normalizeTournamentRosterEntryIds([303, 202, 101], 303, false)).toEqual([101, 202, 303]);
	});

	it("prepends the viewer to one opponent only when the viewer is a member", () => {
		expect(selectTournamentComparisonEntryIds([202], 101, true)).toEqual([101, 202]);
		expect(selectTournamentComparisonEntryIds([202], 303, false)).toEqual([202]);
		expect(selectTournamentComparisonEntryIds([101, 202], 303, false)).toEqual([101, 202]);
	});

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
