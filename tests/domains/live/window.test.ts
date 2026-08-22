import { describe, expect, it } from "bun:test";
import { resolveLiveWindow } from "../../../src/domains/live-desks/window";
import { buildTestCoreData } from "../../helpers/data-publication";

describe("live window contract", () => {
	it("keeps GW1 on the core schedule before the first deadline", () => {
		const core = buildTestCoreData(1);
		const window = resolveLiveWindow({
			events: core.events,
			fixtures: core.fixtures,
			currentEventId: 1,
			nextEventId: 2,
			liveRevision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			source: "redis",
			now: new Date("2026-08-08T16:00:00.000Z"),
		});

		expect(window).toMatchObject({
			anchorEventId: 1,
			anchorMode: "UPCOMING",
			windowState: "PRESEASON",
			producerState: "PRE_DEADLINE",
			dataAvailability: "SCHEDULED",
		});
	});

	it("does not treat a deadline or predicted kickoff as live", () => {
		const core = buildTestCoreData(1);
		const window = resolveLiveWindow({
			events: core.events,
			fixtures: core.fixtures,
			currentEventId: 1,
			nextEventId: 2,
			liveRevision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			source: "redis",
			now: new Date("2026-08-08T18:00:00.000Z"),
		});

		expect(window.windowState).toBe("EVENT_SCHEDULED");
		expect(window.anchorEventId).toBe(1);
	});

	it("holds the previous final gameweek across the inter-gameweek gap", () => {
		const core = buildTestCoreData(2, {
			events: buildTestCoreData(2).events.map((event) =>
				event.id === 1 ? { ...event, finished: true, dataChecked: true } : event
			),
			fixtures: buildTestCoreData(2).fixtures.map((fixture) =>
				fixture.eventId === 1
					? { ...fixture, started: true, finished: true, finishedProvisional: false }
					: fixture
			),
		});
		const window = resolveLiveWindow({
			events: core.events,
			fixtures: core.fixtures,
			currentEventId: 2,
			nextEventId: 3,
			liveRevision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			source: "redis",
			now: new Date("2026-08-15T12:00:00.000Z"),
		});

		expect(window).toMatchObject({
			anchorEventId: 1,
			latestFinalizedEventId: 1,
			anchorMode: "PREVIOUS_FINAL",
			windowState: "BETWEEN_GAMEWEEKS",
			dataAvailability: "FINAL",
		});
	});

	it("does not let a previous settled publication switch the next GW early", () => {
		const core = buildTestCoreData(2, {
			events: buildTestCoreData(2).events.map((event) =>
				event.id === 1 ? { ...event, finished: true, dataChecked: true } : event
			),
			fixtures: buildTestCoreData(2).fixtures.map((fixture) =>
				fixture.eventId === 1
					? { ...fixture, started: true, finished: true, finishedProvisional: false }
					: fixture
			),
		});
		const window = resolveLiveWindow({
			events: core.events,
			fixtures: core.fixtures,
			currentEventId: 2,
			nextEventId: 3,
			liveRevision: "17",
			liveEventId: 1,
			publicationState: "settled",
			sourceCheckedAt: "2026-08-15T10:00:00.000Z",
			publishedAt: "2026-08-15T10:00:00.000Z",
			source: "redis",
			now: new Date("2026-08-15T12:00:00.000Z"),
		});

		expect(window).toMatchObject({
			anchorEventId: 1,
			liveRevision: "17",
			anchorMode: "PREVIOUS_FINAL",
			windowState: "BETWEEN_GAMEWEEKS",
			dataAvailability: "FINAL",
		});
	});

	it("uses the persisted producer lifecycle during a quiet interval", () => {
		const base = buildTestCoreData(1);
		const core = {
			...base,
			fixtures: base.fixtures.map((fixture) =>
				fixture.eventId === 1
					? {
							...fixture,
							started: true,
							finished: false,
							kickoffTime: "2026-08-08T12:00:00.000Z",
						}
					: fixture.eventId === 2
						? { ...fixture, kickoffTime: "2026-08-08T19:00:00.000Z" }
						: fixture
			),
		};
		const window = resolveLiveWindow({
			events: core.events,
			fixtures: core.fixtures,
			currentEventId: 1,
			nextEventId: 2,
			liveRevision: "17",
			liveEventId: 1,
			publicationState: "live",
			sourceCheckedAt: "2026-08-08T12:30:00.000Z",
			publishedAt: "2026-08-08T12:30:00.000Z",
			source: "redis",
			lifecycleEventId: 1,
			lifecycleState: "BETWEEN_FIXTURES",
			lifecycleNextRefreshAt: "2026-08-08T19:00:00.000Z",
			now: new Date("2026-08-08T18:15:00.000Z"),
		});

		expect(window).toMatchObject({
			anchorEventId: 1,
			windowState: "BETWEEN_FIXTURES",
			producerState: "BETWEEN_FIXTURES",
			nextRefreshAt: "2026-08-08T19:00:00.000Z",
		});
	});

	it("enters offseason after the final gameweek while retaining the final anchor", () => {
		const core = buildTestCoreData(null, {
			events: buildTestCoreData(null).events.map((event) => ({
				...event,
				finished: true,
				dataChecked: true,
				isCurrent: false,
				isNext: false,
			})),
			fixtures: buildTestCoreData(null).fixtures.map((fixture) => ({
				...fixture,
				started: true,
				finished: true,
				finishedProvisional: false,
			})),
		});
		const window = resolveLiveWindow({
			events: core.events,
			fixtures: core.fixtures,
			currentEventId: null,
			nextEventId: null,
			liveRevision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			source: "redis",
			now: new Date("2027-06-01T12:00:00.000Z"),
		});

		expect(window).toMatchObject({
			anchorEventId: 38,
			latestFinalizedEventId: 38,
			anchorMode: "OFFSEASON",
			windowState: "OFFSEASON",
			dataAvailability: "FINAL",
		});
	});
});
