import { describe, expect, it } from "bun:test";
import { liveRepository } from "../../../src/domains/live/repository";
import {
	LiveSnapshotCoherenceError,
	withLiveSnapshotConsistency,
} from "../../../src/domains/live/snapshot-meta";

const makeMockRedis = (options: {
	strings?: Record<string, string>;
	hashes?: Record<string, Record<string, string>>;
}) => {
	const strings = new Map<string, string>([
		["Season:active", "2526"],
		...Object.entries(options.strings ?? {}),
	]);
	const hashes = new Map(Object.entries(options.hashes ?? {}).map(([k, v]) => [k, v]));
	const getCalls: string[] = [];
	const hgetallCalls: string[] = [];
	const setCalls: Array<[string, string, ...unknown[]]> = [];

	return {
		strings,
		hashes,
		getCalls,
		hgetallCalls,
		setCalls,
		get: async (key: string): Promise<string | null> => {
			getCalls.push(key);
			return strings.get(key) ?? null;
		},
		set: async (key: string, value: string, ...args: unknown[]): Promise<string> => {
			setCalls.push([key, value, ...args]);
			strings.set(key, value);
			return "OK";
		},
		del: async (key: string): Promise<number> => (strings.delete(key) ? 1 : 0),
		hgetall: async (key: string): Promise<Record<string, string>> => {
			hgetallCalls.push(key);
			return hashes.get(key) ?? {};
		},
		hlen: async (key: string): Promise<number> => Object.keys(hashes.get(key) ?? {}).length,
		hget: async (key: string, field: string): Promise<string | null> =>
			hashes.get(key)?.[field] ?? null,
		hmget: async (key: string, ...fields: string[]): Promise<(string | null)[]> => {
			const hash = hashes.get(key) ?? {};
			return fields.map((f) => hash[f] ?? null);
		},
		hset: async (key: string, ...args: unknown[]): Promise<number> => {
			if (!hashes.has(key)) hashes.set(key, {});
			const pairs = args as string[];
			for (let i = 0; i < pairs.length - 1; i += 2) {
				(hashes.get(key) ?? {})[pairs[i]] = pairs[i + 1];
			}
			return 1;
		},
		expire: async (): Promise<number> => 1,
	};
};

type MockRedis = ReturnType<typeof makeMockRedis>;

const makeMockSupabase = (options: {
	data?: unknown[];
	dataByTable?: Record<string, unknown[]>;
	error?: unknown;
}) => ({
	from: (table: string) => {
		const rows = (
			options.dataByTable && Object.hasOwn(options.dataByTable, table)
				? options.dataByTable[table]
				: (options.data ?? [])
		) as unknown[];
		const result = { data: rows, error: options.error ?? null };

		let resolvePromise!: (value: typeof result) => void;
		const promise = new Promise<typeof result>((resolve) => {
			resolvePromise = resolve;
		});
		queueMicrotask(() => resolvePromise(result));

		const builder = Object.assign(promise, {
			select: () => builder,
			eq: () => builder,
			in: () => builder,
			limit: async () => result,
			order: () => builder,
		});
		return builder;
	},
});

const makeMockLogger = () => ({
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
});

const buildContext = (options: {
	redisStrings?: Record<string, string>;
	redisHashes?: Record<string, Record<string, string>>;
	supabaseData?: unknown[];
	supabaseDataByTable?: Record<string, unknown[]>;
	supabaseError?: unknown;
	redis?: MockRedis;
}) =>
	({
		redis:
			options.redis ??
			makeMockRedis({
				strings: options.redisStrings,
				hashes: options.redisHashes,
			}),
		supabase: makeMockSupabase({
			data: options.supabaseData,
			dataByTable: options.supabaseDataByTable,
			error: options.supabaseError,
		}),
		logger: makeMockLogger(),
		user: undefined,
	}) as never;

