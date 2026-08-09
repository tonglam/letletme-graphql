import { describe, expect, it } from "bun:test";
import { fixturesRepository } from "../../../src/domains/fixtures/repository";
import { withLiveSnapshotConsistency } from "../../../src/domains/live/snapshot-meta";
import type { GraphQLContext } from "../../../src/graphql/context";

const buildContext = (options: {
	redisData?: Record<string, string>;
	redisHashes?: Record<string, Record<string, string>>;
	redis?: GraphQLContext["redis"];
	supabaseData?: unknown[];
	supabaseError?: unknown;
	supabaseFromCalls?: string[];
}): GraphQLContext => {
	const redisStrings = new Map<string, string>();
	const redisHashes = new Map<string, Record<string, string>>();

	if (options.redisData) {
		for (const [key, value] of Object.entries(options.redisData)) {
			redisStrings.set(key, value);
		}
	}
	if (options.redisHashes) {
		for (const [key, value] of Object.entries(options.redisHashes)) {
			redisHashes.set(key, value);
		}
	}

	return {
		redis:
			options.redis ??
			({
				get: async (key: string) => redisStrings.get(key) ?? null,
				set: async (key: string, value: string, ..._args: unknown[]) => {
					redisStrings.set(key, value);
					return "OK";
				},
				hgetall: async (key: string) => redisHashes.get(key) ?? {},
				expire: async () => 1,
			} as never),
		supabase: {
			from: () => {
				options.supabaseFromCalls?.push("event_fixtures");
				const builder = {
					select: () => builder,
					eq: () => builder,
					order: async () => ({
						data: options.supabaseData ?? [],
						error: options.supabaseError ?? null,
					}),
				};
				return builder;
			},
		} as never,
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		} as never,
		user: undefined,
	} as GraphQLContext;
};

