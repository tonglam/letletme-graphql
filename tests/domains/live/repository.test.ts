import { describe, expect, it } from "bun:test";
import { liveRepository } from "../../../src/domains/live/repository";
import { loadLiveSnapshotMeta } from "../../../src/domains/live/snapshot-meta";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	buildCorePublication,
	buildLivePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
	TestRedis,
	toPublicationFixture,
} from "../../helpers/data-publication";

const withReadRows = (
	context: GraphQLContext,
	rowsByModel: Record<string, unknown[]>,
	calls: string[] = [],
	errorsByModel: Record<string, Error | null> = {}
): GraphQLContext => {
	context.data = {
		read: (model: string) => {
			calls.push(model);
			const result = Promise.resolve({
				data: rowsByModel[model] ?? [],
				error: errorsByModel[model] ?? null,
			});
			const builder = {
				select: () => builder,
				eq: () => builder,
				in: () => builder,
				order: () => builder,
				then: result.then.bind(result),
			};
			return builder;
		},
	} as never;
	return context;
};

const liveContext = (eventLives = buildTestEventLives(buildTestCoreData(1), 1)) => {
	const core = buildTestCoreData(1);
	const redis = new TestRedis(
		buildCorePublication("2627", 7, core),
		buildLivePublication(core, 1, "2627", 8, { eventLives })
	);
	return { core, redis, context: buildSnapshotContext(redis) };
};