const SAMPLE_SYNC_JOB_ROW = JSON.stringify({
	id: 24738,
	eventId: 33,
	elementId: 1,
	minutes: 90,
	goalsScored: 0,
	assists: 0,
	cleanSheets: 0,
	goalsConceded: 2,
	ownGoals: 0,
	penaltiesSaved: 0,
	penaltiesMissed: 0,
	yellowCards: 0,
	redCards: 0,
	saves: 2,
	bonus: 0,
	bps: 8,
	starts: true,
	defensiveContribution: 0,
	expectedGoals: "0.00",
	expectedAssists: "0.00",
	expectedGoalInvolvements: "0.00",
	expectedGoalsConceded: "1.36",
	inDreamTeam: false,
	totalPoints: 1,
});

const snapshotMeta = (revision: string, eventLiveCount = 1): string =>
	JSON.stringify({
		schemaVersion: 1,
		season: "2526",
		eventId: 33,
		revision,
		state: "live",
		publishedAt: "2025-08-15T20:00:00.000Z",
		checkedAt: "2025-08-15T20:00:00.000Z",
		eventLiveCount,
		fixtureCount: 10,
		fixtureTeamCount: 20,
		bonusTeamCount: 2,
	});

describe("liveRepository.getAllLivePerformances", () => {
	it("returns empty map for invalid eventId", async () => {
		const context = buildContext({});
		const result = await liveRepository.getAllLivePerformances(context, 0);
		expect(result.size).toBe(0);
	});

	it("returns empty map for negative eventId", async () => {
		const context = buildContext({});
		const result = await liveRepository.getAllLivePerformances(context, -1);
		expect(result.size).toBe(0);
	});

	it("parses Performance data from Redis EventLive hash", async () => {
		const field1 = JSON.stringify({
			id: 100,
			eventId: 33,
			elementId: 1,
			minutes: 90,
			goalsScored: 2,
			assists: 1,
			cleanSheets: 0,
			goalsConceded: 1,
			ownGoals: 0,
			penaltiesSaved: 0,
			penaltiesMissed: 0,
			yellowCards: 0,
			redCards: 0,
			saves: 3,
			bonus: 2,
			bps: 15,
			starts: true,
			defensiveContribution: 5,
			expectedGoals: "1.20",
			expectedAssists: "0.30",
			expectedGoalInvolvements: "1.50",
			expectedGoalsConceded: "0.80",
			inDreamTeam: true,
			totalPoints: 10,
		});
		const field2 = JSON.stringify({
			id: 101,
			eventId: 33,
			elementId: 2,
			minutes: 45,
			goalsScored: 1,
			assists: 0,
			cleanSheets: 0,
			goalsConceded: 0,
			ownGoals: 0,
			penaltiesSaved: 0,
			penaltiesMissed: 0,
			yellowCards: 1,
			redCards: 0,
			saves: 0,
			bonus: 0,
			bps: 5,
			starts: true,
			defensiveContribution: 3,
			expectedGoals: "0.50",
			expectedAssists: "0.10",
			expectedGoalInvolvements: "0.60",
			expectedGoalsConceded: "0.40",
			inDreamTeam: false,
			totalPoints: 3,
		});

		const context = buildContext({
			redisStrings: { "Season:active": "2526" },
			redisHashes: { "EventLive:2526:33": { "1": field1, "2": field2 } },
		});

		const result = await liveRepository.getAllLivePerformances(context, 33);
		expect(result.size).toBe(2);
		expect(result.get(1)).toBeDefined();
		expect(result.get(1)?.playerId).toBe(1);
		expect(result.get(1)?.eventId).toBe(33);
		expect(result.get(1)?.minutes).toBe(90);
		expect(result.get(1)?.goalsScored).toBe(2);
		expect(result.get(1)?.assists).toBe(1);
		expect(result.get(1)?.bonus).toBe(2);
		expect(result.get(1)?.totalPoints).toBe(10);
		expect(result.get(1)?.inDreamTeam).toBe(true);

		expect(result.get(2)).toBeDefined();
		expect(result.get(2)?.playerId).toBe(2);
		expect(result.get(2)?.minutes).toBe(45);
		expect(result.get(2)?.yellowCards).toBe(1);
	});

	it("falls back to DB when Redis hash is empty", async () => {
		const context = buildContext({
			redisStrings: { "Season:active": "2526" },
			redisHashes: {},
			supabaseData: [
				{
					event_id: 33,
					element_id: 1,
					minutes: 60,
					goals_scored: 0,
					assists: 0,
					clean_sheets: 1,
					goals_conceded: 0,
					own_goals: 0,
					penalties_saved: 0,
					penalties_missed: 0,
					yellow_cards: 0,
					red_cards: 0,
					saves: 0,
					bonus: 0,
					bps: 0,
					starts: true,
					defensive_contribution: 0,
					expected_goals: null,
					expected_assists: null,
					expected_goal_involvements: null,
					expected_goals_conceded: null,
					in_dream_team: false,
					total_points: 3,
				},
			],
		});

		const result = await liveRepository.getAllLivePerformances(context, 33);
		expect(result.size).toBe(1);
		expect(result.get(1)).toBeDefined();
		expect(result.get(1)?.playerId).toBe(1);
		expect(result.get(1)?.minutes).toBe(60);
		expect(result.get(1)?.totalPoints).toBe(3);
	});

	it("skips invalid JSON rows in Redis hash", async () => {
		const invalidJson = "not-valid-json{{{";
		const missingFields = JSON.stringify({ id: 99 });

		const context = buildContext({
			redisStrings: { "Season:active": "2526" },
			redisHashes: {
				"EventLive:2526:33": {
					"1": SAMPLE_SYNC_JOB_ROW,
					"99": invalidJson,
					"98": missingFields,
				},
			},
		});

		const result = await liveRepository.getAllLivePerformances(context, 33);
		expect(result.size).toBe(1);
		expect(result.get(1)).toBeDefined();
		expect(result.get(1)?.playerId).toBe(1);
	});

	it("keys the shaped cache by producer revision with a bounded immutable TTL", async () => {
		const revision = "a".repeat(24);
		const redis = makeMockRedis({
			strings: { [`LiveSnapshotMeta:2526:33`]: snapshotMeta(revision) },
			hashes: { "EventLive:2526:33": { "1": SAMPLE_SYNC_JOB_ROW } },
		});
		const context = buildContext({ redis });

		const result = await liveRepository.getAllLivePerformances(context, 33);
		expect(result.get(1)?.totalPoints).toBe(1);
		expect(redis.setCalls).toContainEqual([
			`gql:v2:2526:live:all:33:revision:${revision}`,
			expect.any(String),
			"EX",
			180,
		]);
	});

	it("coalesces a 100-request revision miss into one EventLive load", async () => {
		const revision = "b".repeat(24);
		const redis = makeMockRedis({
			strings: { [`LiveSnapshotMeta:2526:33`]: snapshotMeta(revision) },
			hashes: { "EventLive:2526:33": { "1": SAMPLE_SYNC_JOB_ROW } },
		});
		redis.hgetall = async (key: string): Promise<Record<string, string>> => {
			redis.hgetallCalls.push(key);
			await new Promise((resolve) => setTimeout(resolve, 10));
			return redis.hashes.get(key) ?? {};
		};
		const results = await Promise.all(
			Array.from({ length: 100 }, () =>
				liveRepository.getAllLivePerformances(buildContext({ redis }), 33)
			)
		);

		expect(results.every((result) => result.get(1)?.totalPoints === 1)).toBe(true);
		expect(redis.hgetallCalls).toEqual(["EventLive:2526:33"]);
		expect(redis.setCalls).toHaveLength(1);
	});

	it("rejects an incomplete EventLive hash instead of caching a partial revision", async () => {
		const revision = "c".repeat(24);
		const redis = makeMockRedis({
			strings: { [`LiveSnapshotMeta:2526:33`]: snapshotMeta(revision, 2) },
			hashes: { "EventLive:2526:33": { "1": SAMPLE_SYNC_JOB_ROW } },
		});
		const context = buildContext({ redis });

		const result = await liveRepository.getAllLivePerformances(context, 33);
		expect(result.size).toBe(0);
		expect(
			redis.setCalls.some(([key]) => key === `gql:v2:2526:live:all:33:revision:${revision}`)
		).toBe(false);
	});

	it("reuses a revision-bound fallback while the published EventLive view is incomplete", async () => {
		const revision = "d".repeat(24);
		const redis = makeMockRedis({
			strings: { [`LiveSnapshotMeta:2526:33`]: snapshotMeta(revision, 2) },
			hashes: { "EventLive:2526:33": { "1": SAMPLE_SYNC_JOB_ROW } },
		});
		const dbRow = {
			event_id: 33,
			element_id: 1,
			minutes: 60,
			goals_scored: 0,
			assists: 0,
			clean_sheets: 1,
			goals_conceded: 0,
			own_goals: 0,
			penalties_saved: 0,
			penalties_missed: 0,
			yellow_cards: 0,
			red_cards: 0,
			saves: 0,
			bonus: 0,
			bps: 0,
			starts: true,
			defensive_contribution: 0,
			expected_goals: null,
			expected_assists: null,
			expected_goal_involvements: null,
			expected_goals_conceded: null,
			in_dream_team: false,
			total_points: 3,
		};
		const context = buildContext({ redis, supabaseData: [dbRow] });

		const first = await liveRepository.getAllLivePerformances(context, 33);
		const second = await liveRepository.getAllLivePerformances(context, 33);

		expect(first.get(1)?.totalPoints).toBe(3);
		expect(second.get(1)?.totalPoints).toBe(3);
		expect(redis.hgetallCalls).toEqual(["EventLive:2526:33"]);
		expect(redis.setCalls).toContainEqual([
			`gql:v2:2526:live:all:33:revision:${revision}:fallback15`,
			expect.any(String),
			"EX",
			15,
		]);
	});

	it("bypasses Redis and revision caches after a sibling forces database mode", async () => {
		const revision = "9".repeat(24);
		const context = buildContext({
			redisStrings: { [`LiveSnapshotMeta:2526:33`]: snapshotMeta(revision, 1) },
			redisHashes: { "EventLive:2526:33": { "1": SAMPLE_SYNC_JOB_ROW } },
			supabaseData: [
				{
					event_id: 33,
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
					bonus: 0,
					bps: 20,
					starts: true,
					defensive_contribution: 0,
					expected_goals: null,
					expected_assists: null,
					expected_goal_involvements: null,
					expected_goals_conceded: null,
					in_dream_team: false,
					total_points: 9,
				},
			],
		});
		let runs = 0;
		const result = await withLiveSnapshotConsistency(context, 33, async () => {
			runs += 1;
			if (runs === 1) {
				throw new LiveSnapshotCoherenceError(33, "Fixtures", "fixture view incomplete");
			}
			return liveRepository.getAllLivePerformances(context, 33);
		});

		expect(result.get(1)?.totalPoints).toBe(9);
		expect(runs).toBe(2);
	});

	it("evicts malformed shaped cache and falls back to authoritative Redis data", async () => {
		const context = buildContext({
			redisStrings: {
				"Season:active": "2526",
				"gql:v2:2526:live:all:33:fallback15": "not-json",
			},
			redisHashes: {
				"EventLive:2526:33": { "1": SAMPLE_SYNC_JOB_ROW },
			},
		});

		const result = await liveRepository.getAllLivePerformances(context, 33);
		expect(result.get(1)?.playerId).toBe(1);
		const redis = (
			context as unknown as { redis: { get: (key: string) => Promise<string | null> } }
		).redis;
		expect(await redis.get("gql:v2:2526:live:all:33:fallback15")).not.toBe("not-json");
	});
});

