import { describe, expect, it } from "bun:test";
import {
	filterTournamentEventEligibleEntryIds,
	loadTournamentEventEligibility,
	MAX_TOURNAMENT_DESK_ENTRIES,
	selectTournamentDeskEntryWindow,
} from "../../../src/domains/live-desks/tournament-entry-window";

describe("live tournament entry window", () => {
	it("excludes entries from events before their FPL start event", () => {
		const entries = new Map([
			[101, { startedEvent: 1 }],
			[202, { startedEvent: 2 }],
			[303, { startedEvent: null }],
		]);

		expect(filterTournamentEventEligibleEntryIds([101, 202, 303, 404], entries, 1)).toEqual([
			101, 303, 404,
		]);
	});

	it("includes a late-starting entry from its first eligible event", () => {
		const entries = new Map([[202, { startedEvent: 2 }]]);
		expect(filterTournamentEventEligibleEntryIds([202], entries, 2)).toEqual([202]);
	});

	it("rejects an invalid event before calculating eligibility", () => {
		expect(() => filterTournamentEventEligibleEntryIds([101], new Map(), 0)).toThrow(
			"Tournament event must be a positive integer"
		);
	});

	it("loads eligibility metadata without exceeding the live desk batch limit", async () => {
		const requestedChunks: number[][] = [];
		const allEntryIds = Array.from({ length: 501 }, (_, index) => index + 1);
		const eligibility = await loadTournamentEventEligibility(allEntryIds, 1, async (entryIds) => {
			requestedChunks.push(entryIds);
			return new Map(
				entryIds.map((entryId) => [entryId, { startedEvent: entryId === 501 ? 2 : 1 }])
			);
		});

		expect(requestedChunks.map((chunk) => chunk.length)).toEqual([500, 1]);
		expect(eligibility.entryIds).toHaveLength(500);
		expect(eligibility.entryIds).not.toContain(501);
		expect(eligibility.entriesById.size).toBe(501);
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

	it("keeps the 500-entry boundary explicit for production-sized rosters", () => {
		for (const size of [499, 500]) {
			const result = selectTournamentDeskEntryWindow(
				Array.from({ length: size }, (_, index) => index + 1),
				size
			);
			expect(result.entryIds).toHaveLength(size);
			expect(result.deferredEntryIds).toEqual([]);
		}

		const overLimit = selectTournamentDeskEntryWindow(
			Array.from({ length: 501 }, (_, index) => index + 1),
			501
		);
		expect(overLimit.entryIds).toHaveLength(MAX_TOURNAMENT_DESK_ENTRIES);
		expect(overLimit.deferredEntryIds).toHaveLength(1);
	});

	it("reports the honest deferred range for the 1,567-entry tournament", () => {
		const result = selectTournamentDeskEntryWindow(
			Array.from({ length: 1567 }, (_, index) => index + 1),
			1
		);
		expect(result.entryIds).toHaveLength(500);
		expect(result.deferredEntryIds).toHaveLength(1067);
		expect(result.deferredEntryIds[0]).toBe(501);
		expect(result.deferredEntryIds.at(-1)).toBe(1567);
		expect(result.deferredEntryIds).toContain(1567);
	});
});