describe("liveRepository live publication reads", () => {
	it("returns empty results for invalid event IDs", async () => {
		const { context } = liveContext();
		await expect(liveRepository.getAllLivePerformances(context, 0)).resolves.toEqual(new Map());
		await expect(liveRepository.getLiveScores(context, -1)).resolves.toEqual([]);
	});

	it("serves full and targeted player live data from one request-pinned revision", async () => {
		const core = buildTestCoreData(1);
		const lives = buildTestEventLives(core, 1);
		lives[0] = {
			...lives[0],
			minutes: 90,
			goalsScored: 1,
			bonus: 3,
			totalPoints: 10,
			inDreamTeam: true,
		};
		const { context } = liveContext(lives);

		const all = await liveRepository.getAllLivePerformances(context, 1);
		const targeted = await liveRepository.getLivePerformancesByPlayerIds(context, 1, [1, 2, 999]);
		const eventLive = await liveRepository.getEventLive(context, 1);

		expect(all.size).toBe(core.players.length);
		expect(all.get(1)).toMatchObject({
			playerId: 1,
			minutes: 90,
			goalsScored: 1,
			bonus: 3,
			totalPoints: 10,
			inDreamTeam: true,
		});
		expect(targeted.map((row) => row.playerId)).toEqual([1, 2]);
		expect(eventLive.performances).toHaveLength(core.players.length);
	});

	it("reads a targeted player set without hydrating the full live publication", async () => {
		const core = buildTestCoreData(1);
		const lives = buildTestEventLives(core, 1);
		lives[0] = {
			...lives[0],
			minutes: 90,
			goalsScored: 1,
			bonus: 3,
			totalPoints: 10,
			inDreamTeam: true,
		};
		const { context, redis } = liveContext(lives);
		const activeManifest = [...redis.values.entries()].find(
			([key]) => key.includes(":fpl:live:") && key.endsWith(":active")
		);
		if (!activeManifest) throw new Error("Missing live publication manifest");
		const publicationManifest = JSON.parse(activeManifest[1]) as {
			publicationId: string;
			revision: number;
			sourceCheckedAt: string;
			publishedAt: string;
			items: Array<{ name: string; key: string }>;
		};
		// The targeted read is served from the same immutable publication. It
		// must not fall back to mutable PostgreSQL facts when a player is absent.
		let queryCount = 0;
		context.logger = {
			...context.logger,
			warn: (details: unknown) => {
				if (
					details &&
					typeof details === "object" &&
					"err" in details &&
					details.err instanceof Error
				) {
					throw details.err;
				}
			},
		};
		context.database = {
			query: async (sql: unknown) => {
				queryCount += 1;
				const targeted = String(sql).includes("element_id = ANY($3::integer[])");
				return {
					rows: [
						{
							authority_count: "1",
							event_live_count: String(core.players.length),
							known_player_count: "1",
							publication_id: publicationManifest.publicationId,
							revision: String(publicationManifest.revision),
							manifest: publicationManifest,
							source_checked_at: publicationManifest.sourceCheckedAt,
							published_at: "2030-01-01T00:00:00.000Z",
							event_checked_at: publicationManifest.sourceCheckedAt,
							event_lives: targeted
								? [
										{
											event_id: 1,
											element_id: 1,
											minutes: 90,
											goals_scored: 1,
											assists: 0,
											clean_sheets: 0,
											goals_conceded: 0,
											own_goals: 0,
											penalties_saved: 0,
											penalties_missed: 0,
											yellow_cards: 0,
											red_cards: 0,
											saves: 0,
											bonus: 3,
											bps: 40,
											starts: true,
											defensive_contribution: 0,
											expected_goals: "0.75",
											expected_assists: "0.10",
											expected_goal_involvements: "0.85",
											expected_goals_conceded: "0.90",
											in_dream_team: true,
											total_points: 10,
										},
									]
								: buildTestEventLives(core, 1),
							fixtures: core.fixtures
								.filter((fixture) => fixture.eventId === 1)
								.map(toPublicationFixture),
						},
					],
				};
			},
		} as never;

		const targeted = await liveRepository.getTargetedLiveRead(context, 1, [1]);
		const full = await liveRepository.getAllLivePerformances(context, 1);
		const fullMeta = await loadLiveSnapshotMeta(context, 1);

		expect(targeted.performances).toEqual([
			expect.objectContaining({ playerId: 1, minutes: 90, totalPoints: 10 }),
		]);
		expect(targeted.meta.publishedAt).toBe(publicationManifest.publishedAt);
		expect(full).toHaveLength(core.players.length);
		expect(fullMeta).toMatchObject({
			revision: targeted.meta.revision,
			publicationId: targeted.meta.publicationId,
			publishedAt: targeted.meta.publishedAt,
		});
		expect(queryCount).toBe(0);
	});

	it("returns no targeted rows for an unknown player without hydrating the full snapshot", async () => {
		const { context, redis, core } = liveContext();
		const activeManifest = [...redis.values.entries()].find(
			([key]) => key.includes(":fpl:live:") && key.endsWith(":active")
		);
		if (!activeManifest) throw new Error("Missing live publication manifest");
		const manifest = JSON.parse(activeManifest[1]) as {
			publicationId: string;
			revision: number;
			sourceCheckedAt: string;
			publishedAt: string;
			items: Array<{ name: string; key: string }>;
		};
		// Unknown players are an empty projection of the immutable event-live
		// vector, not a reason to hydrate mutable database rows.
		let queryCount = 0;
		context.logger = {
			...context.logger,
			warn: (details: unknown) => {
				if (details && typeof details === "object" && "err" in details) {
					throw new Error("Unknown player triggered full-snapshot fallback");
				}
			},
		};
		context.database = {
			query: async () => {
				queryCount += 1;
				return {
					rows: [
						{
							authority_count: "1",
							event_live_count: String(core.players.length),
							known_player_count: "0",
							publication_id: manifest.publicationId,
							revision: String(manifest.revision),
							source_checked_at: manifest.sourceCheckedAt,
							published_at: manifest.publishedAt,
							event_lives: [],
							fixtures: core.fixtures
								.filter((fixture) => fixture.eventId === 1)
								.map(toPublicationFixture),
						},
					],
				};
			},
		} as never;

		const targeted = await liveRepository.getTargetedLiveRead(context, 1, [999_999]);

		expect(targeted.performances).toEqual([]);
		expect(queryCount).toBe(0);
	});

	it("reads historical multi-event stats in one bounded PostgreSQL query", async () => {
		const { context } = liveContext();
		const calls: string[] = [];
		withReadRows(
			context,
			{
				"fpl.player_gameweek_stats": [
					{
						event_id: 2,
						element_id: 1,
						minutes: 90,
						goals_scored: 1,
						assists: 0,
						clean_sheets: 0,
						goals_conceded: 1,
						own_goals: 0,
						penalties_saved: 0,
						penalties_missed: 0,
						yellow_cards: 0,
						red_cards: 0,
						saves: 0,
						bonus: 3,
						bps: 40,
						starts: true,
						defensive_contribution: 0,
						expected_goals: "0.75",
						expected_assists: "0.10",
						expected_goal_involvements: "0.85",
						expected_goals_conceded: "0.90",
						in_dream_team: true,
						total_points: 10,
					},
				],
			},
			calls
		);

		const result = await liveRepository.getLivePerformancesForEventsAndPlayers(
			context,
			[1, 2],
			[1, 2]
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ eventId: 2, playerId: 1, totalPoints: 10 });
		expect(calls).toEqual(["fpl.player_gameweek_stats"]);
	});
});

