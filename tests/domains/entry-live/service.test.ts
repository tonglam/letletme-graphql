import { describe, expect, it } from "bun:test";

import type { LiveCalcData } from "../../../src/domains/entry-live/calc-service";
import { entryLiveResolvers } from "../../../src/domains/entry-live/resolvers";
import { projectEntryLiveFromCalc } from "../../../src/domains/entry-live/service";
import type { Entry } from "../../../src/domains/entries/repository";
import type { Event } from "../../../src/domains/events/repository";

const entry = { id: 109967 } as Entry;
const event = { id: 1 } as Event;

const eventLiveCalc = {
	availability: "READY",
	overallRank: 4_090_000,
	lastOverallPoints: 0,
	lastOverallRank: 0,
	transfersList: [],
	score: {
		eventPoints: 37,
		netEventPoints: 37,
		totalPoints: 37,
		totalScope: "OVERALL",
		eventRank: 79,
		overallRank: 4_090_000,
		leagueRank: null,
		transferCost: 0,
		source: "FPL_EVENT_LIVE",
		state: "FRESH",
		eventPointSemantics: "ZERO_COST_EQUIVALENT",
		revision: "event-live:publication-8:37:0",
		checkedAt: "2026-08-24T06:00:00.000Z",
		upstreamUpdatedAt: "2026-08-24T06:00:00.000Z",
		staleAt: "2026-08-24T06:01:30.000Z",
		nextRefreshAt: "2026-08-24T06:00:30.000Z",
		reconciliation: "SOURCE_SKEW",
		reasonCodes: ["SOURCE_SKEW"],
	},
} as unknown as LiveCalcData;

describe("entryLive score authority", () => {
	it("projects the traceable event-live score instead of a stale persisted headline", () => {
		expect(projectEntryLiveFromCalc({ entry, event, calc: eventLiveCalc })).toMatchObject({
			eventPoints: 37,
			eventNetPoints: 37,
			overallPoints: 37,
			liveTotalPoints: 37,
			score: {
				source: "FPL_EVENT_LIVE",
				revision: "event-live:publication-8:37:0",
				reconciliation: "SOURCE_SKEW",
			},
		});
	});

	it("keeps a traceable event-live headline when lineup details fail closed", () => {
		const lineupUnavailable = {
			...eventLiveCalc,
			availability: "LINEUP_UNAVAILABLE",
			score: { ...eventLiveCalc.score, reconciliation: "NO_LINEUP" },
		} as LiveCalcData;

		expect(projectEntryLiveFromCalc({ entry, event, calc: lineupUnavailable })).toMatchObject({
			eventPoints: 37,
			overallPoints: 37,
			liveTotalPoints: 37,
			score: {
				source: "FPL_EVENT_LIVE",
				reconciliation: "NO_LINEUP",
			},
		});
	});

	it("fails closed when no traceable live score is available", () => {
		const unavailable = {
			...eventLiveCalc,
			score: { ...eventLiveCalc.score, source: "UNAVAILABLE", eventPoints: null },
		} as LiveCalcData;
		expect(projectEntryLiveFromCalc({ entry, event, calc: unavailable })).toBeNull();
	});

	it("fails closed when an event-live score is missing its publication revision", () => {
		const untraceable = {
			...eventLiveCalc,
			score: { ...eventLiveCalc.score, revision: null },
		} as LiveCalcData;
		expect(projectEntryLiveFromCalc({ entry, event, calc: untraceable })).toBeNull();
	});

	it("does not relabel a phase total as the overall total", () => {
		const phaseTotal = {
			...eventLiveCalc,
			score: { ...eventLiveCalc.score, totalScope: "CLASSIC_PHASE" },
		} as LiveCalcData;
		expect(projectEntryLiveFromCalc({ entry, event, calc: phaseTotal })).toBeNull();
	});

	it("keeps a traceable finalized result when rich lineup details are missing", () => {
		const finalized = {
			...eventLiveCalc,
			availability: "NO_PICKS",
			eventTransfers: 2,
			score: {
				...eventLiveCalc.score,
				source: "FPL_FINAL_RESULT",
				state: "FINAL",
				revision: "final:1:109967:37:4090000",
				reconciliation: "NO_LINEUP",
				reasonCodes: ["MISSING_LINEUP"],
			},
		} as LiveCalcData;

		expect(projectEntryLiveFromCalc({ entry, event, calc: finalized })).toMatchObject({
			eventPoints: 37,
			eventTransfers: 2,
			score: { source: "FPL_FINAL_RESULT", state: "FINAL" },
		});
	});

	it("reuses the entry already resolved by the root service", () => {
		const projected = projectEntryLiveFromCalc({ entry, event, calc: eventLiveCalc });
		expect(projected).not.toBeNull();
		expect(entryLiveResolvers.EntryLive.entry(projected!)).toBe(entry);
	});
});