describe("fixturesRepository.getEventFixtures", () => {
	it("returns fixtures from Redis hash when available", async () => {
		const fixtureJson = JSON.stringify({
			id: 328,
			code: 2562222,
			event: 33,
			finished: true,
			finishedProvisional: true,
			kickoffTime: "2026-04-18T14:00:00.000Z",
			minutes: 90,
			started: true,
			teamH: 15,
			teamA: 4,
			teamHScore: 1,
			teamAScore: 2,
			teamHDifficulty: 3,
			teamADifficulty: 4,
		});

		const context = buildContext({
			redisHashes: {
				"Fixtures:2526:33": { "328": fixtureJson },
			},
			redisData: {
				"Season:active": "2526",
			},
		});

		const result = await fixturesRepository.getEventFixtures(context, 33);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(328);
		expect(result[0].eventId).toBe(33);
		expect(result[0].teamHId).toBe(15);
		expect(result[0].teamAId).toBe(4);
		expect(result[0].teamHScore).toBe(1);
		expect(result[0].teamAScore).toBe(2);
		expect(result[0].finished).toBe(true);
		expect(result[0].started).toBe(true);
	});

	it("handles snake_case fields from sync job fixture data", async () => {
		const fixtureJson = JSON.stringify({
			id: 100,
			code: 12345,
			event: 5,
			finished: false,
			finished_provisional: false,
			kickoff_time: "2026-04-20T15:00:00.000Z",
			minutes: 0,
			started: false,
			team_h: 10,
			team_a: 20,
			team_h_score: null,
			team_a_score: null,
			team_h_difficulty: 4,
			team_a_difficulty: 3,
		});

		const context = buildContext({
			redisHashes: {
				"Fixtures:2526:5": { "100": fixtureJson },
			},
			redisData: {
				"Season:active": "2526",
			},
		});

		const result = await fixturesRepository.getEventFixtures(context, 5);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(100);
		expect(result[0].eventId).toBe(5);
		expect(result[0].teamHId).toBe(10);
		expect(result[0].teamAId).toBe(20);
		expect(result[0].finishedProvisional).toBe(false);
		expect(result[0].teamHScore).toBeNull();
	});

	it("falls back when a Redis fixture contains partially numeric fields", async () => {
		const context = buildContext({
			redisHashes: {
				"Fixtures:2526:5": {
					"100": JSON.stringify({
						id: 100,
						code: 12345,
						event: "5junk",
						teamH: 10,
						teamA: 20,
					}),
				},
			},
			redisData: { "Season:active": "2526" },
			supabaseData: [
				{
					id: 101,
					code: 12346,
					event_id: 5,
					finished: false,
					finished_provisional: false,
					kickoff_time: null,
					minutes: 0,
					started: false,
					team_h_id: 11,
					team_a_id: 21,
					team_h_score: null,
					team_a_score: null,
					team_h_difficulty: 3,
					team_a_difficulty: 4,
				},
			],
		});

		const result = await fixturesRepository.getEventFixtures(context, 5);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(101);
	});

	it("returns empty array when Redis hash is missing and DB returns empty", async () => {
		const context = buildContext({
			redisData: {
				"Season:active": "2526",
			},
		});

		const result = await fixturesRepository.getEventFixtures(context, 33);
		expect(result).toEqual([]);
	});

	it("accepts an authoritative empty Redis hash for a confirmed blank gameweek", async () => {
		const context = buildContext({
			redisData: {
				"Season:active": "2526",
				"LiveSnapshotMeta:2526:33": JSON.stringify({
					schemaVersion: 1,
					season: "2526",
					eventId: 33,
					revision: "a".repeat(24),
					state: "settled",
					publishedAt: "2026-04-18T14:00:00.000Z",
					checkedAt: "2026-04-18T15:00:00.000Z",
					eventLiveCount: 1,
					fixtureCount: 0,
					fixtureTeamCount: 0,
					bonusTeamCount: 0,
				}),
			},
			supabaseError: new Error("database unavailable"),
		});

		expect(await fixturesRepository.getEventFixtures(context, 33)).toEqual([]);
	});

	it("falls back to the database when any Redis fixture is malformed", async () => {
		const validFixture = JSON.stringify({
			id: 328,
			code: 2562222,
			event: 33,
			finished: true,
			kickoffTime: "2026-04-18T14:00:00.000Z",
			minutes: 90,
			started: true,
			teamH: 15,
			teamA: 4,
		});
		const invalidJson = "not-json{{{";

		const context = buildContext({
			redisHashes: {
				"Fixtures:2526:33": { "328": validFixture, "999": invalidJson },
			},
			redisData: {
				"Season:active": "2526",
			},
			supabaseData: [
				{
					id: 329,
					code: 2562223,
					event_id: 33,
					finished: true,
					finished_provisional: true,
					kickoff_time: "2026-04-18T16:30:00.000Z",
					minutes: 90,
					started: true,
					team_h_id: 8,
					team_a_id: 12,
					team_h_score: 2,
					team_a_score: 0,
					team_h_difficulty: 2,
					team_a_difficulty: 4,
				},
			],
		});

		const result = await fixturesRepository.getEventFixtures(context, 33);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(329);
	});

	it("retries all consistency-wrapped reads in database mode for an incomplete revision", async () => {
		const fixtureJson = JSON.stringify({
			id: 328,
			code: 2562222,
			event: 33,
			finished: false,
			kickoffTime: "2026-04-18T14:00:00.000Z",
			minutes: 60,
			started: true,
			teamH: 15,
			teamA: 4,
		});
		const snapshotMeta = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "a".repeat(24),
			state: "live",
			publishedAt: "2026-04-18T14:00:00.000Z",
			checkedAt: "2026-04-18T15:00:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 2,
			fixtureTeamCount: 4,
			bonusTeamCount: 2,
		});
		const context = buildContext({
			redisHashes: { "Fixtures:2526:33": { "328": fixtureJson } },
			redisData: {
				"Season:active": "2526",
				"LiveSnapshotMeta:2526:33": snapshotMeta,
			},
			supabaseData: [
				{
					id: 329,
					code: 2562223,
					event_id: 33,
					finished: true,
					finished_provisional: true,
					kickoff_time: "2026-04-18T16:30:00.000Z",
					minutes: 90,
					started: true,
					team_h_id: 8,
					team_a_id: 12,
					team_h_score: 2,
					team_a_score: 0,
					team_h_difficulty: 2,
					team_a_difficulty: 4,
				},
			],
		});

		const result = await withLiveSnapshotConsistency(context, 33, () =>
			fixturesRepository.getEventFixtures(context, 33)
		);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(329);
	});

	it("rejects same-sized fixture hashes with foreign, mismatched, or duplicate identities", async () => {
		const foreignFixture = JSON.stringify({
			id: 328,
			code: 2562222,
			event: 34,
			finished: false,
			kickoffTime: "2026-04-18T14:00:00.000Z",
			minutes: 60,
			started: true,
			teamH: 15,
			teamA: 4,
		});
		const duplicateUnderWrongField = JSON.stringify({
			id: 328,
			code: 2562222,
			event: 33,
			finished: false,
			kickoffTime: "2026-04-18T14:00:00.000Z",
			minutes: 60,
			started: true,
			teamH: 15,
			teamA: 4,
		});
		const snapshotMeta = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "b".repeat(24),
			state: "live",
			publishedAt: "2026-04-18T14:00:00.000Z",
			checkedAt: "2026-04-18T15:00:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 2,
			fixtureTeamCount: 4,
			bonusTeamCount: 2,
		});
		const context = buildContext({
			redisHashes: {
				"Fixtures:2526:33": {
					"328": foreignFixture,
					"329": duplicateUnderWrongField,
				},
			},
			redisData: {
				"Season:active": "2526",
				"LiveSnapshotMeta:2526:33": snapshotMeta,
			},
			supabaseData: [
				{
					id: 330,
					code: 2562224,
					event_id: 33,
					finished: true,
					finished_provisional: true,
					kickoff_time: "2026-04-18T18:30:00.000Z",
					minutes: 90,
					started: true,
					team_h_id: 6,
					team_a_id: 9,
					team_h_score: 1,
					team_a_score: 1,
					team_h_difficulty: 3,
					team_a_difficulty: 3,
				},
			],
		});

		const result = await withLiveSnapshotConsistency(context, 33, () =>
			fixturesRepository.getEventFixtures(context, 33)
		);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(330);
	});

	it("coalesces and revision-caches coordinated fixture database fallback", async () => {
		const revision = "c".repeat(24);
		const fixtureJson = JSON.stringify({
			id: 328,
			code: 2562222,
			event: 33,
			finished: false,
			kickoffTime: "2026-04-18T14:00:00.000Z",
			minutes: 60,
			started: true,
			teamH: 15,
			teamA: 4,
		});
		const snapshotMeta = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision,
			state: "live",
			publishedAt: "2026-04-18T14:00:00.000Z",
			checkedAt: "2026-04-18T15:00:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 2,
			fixtureTeamCount: 4,
			bonusTeamCount: 2,
		});
		const seedContext = buildContext({
			redisHashes: { "Fixtures:2526:33": { "328": fixtureJson } },
			redisData: {
				"Season:active": "2526",
				"LiveSnapshotMeta:2526:33": snapshotMeta,
			},
		});
		const sharedRedis = seedContext.redis;
		const supabaseFromCalls: string[] = [];
		const supabaseData = [
			{
				id: 329,
				code: 2562223,
				event_id: 33,
				finished: true,
				finished_provisional: true,
				kickoff_time: "2026-04-18T16:30:00.000Z",
				minutes: 90,
				started: true,
				team_h_id: 8,
				team_a_id: 12,
				team_h_score: 2,
				team_a_score: 0,
				team_h_difficulty: 2,
				team_a_difficulty: 4,
			},
		];
		const read = () => {
			const context = buildContext({
				redis: sharedRedis,
				supabaseData,
				supabaseFromCalls,
			});
			return withLiveSnapshotConsistency(context, 33, () =>
				fixturesRepository.getEventFixtures(context, 33)
			);
		};

		const firstWave = await Promise.all(Array.from({ length: 25 }, read));
		expect(firstWave.every((fixtures) => fixtures[0]?.id === 329)).toBe(true);
		expect(supabaseFromCalls).toEqual(["event_fixtures"]);

		const cached = await read();
		expect(cached[0]?.id).toBe(329);
		expect(supabaseFromCalls).toEqual(["event_fixtures"]);
	});
});
