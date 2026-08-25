import { describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import { schema } from "../../../src/graphql/schema";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
	TestRedis,
} from "../../helpers/data-publication";

const deskQuery = `
	query Desk($eventId: Int) {
		gameweekDesk(eventId: $eventId) {
			season coreRevision liveRevision anchorEventId eventId currentEventId nextEventId
			isPreseason lifecycle deadlineTime publishedAt overviewState boardsState
				overview {
					averagePoints highestPoints highestScoringEntry mostSelected { id position teamShortName }
					topScorer { id webName position teamShortName points }
				mostPlayedChip { name numberPlayed }
			}
			dreamTeam { id position teamShortName totalPoints }
			hauls { id position totalPoints }
		}
	}
`;

const withDurableBoardRows = (
	context: ReturnType<typeof buildSnapshotContext>,
	rowCount = 11
): void => {
	context.data = {
		read: (model: string) => {
			const rows =
				model === "fpl.player_gameweek_stats"
					? Array.from({ length: rowCount }, (_, index) => ({
							event_id: 1,
							element_id: index + 1,
							minutes: 90,
							in_dream_team: true,
							total_points: 20 - index,
						}))
					: [];
			const result = Promise.resolve({ data: rows, error: null });
			const builder = {
				select: () => builder,
				eq: () => builder,
				in: () => builder,
				or: () => builder,
				then: result.then.bind(result),
			};
			return builder as never;
		},
	} as never;
};