describe("liveRepository.getLivePerformancesByPlayerIds", () => {
	it("filters from getAllLivePerformances by player IDs", async () => {
		const field1 = JSON.stringify({
			id: 100,
			eventId: 33,
			elementId: 1,
			minutes: 90,
			goalsScored: 0,
			assists: 0,
			cleanSheets: 0,
			goalsConceded: 2,
			ownGoals: 0,
			penaltiesSaved: 0,
			penaltiesMissed: 0,
			yellowCards: 0,
			redCards: 0,
			saves: 2,
			bonus: 0,
			bps: 8,
			starts: true,
			defensiveContribution: 0,
			expectedGoals: "0.00",
			expectedAssists: "0.00",
			expectedGoalInvolvements: "0.00",
			expectedGoalsConceded: "1.36",
			inDreamTeam: false,
			totalPoints: 1,
		});
		const field2 = JSON.stringify({
			id: 101,
			eventId: 33,
			elementId: 2,
			minutes: 45,
			goalsScored: 1,
			assists: 0,
			cleanSheets: 0,
			goalsConceded: 0,
			ownGoals: 0,
			penaltiesSaved: 0,
			penaltiesMissed: 0,
			yellowCards: 0,
			redCards: 0,
			saves: 0,
			bonus: 0,
			bps: 5,
			starts: true,
			defensiveContribution: 3,
			expectedGoals: "0.50",
			expectedAssists: "0.10",
			expectedGoalInvolvements: "0.60",
			expectedGoalsConceded: "0.40",
			inDreamTeam: false,
			totalPoints: 3,
		});

		const context = buildContext({
			redisStrings: { "Season:active": "2526" },
			redisHashes: { "EventLive:2526:33": { "1": field1, "2": field2 } },
		});

		const result = await liveRepository.getLivePerformancesByPlayerIds(context, 33, [2]);
		expect(result).toHaveLength(1);
		expect(result[0].playerId).toBe(2);
		expect(result[0].goalsScored).toBe(1);
	});

	it("returns empty array for empty player IDs", async () => {
		const context = buildContext({});
		const result = await liveRepository.getLivePerformancesByPlayerIds(context, 33, []);
		expect(result).toHaveLength(0);
	});

	it("degrades the whole targeted read when snapshot cardinality is incomplete", async () => {
		const revision = "e".repeat(24);
		const context = buildContext({
			redisStrings: { [`LiveSnapshotMeta:2526:33`]: snapshotMeta(revision, 2) },
			redisHashes: { "EventLive:2526:33": { "1": SAMPLE_SYNC_JOB_ROW } },
			supabaseData: [
				{
					event_id: 33,
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
					bonus: 0,
					bps: 20,
					starts: true,
					defensive_contribution: 0,
					expected_goals: null,
					expected_assists: null,
					expected_goal_involvements: null,
					expected_goals_conceded: null,
					in_dream_team: false,
					total_points: 9,
				},
			],
		});

		const result = await liveRepository.getLivePerformancesByPlayerIds(context, 33, [1]);
		expect(result).toHaveLength(1);
		expect(result[0].totalPoints).toBe(9);
	});
});

