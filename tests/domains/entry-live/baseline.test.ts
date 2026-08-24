import { describe, expect, it } from "bun:test";
import { resolvePreviousEventBaseline } from "../../../src/domains/entry-live/baseline";
import type { Entry, EntryEventResult } from "../../../src/domains/entries/repository";

const entry = (overrides: Partial<Entry> = {}): Entry => ({
	id: 1,
	entryName: "Team",
	playerName: "Manager",
	region: null,
	startedEvent: 1,
	overallPoints: 300,
	overallRank: 10,
	bank: 0,
	teamValue: 1010,
	totalTransfers: 1,
	lastEventId: 6,
	lastOverallPoints: 250,
	lastOverallRank: 20,
	lastTeamValue: 1000,
	lastBank: 0,
	...overrides,
});

const previous = (eventId: number): EntryEventResult => ({
	entryId: 1,
	eventId,
	eventPoints: 50,
	eventRank: 1,
	overallPoints: 250,
	overallRank: 20,
	eventTransfers: 0,
	eventTransfersCost: 0,
	eventNetPoints: 50,
	eventBenchPoints: 0,
	eventChip: null,
	eventPlayedCaptain: null,
	eventCaptainPoints: 0,
	eventPicks: [],
	teamValue: 1000,
	bank: 0,
});

describe("resolvePreviousEventBaseline", () => {
	it("uses entry_infos only when it is exactly event N-1", () => {
		expect(resolvePreviousEventBaseline(entry(), 7, previous(6))).toEqual({
			overallPoints: 300,
			overallRank: 10,
			teamValue: 1010,
			resolved: true,
		});
	});

	it("falls back to the canonical previous event result", () => {
		expect(resolvePreviousEventBaseline(entry({ lastEventId: 7 }), 7, previous(6))).toEqual({
			overallPoints: 250,
			overallRank: 20,
			teamValue: 1000,
			resolved: true,
		});
	});

	it("uses a zero/null baseline for an entry's first event", () => {
		expect(resolvePreviousEventBaseline(entry({ startedEvent: 7 }), 7, null)).toEqual({
			overallPoints: 0,
			overallRank: null,
			teamValue: null,
			resolved: true,
		});
	});

	it("marks an unknown historical gap as an unresolved display fallback", () => {
		expect(resolvePreviousEventBaseline(entry({ lastEventId: 7 }), 6, null)).toEqual({
			overallPoints: 0,
			overallRank: null,
			teamValue: null,
			resolved: false,
		});
	});
});