describe("liveRepository explanation query cache", () => {
	it("loads one cold batch from reporting facts and caches it under core+live revision", async () => {
		const { context, redis } = liveContext();
		const calls: string[] = [];
		withReadRows(
			context,
			{
				"fpl.player_event_snapshots": [
					{
						element_id: 1,
						minutes: 90,
						goals_scored: 1,
						total_points: 10,
						selected_by_percent: "12.5",
					},
				],
				"fpl.player_gameweek_stats": [
					{
						event_id: 1,
						element_id: 1,
						penalties_missed: 1,
						defensive_contribution: 2,
						in_dream_team: true,
					},
				],
				"fpl.player_gameweek_scoring_items": [
					{
						event_id: 1,
						element_id: 1,
						minutes: 90,
						minutes_points: 2,
						goals_scored: 1,
						goals_scored_points: 5,
					},
				],
				"fpl.player_fixture_stats": [
					{
						event_id: 1,
						element_id: 1,
						fixture_id: 1,
						element_type: 3,
						minutes: 90,
						goals: 1,
					},
				],
			},
			calls
		);

		const first = await liveRepository.getEventLiveExplains(context, 1, [1], "full", true);
		const second = await liveRepository.getEventLiveExplains(context, 1, [1], "full", true);

		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({
			eventId: 1,
			elementId: 1,
			selectedBy: 12.5,
			stats: {
				minutes: 90,
				goalsScored: 1,
				penaltiesMissed: 1,
				defensiveContribution: 2,
				inDreamTeam: true,
				totalPoints: 10,
			},
			breakdown: [
				{
					fixtureId: 1,
					stats: [
						{ identifier: "minutes", points: 2, value: 90 },
						{ identifier: "goals_scored", points: 5, value: 1 },
					],
				},
			],
		});
		expect(second).toEqual(first);
		expect(calls).toEqual([
			"fpl.player_event_snapshots",
			"fpl.player_gameweek_stats",
			"fpl.player_gameweek_scoring_items",
			"fpl.player_fixture_stats",
		]);
		const queryCacheWrite = redis.setCalls.find(([key]) => key.includes(":live-explain:"));
		expect(queryCacheWrite?.[0]).toContain("llm:gql:core-7.live-1-8:");
		expect(queryCacheWrite?.slice(-2)).toEqual(["EX", 10]);
	});

	it("builds contributions from player stats when durable explain facts are empty", async () => {
		const { context } = liveContext();
		const calls: string[] = [];
		withReadRows(
			context,
			{
				"fpl.player_event_snapshots": [
					{
						event_id: 1,
						element_id: 1,
						element_type: 3,
						minutes: 120,
						goals_scored: 1,
						assists: 5,
						total_points: 42,
					},
				],
				"fpl.player_gameweek_stats": [
					{
						event_id: 1,
						element_id: 1,
						minutes: 66,
						goals_scored: 1,
						assists: 2,
						yellow_cards: 1,
						bonus: 3,
						total_points: 14,
					},
				],
				"fpl.player_gameweek_scoring_items": [],
				"fpl.player_fixture_stats": [
					{ event_id: 1, element_id: 1, fixture_id: 101, element_type: 3 },
				],
			},
			calls
		);

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [1]);

		expect(result?.stats.totalPoints).toBe(42);
		expect(result?.contributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ identifier: "minutes", value: 66, points: 2 }),
				expect.objectContaining({ identifier: "assists", value: 2, points: 6 }),
				expect.objectContaining({ identifier: "yellow_cards", value: 1, points: -1 }),
				expect.objectContaining({ identifier: "bonus", value: 3, points: 3 }),
			])
		);
		expect(calls).toEqual([
			"fpl.player_event_snapshots",
			"fpl.player_gameweek_stats",
			"fpl.player_gameweek_scoring_items",
			"fpl.player_fixture_stats",
		]);
	});

	it("does not estimate one minutes score across a double gameweek aggregate", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 3, minutes: 180, total_points: 42 },
			],
			"fpl.player_gameweek_stats": [{ event_id: 1, element_id: 2, minutes: 180, total_points: 4 }],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(result?.contributions?.some((item) => item.identifier === "minutes")).toBe(false);
	});

	it("does not estimate short double-gameweek minutes or goals conceded", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 1, minutes: 90, total_points: 42 },
			],
			"fpl.player_gameweek_stats": [
				{
					event_id: 1,
					element_id: 2,
					minutes: 90,
					goals_conceded: 2,
					total_points: 4,
				},
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [
				{
					event_id: 1,
					element_id: 2,
					fixture_id: 101,
					element_type: 1,
				},
				{
					event_id: 1,
					element_id: 2,
					fixture_id: 102,
					element_type: 1,
				},
			],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(result?.contributions?.some((item) => item.identifier === "minutes")).toBe(false);
		expect(result?.contributions?.some((item) => item.identifier === "goals_conceded")).toBe(false);
	});

	it("does not estimate saves across fixture boundaries", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 1, minutes: 180, total_points: 42 },
			],
			"fpl.player_gameweek_stats": [
				{ event_id: 1, element_id: 2, minutes: 180, saves: 4, total_points: 4 },
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [
				{ event_id: 1, element_id: 2, fixture_id: 101, element_type: 1, minutes: 90, saves: 2 },
				{ event_id: 1, element_id: 2, fixture_id: 102, element_type: 1, minutes: 90, saves: 2 },
			],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(result?.contributions?.some((item) => item.identifier === "saves")).toBe(false);
	});

	it("merges nonduplicate gameweek stats into partial fixture contributions", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 1, minutes: 90, total_points: 16 },
			],
			"fpl.player_gameweek_stats": [
				{
					event_id: 1,
					element_id: 2,
					minutes: 90,
					clean_sheets: 1,
					saves: 3,
					bonus: 3,
					total_points: 16,
				},
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [
				{
					event_id: 1,
					element_id: 2,
					fixture_id: 101,
					element_type: 1,
					minutes: 90,
				},
			],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(result?.contributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ identifier: "minutes", value: 90, points: 2 }),
				expect.objectContaining({ identifier: "clean_sheets", value: 1, points: 4 }),
				expect.objectContaining({ identifier: "saves", value: 3, points: 1 }),
				expect.objectContaining({ identifier: "bonus", value: 3, points: 3 }),
			])
		);
		expect(result?.contributions?.filter((item) => item.identifier === "minutes")).toHaveLength(1);
	});

	it("does not estimate clean-sheet points without sixty eligible minutes", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 1, minutes: 45, total_points: 1 },
			],
			"fpl.player_gameweek_stats": [
				{ event_id: 1, element_id: 2, minutes: 45, clean_sheets: 1, total_points: 1 },
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [
				{ event_id: 1, element_id: 2, fixture_id: 101, element_type: 1, minutes: 45 },
			],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(result?.contributions?.some((item) => item.identifier === "clean_sheets")).toBe(false);
	});

	it("does not double-count a yellow card with a red card", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 3, minutes: 90, total_points: -3 },
			],
			"fpl.player_gameweek_stats": [
				{
					event_id: 1,
					element_id: 2,
					yellow_cards: 1,
					red_cards: 1,
					total_points: -3,
				},
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [
				{
					event_id: 1,
					element_id: 2,
					fixture_id: 101,
					element_type: 3,
					yellow_cards: 1,
					red_cards: 1,
				},
			],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(result?.contributions).toEqual([
			expect.objectContaining({ identifier: "red_cards", value: 1, points: -3 }),
		]);
	});

	it("preserves cards from separate double-gameweek fixtures", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 3, minutes: 180, total_points: -4 },
			],
			"fpl.player_gameweek_stats": [
				{
					event_id: 1,
					element_id: 2,
					yellow_cards: 1,
					red_cards: 1,
					total_points: -4,
				},
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [
				{
					event_id: 1,
					element_id: 2,
					fixture_id: 101,
					element_type: 3,
					yellow_cards: 1,
				},
				{
					event_id: 1,
					element_id: 2,
					fixture_id: 102,
					element_type: 3,
					red_cards: 1,
				},
			],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(result?.contributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ identifier: "yellow_cards", value: 1, points: -1 }),
				expect.objectContaining({ identifier: "red_cards", value: 1, points: -3 }),
			])
		);
	});

	it("omits defensive-contribution counts when their points are unavailable", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [
				{ event_id: 1, element_id: 2, element_type: 3, minutes: 90, total_points: 12 },
			],
			"fpl.player_gameweek_stats": [
				{
					event_id: 1,
					element_id: 2,
					minutes: 90,
					defensive_contribution: 10,
					total_points: 12,
				},
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [2]);

		expect(
			result?.contributions?.some((item) => item.identifier === "defensive_contribution")
		).toBe(false);
	});

	it("loads a fifteen-player explanation batch with two bounded reporting reads", async () => {
		const { context } = liveContext();
		const elementIds = Array.from({ length: 15 }, (_, index) => index + 1);
		const calls: string[] = [];
		withReadRows(
			context,
			{
				"fpl.player_event_snapshots": elementIds.map((elementId) => ({
					element_id: elementId,
					total_points: elementId,
					selected_by_percent: String(elementId / 10),
				})),
				"fpl.player_gameweek_stats": [],
				"fpl.player_gameweek_scoring_items": [],
				"fpl.player_fixture_stats": [],
			},
			calls
		);

		const results = await liveRepository.getEventLiveExplains(context, 1, elementIds, "full", true);

		expect(results).toHaveLength(15);
		expect(results[14]).toMatchObject({ elementId: 15, selectedBy: 1.5 });
		expect(calls).toEqual([
			"fpl.player_event_snapshots",
			"fpl.player_gameweek_stats",
			"fpl.player_gameweek_scoring_items",
			"fpl.player_fixture_stats",
		]);
	});

	it("coalesces one hundred concurrent revision misses into one durable batch", async () => {
		const { context } = liveContext();
		const elementIds = Array.from({ length: 100 }, (_, index) => index + 1);
		const calls: string[] = [];
		withReadRows(
			context,
			{
				"fpl.player_event_snapshots": elementIds.map((elementId) => ({
					element_id: elementId,
					total_points: elementId,
					selected_by_percent: "1.0",
				})),
				"fpl.player_gameweek_stats": [],
				"fpl.player_gameweek_scoring_items": [],
				"fpl.player_fixture_stats": [],
			},
			calls
		);

		const results = await Promise.all(
			elementIds.map((elementId) => liveRepository.getEventLiveExplain(context, 1, elementId))
		);

		expect(results.every((result) => result !== null)).toBe(true);
		expect(calls).toEqual([
			"fpl.player_event_snapshots",
			"fpl.player_gameweek_stats",
			"fpl.player_gameweek_scoring_items",
			"fpl.player_fixture_stats",
		]);
	});

	it("returns null when neither durable explanation source has the player", async () => {
		const { context } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [],
			"fpl.player_gameweek_scoring_items": [],
		});
		await expect(liveRepository.getEventLiveExplain(context, 1, 1)).resolves.toBeNull();
	});

	it("preserves snapshot stats when the gameweek stats query fails", async () => {
		const { context, redis } = liveContext();
		withReadRows(
			context,
			{
				"fpl.player_event_snapshots": [
					{
						event_id: 1,
						element_id: 1,
						minutes: 90,
						total_points: 6,
					},
				],
				"fpl.player_gameweek_scoring_items": [],
				"fpl.player_fixture_stats": [],
			},
			[],
			{ "fpl.player_gameweek_stats": new Error("gameweek stats unavailable") }
		);

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [1]);

		expect(result).toMatchObject({
			elementId: 1,
			stats: { minutes: 90, totalPoints: 6 },
		});
		expect(redis.setCalls.some(([key]) => key.includes(":live-explain:"))).toBe(false);
	});

	it("does not promote gameweek stats to snapshot stats when the snapshot row is missing", async () => {
		const { context, redis } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [],
			"fpl.player_gameweek_stats": [
				{ event_id: 1, element_id: 1, minutes: 90, assists: 1, total_points: 3 },
			],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [],
		});

		const [result] = await liveRepository.getEventLiveExplains(context, 1, [1]);

		expect(result).toMatchObject({
			elementId: 1,
			stats: { minutes: null, totalPoints: null },
			contributions: [expect.objectContaining({ identifier: "assists", value: 1, points: 3 })],
		});
		expect(redis.setCalls.some(([key]) => key.includes(":live-explain:"))).toBe(false);
	});

	it("caches complete elements when another element is missing its snapshot row", async () => {
		const { context, redis } = liveContext();
		withReadRows(context, {
			"fpl.player_event_snapshots": [{ event_id: 1, element_id: 1, minutes: 90, total_points: 6 }],
			"fpl.player_gameweek_stats": [],
			"fpl.player_gameweek_scoring_items": [],
			"fpl.player_fixture_stats": [],
		});

		const results = await liveRepository.getEventLiveExplains(context, 1, [1, 2]);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ elementId: 1, stats: { minutes: 90, totalPoints: 6 } });
		expect(redis.setCalls.filter(([key]) => key.includes(":live-explain:")).length).toBe(1);
	});
});