describe("liveRepository.getLivePerformancesForEventsAndPlayers", () => {
	it("reads historical live rows from event_lives in one bulk query", async () => {
		const context = buildContext({
			supabaseDataByTable: {
				event_lives: [
					{
						event_id: 12,
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
						bonus: 1,
						bps: 20,
						starts: true,
						defensive_contribution: 0,
						expected_goals: null,
						expected_assists: null,
						expected_goal_involvements: null,
						expected_goals_conceded: null,
						in_dream_team: false,
						total_points: 8,
					},
					{
						event_id: 13,
						element_id: 2,
						minutes: 0,
						goals_scored: 0,
						assists: 0,
						clean_sheets: 0,
						goals_conceded: 0,
						own_goals: 0,
						penalties_saved: 0,
						penalties_missed: 0,
						yellow_cards: 0,
						red_cards: 0,
						saves: 0,
						bonus: 0,
						bps: 0,
						starts: false,
						defensive_contribution: 0,
						expected_goals: null,
						expected_assists: null,
						expected_goal_involvements: null,
						expected_goals_conceded: null,
						in_dream_team: false,
						total_points: 0,
					},
				],
			},
		});

		const result = await liveRepository.getLivePerformancesForEventsAndPlayers(
			context,
			[12, 13],
			[1, 2]
		);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			eventId: 12,
			playerId: 1,
			totalPoints: 8,
		});
		expect(result[1]).toMatchObject({ eventId: 13, playerId: 2, minutes: 0 });
	});
});