describe("gameweekDesk", () => {
	it("keeps the current gameweek scheduled until a fixture starts", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: buildSnapshotContext(redis),
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			eventId: 1,
			lifecycle: "SCHEDULED",
			overviewState: "PENDING",
			boardsState: "PENDING",
			dreamTeam: [],
			hauls: [],
		});
	});

	it("coalesces concurrent desk loads for the same live publication", async () => {
		const baseCore = buildTestCoreData(1);
		const player = baseCore.players[0]!;
		const core = buildTestCoreData(1, {
			events: baseCore.events.map((event) =>
				event.id === 1 ? { ...event, averageEntryScore: 48, mostSelected: player.id } : event
			),
			fixtures: baseCore.fixtures.map((fixture, index) =>
				index === 0 ? { ...fixture, started: true } : fixture
			),
		});
		const eventLives = buildTestEventLives(core, 1).map((row, index) =>
			index === 0 ? { ...row, inDreamTeam: true, totalPoints: 12 } : row
		);
		const redis = new TestRedis(
			buildCorePublication("2627", 7, core),
			buildLivePublication(core, 1, "2627", 8, { state: "live", eventLives })
		);
		let databaseCalls = 0;
		const databaseQuery = async () => {
			databaseCalls += 1;
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			return { rows: [{ player_code: player.code, team_id: player.teamId }] };
		};
		const run = (context: ReturnType<typeof buildSnapshotContext>) =>
			graphql({
				schema,
				source: deskQuery,
				variableValues: { eventId: 1 },
				contextValue: context,
			});

		const [first, second] = await Promise.all([
			run(buildSnapshotContext(redis, { databaseQuery })),
			run(buildSnapshotContext(redis, { databaseQuery })),
		]);

		expect(first.errors).toBeUndefined();
		expect(second.errors).toBeUndefined();
		expect(first.data?.gameweekDesk).toMatchObject({
			eventId: 1,
			lifecycle: "PROVISIONAL",
			boardsState: "AVAILABLE",
		});
		expect(second.data?.gameweekDesk).toMatchObject({
			eventId: 1,
			lifecycle: "PROVISIONAL",
			boardsState: "AVAILABLE",
		});
		expect(databaseCalls).toBe(2);
	});

	it("returns a scheduled preseason desk without live reads or false unavailable boards", async () => {
		const core = buildTestCoreData(null);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);

		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: null },
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			season: "2627",
			coreRevision: "7",
			anchorEventId: 1,
			eventId: 1,
			currentEventId: null,
			nextEventId: 1,
			isPreseason: true,
			lifecycle: "SCHEDULED",
			overviewState: "PENDING",
			boardsState: "PENDING",
			overview: null,
			dreamTeam: [],
			hauls: [],
		});
	});

	it("returns one provisional board projection from the live publication", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			fixtures: baseCore.fixtures.map((fixture, index) =>
				index === 0 ? { ...fixture, started: true } : fixture
			),
		});
		const eventLives = buildTestEventLives(core, 1).map((row, index) =>
			index === 0
				? {
						...row,
						inDreamTeam: true,
						goalsScored: 2,
					}
				: row
		);
		const redis = new TestRedis(
			buildCorePublication("2627", 7, core),
			buildLivePublication(core, 1, "2627", 8, { state: "live", eventLives })
		);
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: buildSnapshotContext(redis, {
				databaseQuery: async (query) => {
					expect(String(query)).toContain("event_id = $3");
					return {
						rows: [{ player_code: core.players[0]!.code, team_id: 2 }],
					};
				},
			}),
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			eventId: 1,
			lifecycle: "PROVISIONAL",
			overviewState: "PENDING",
			boardsState: "AVAILABLE",
			dreamTeam: [{ id: core.players[0]!.id, position: "GOALKEEPER", teamShortName: "T02" }],
		});
	});

	it("recovers settled boards from durable PostgreSQL rows when live publication is missing", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			events: baseCore.events.map((event) =>
				event.id === 1 ? { ...event, finished: true, dataChecked: true } : event
			),
		});
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)), {
			databaseQuery: async () => ({ rows: [] }),
		});
		withDurableBoardRows(context);

		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			eventId: 1,
			lifecycle: "SETTLED",
			liveRevision: null,
			publishedAt: null,
			boardsState: "AVAILABLE",
		});
		const desk = result.data?.gameweekDesk as { dreamTeam?: unknown[] } | undefined;
		expect(desk?.dreamTeam).toHaveLength(11);
	});

	it("does not expose an incomplete durable dream team", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			events: baseCore.events.map((event) =>
				event.id === 1 ? { ...event, finished: true, dataChecked: true } : event
			),
		});
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)), {
			databaseQuery: async () => ({ rows: [] }),
		});
		withDurableBoardRows(context, 10);

		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			boardsState: "UNAVAILABLE",
			dreamTeam: [],
			hauls: [],
		});
	});

	it("keeps provisional boards unavailable when live publication is missing", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			fixtures: baseCore.fixtures.map((fixture, index) =>
				index === 0 ? { ...fixture, started: true } : fixture
			),
		});
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)), {
			databaseQuery: async () => ({ rows: [] }),
		});
		withDurableBoardRows(context);

		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			lifecycle: "PROVISIONAL",
			boardsState: "UNAVAILABLE",
			dreamTeam: [],
		});
	});

	it("projects the Home top scorer and most-played chip from the bounded overview", async () => {
		const baseCore = buildTestCoreData(1);
		const player = baseCore.players[0]!;
		const core = buildTestCoreData(1, {
			events: baseCore.events.map((event) =>
				event.id === 1
					? {
							...event,
							averageEntryScore: 48,
							highestScore: 101,
							highestScoringEntry: 123,
							topElement: player.id,
							topElementInfo: { element: player.id, points: 19 },
							chipPlays: [
								{ chipName: "wildcard", numberPlayed: 200 },
								{ chipName: "bboost", numberPlayed: 350 },
							],
						}
					: event
			),
			fixtures: baseCore.fixtures.map((fixture, index) =>
				index === 0 ? { ...fixture, started: true } : fixture
			),
		});
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)), {
				databaseQuery: async () => ({
					rows: [{ player_code: player.code, team_id: player.teamId }],
				}),
			}),
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			overview: {
				topScorer: {
					id: player.id,
					webName: player.webName,
					position: "GOALKEEPER",
					teamShortName: "T01",
					points: 19,
				},
				mostPlayedChip: { name: "bboost", numberPlayed: 350 },
				highestScoringEntry: 123,
			},
		});
	});

	it("keeps scheduled sections pending when live metadata lags core fixtures", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			fixtures: baseCore.fixtures.map((fixture, index) =>
				index === 0 ? { ...fixture, started: true } : fixture
			),
		});
		const eventLives = buildTestEventLives(core, 1).map((row, index) =>
			index === 0 ? { ...row, inDreamTeam: true } : row
		);
		const redis = new TestRedis(
			buildCorePublication("2627", 7, core),
			buildLivePublication(core, 1, "2627", 8, {
				state: "scheduled",
				eventLives,
				fixtures: baseCore.fixtures.filter((fixture) => fixture.eventId === 1),
			})
		);
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: buildSnapshotContext(redis, {
				databaseQuery: async () => ({ rows: [] }),
			}),
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			lifecycle: "SCHEDULED",
			overviewState: "PENDING",
			boardsState: "PENDING",
			overview: null,
			dreamTeam: [],
			hauls: [],
		});
	});

	it("uses historical player teams for an earlier gameweek", async () => {
		const baseCore = buildTestCoreData(2);
		const player = baseCore.players[0]!;
		const core = buildTestCoreData(2, {
			events: baseCore.events.map((event) =>
				event.id === 1
					? {
							...event,
							averageEntryScore: 48,
							mostSelected: player.id,
						}
					: event
			),
			fixtures: baseCore.fixtures.map((fixture, index) =>
				fixture.eventId === 1 && index === 0 ? { ...fixture, started: true } : fixture
			),
		});
		const eventLives = buildTestEventLives(core, 1).map((row, index) =>
			index === 0 ? { ...row, inDreamTeam: true } : row
		);
		const redis = new TestRedis(
			buildCorePublication("2627", 7, core),
			buildLivePublication(core, 1, "2627", 8, { state: "live", eventLives })
		);
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: buildSnapshotContext(redis, {
				databaseQuery: async () => ({
					rows: [{ player_code: player.code, team_id: 2 }],
				}),
			}),
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			overview: { mostSelected: { id: player.id, teamShortName: "T02" } },
			dreamTeam: [{ id: player.id, teamShortName: "T02" }],
		});
	});

	it("keeps historical teams available after the season has no current event", async () => {
		const baseCore = buildTestCoreData(null);
		const player = baseCore.players[0]!;
		const core = buildTestCoreData(null, {
			events: baseCore.events.map((event) => ({
				...event,
				finished: true,
				dataChecked: true,
				...(event.id === 1 ? { averageEntryScore: 48, mostSelected: player.id } : {}),
			})),
			fixtures: baseCore.fixtures.map((fixture) => ({
				...fixture,
				started: true,
				finished: true,
				finishedProvisional: true,
			})),
		});
		const eventLives = buildTestEventLives(core, 1).map((row, index) =>
			index === 0 ? { ...row, inDreamTeam: true } : row
		);
		const redis = new TestRedis(
			buildCorePublication("2627", 7, core),
			buildLivePublication(core, 1, "2627", 8, {
				state: "settled",
				eventLives,
			})
		);
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 1 },
			contextValue: buildSnapshotContext(redis, {
				databaseQuery: async (query) => {
					expect(String(query)).toContain("event_id <= $3");
					return { rows: [{ player_code: player.code, team_id: 2 }] };
				},
			}),
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.gameweekDesk).toMatchObject({
			lifecycle: "SETTLED",
			overview: { mostSelected: { id: player.id, teamShortName: "T02" } },
			dreamTeam: [{ id: player.id, teamShortName: "T02" }],
		});
	});

	it("rejects event IDs outside the published season range", async () => {
		const core = buildTestCoreData(null);
		const result = await graphql({
			schema,
			source: deskQuery,
			variableValues: { eventId: 39 },
			contextValue: buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core))),
		});

		expect(result.data).toBeNull();
		expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
	});
});