describe("liveRepository.getEventLive", () => {
	it("returns EventLive with all Performances from Redis", async () => {
		const field1 = JSON.stringify({
			id: 100,
			eventId: 33,
			elementId: 1,
			minutes: 90,
			goalsScored: 0,
			assists: 0,
			cleanSheets: 0,
			goalsConceded: 2,
			ownGoals: 0,
			penaltiesSaved: 0,
			penaltiesMissed: 0,
			yellowCards: 0,
			redCards: 0,
			saves: 2,
			bonus: 0,
			bps: 8,
			starts: true,
			defensiveContribution: 0,
			expectedGoals: "0.00",
			expectedAssists: "0.00",
			expectedGoalInvolvements: "0.00",
			expectedGoalsConceded: "1.36",
			inDreamTeam: false,
			totalPoints: 1,
		});

		const context = buildContext({
			redisStrings: { "Season:active": "2526" },
			redisHashes: { "EventLive:2526:33": { "1": field1 } },
		});

		const result = await liveRepository.getEventLive(context, 33);
		expect(result.eventId).toBe(33);
		expect(result.performances).toHaveLength(1);
		expect(result.performances[0].playerId).toBe(1);
	});
});

describe("liveRepository.getEventLiveExplain", () => {
	const playerStatsRow34_526 = {
		event_id: 34,
		element_id: 526,
		total_points: 14,
		minutes: 66,
		goals_scored: 1,
		assists: 2,
		bonus: 3,
		yellow_cards: 1,
	};

	it("maps stats from player_stats and breakdown from event_live_explain", async () => {
		const explainFixture = {
			fixture: 8,
			stats: [{ identifier: "goals_scored", points: 4, value: 1 }],
		};
		const context = buildContext({
			supabaseDataByTable: {
				player_stats: [playerStatsRow34_526],
				event_live_explains: [
					{
						event_id: 34,
						element_id: 526,
						explain: [explainFixture],
					},
				],
			},
		});
		const result = await liveRepository.getEventLiveExplain(context, 34, 526);
		expect(result).not.toBeNull();
		expect(result?.stats.totalPoints).toBe(14);
		expect(result?.breakdown).toHaveLength(1);
		expect(result?.breakdown[0]?.fixtureId).toBe(8);
		expect(result?.breakdown[0]?.stats[0]?.identifier).toBe("goals_scored");
	});

	it("uses Redis `explain` when event_live_explain has no explain JSON", async () => {
		const redisExplain = {
			explain: [
				{
					fixture: 9,
					stats: [{ identifier: "minutes", points: 2, value: 66 }],
				},
			],
		};
		const context = buildContext({
			redisStrings: { "Season:active": "2526" },
			redisHashes: {
				"EventLiveExplain:2526:34": {
					526: JSON.stringify(redisExplain),
				},
			},
			supabaseDataByTable: {
				player_stats: [playerStatsRow34_526],
				event_live_explains: [{ event_id: 34, element_id: 526, explain: null }],
			},
		});
		const result = await liveRepository.getEventLiveExplain(context, 34, 526);
		expect(result?.stats.totalPoints).toBe(14);
		expect(result?.breakdown[0]?.fixtureId).toBe(9);
	});

	it("falls back to the historical element column", async () => {
		const attemptedColumns: string[] = [];
		const context = buildContext({}) as unknown as { supabase: unknown };
		context.supabase = {
			from: (table: string) => {
				let elementColumn = "";
				const builder = {
					select: () => builder,
					eq: (column: string) => {
						if (table === "event_live_explains" && column !== "event_id") {
							elementColumn = column;
							attemptedColumns.push(column);
						}
						return builder;
					},
					limit: async () => {
						if (table === "player_stats") {
							return { data: [playerStatsRow34_526], error: null };
						}
						if (elementColumn === "element_id") {
							return {
								data: null,
								error: {
									code: "42703",
									message: "column event_live_explains.element_id does not exist",
								},
							};
						}
						return {
							data: [
								{
									event_id: 34,
									element: 526,
									explain: [
										{
											fixture: 10,
											stats: [{ identifier: "bonus", points: 3, value: 3 }],
										},
									],
								},
							],
							error: null,
						};
					},
				};
				return builder;
			},
		};

		const result = await liveRepository.getEventLiveExplain(context as never, 34, 526);
		expect(attemptedColumns).toEqual(["element_id", "element"]);
		expect(result?.breakdown[0]?.fixtureId).toBe(10);
	});

	it("returns null when neither player_stats nor event_live_explain have a row", async () => {
		const context = buildContext({
			supabaseDataByTable: { player_stats: [], event_live_explains: [] },
		});
		const result = await liveRepository.getEventLiveExplain(context, 34, 526);
		expect(result).toBeNull();
	});
});
