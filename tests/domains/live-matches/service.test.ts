import { describe, expect, it } from "bun:test";
import {
	applyLiveFixtureScores,
	loadLiveFixtureBucketsFromRedis,
	loadUpcomingEventFixtures,
	parseLiveFixtureRow,
	resolveLiveMatchStatus,
} from "../../../src/domains/live-matches/service";
import {
	isLiveSnapshotDatabaseFallback,
	loadOperationLiveSnapshotMeta,
	withLiveSnapshotConsistency,
} from "../../../src/domains/live/snapshot-meta";
import type { GraphQLContext } from "../../../src/graphql/context";

const fixtureIdentity = [{ id: 701, teamHId: 1, teamAId: 2 }] as const;

describe("resolveLiveMatchStatus", () => {
	it("prefers the authoritative fixture ID over a stale pair status", () => {
		const fixture = { id: 701, teamHId: 1, teamAId: 2, finished: false, started: true };
		const byFixtureId = new Map([[701, "FINISHED" as const]]);
		const byPair = new Map([["1:2", "PLAYING" as const]]);

		expect(resolveLiveMatchStatus(fixture, byFixtureId, byPair)).toBe("FINISHED");
	});

	it("falls back to the home-away pair and then database fixture flags", () => {
		const fixture = { id: 702, teamHId: 3, teamAId: 4, finished: false, started: false };
		expect(resolveLiveMatchStatus(fixture, new Map(), new Map([["3:4", "PLAYING" as const]]))).toBe(
			"PLAYING"
		);
		expect(resolveLiveMatchStatus(fixture, new Map(), new Map())).toBe("NOT_STARTED");
	});
});

describe("parseLiveFixtureRow cache validation", () => {
	it("rejects partially numeric IDs and fractional scores", () => {
		expect(
			parseLiveFixtureRow({
				fixtureId: "701junk",
				teamId: 1,
				againstId: 2,
				teamScore: 1,
				againstTeamScore: 0,
				wasHome: true,
			})
		).toBeNull();
		expect(
			parseLiveFixtureRow({
				fixtureId: 701,
				teamId: 1,
				againstId: 2,
				teamScore: 1.5,
				againstTeamScore: 0,
				wasHome: true,
			})
		).toBeNull();
	});
});

describe("applyLiveFixtureScores", () => {
	it("prefers Redis live scores when the database fixture is lagging", () => {
		const fixture = {
			id: 701,
			code: 701,
			eventId: 12,
			finished: false,
			finishedProvisional: false,
			kickoffTime: null,
			minutes: 0,
			provisionalStartTime: false,
			started: true,
			teamAId: 2,
			teamAScore: 0,
			teamHId: 1,
			teamHScore: 0,
			stats: [],
			teamHDifficulty: 3,
			teamADifficulty: 3,
			pulseId: null,
		};

		expect(applyLiveFixtureScores(fixture, { teamScore: 3, againstTeamScore: 2 })).toMatchObject({
			teamHScore: 3,
			teamAScore: 2,
		});
	});
});

describe("loadLiveFixtureBucketsFromRedis", () => {
	it("prefers fixture-identified V2 rows without reading the legacy hash", async () => {
		const keys: string[] = [];
		const context = {
			redis: {
				get: async (key: string) => (key === "Season:active" ? "2526" : null),
				hgetall: async (key: string) => {
					keys.push(key);
					return key.startsWith("LiveFixtureV2:")
						? {
								"1": JSON.stringify({
									Playing: [
										{
											fixtureId: 701,
											teamId: 1,
											againstId: 2,
											teamScore: 3,
											againstTeamScore: 2,
											wasHome: true,
										},
									],
								}),
							}
						: {};
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const buckets = await loadLiveFixtureBucketsFromRedis(context, 33, fixtureIdentity);
		expect(buckets?.playing[0]).toMatchObject({ fixtureId: 701, teamScore: 3 });
		expect(keys).toEqual(["LiveFixtureV2:2526:33"]);
	});

	it("falls back to the frozen legacy hash during a producer rollout", async () => {
		const keys: string[] = [];
		const context = {
			redis: {
				get: async (key: string) => (key === "Season:active" ? "2526" : null),
				hgetall: async (key: string) => {
					keys.push(key);
					if (key.startsWith("LiveFixtureV2:")) return {};
					return {
						"1": JSON.stringify({
							Playing: [
								{
									teamId: 1,
									againstId: 2,
									teamScore: 1,
									againstTeamScore: 0,
									wasHome: true,
								},
							],
						}),
					};
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const buckets = await loadLiveFixtureBucketsFromRedis(context, 33, fixtureIdentity);
		expect(buckets?.playing[0]).toMatchObject({ fixtureId: null, teamScore: 1 });
		expect(keys).toEqual(["LiveFixtureV2:2526:33", "LiveFixture:2526:33"]);
	});

	it("accepts an intentionally empty Redis fixture view for a confirmed blank gameweek", async () => {
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "b".repeat(24),
			state: "settled",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:00:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 0,
			fixtureTeamCount: 0,
			bonusTeamCount: 0,
		});
		const context = {
			redis: {
				get: async (key: string) =>
					key === "Season:active" ? "2526" : key === "LiveSnapshotMeta:2526:33" ? metadata : null,
				hgetall: async () => ({}),
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		expect(await loadLiveFixtureBucketsFromRedis(context, 33, [])).toEqual({
			notStarted: [],
			playing: [],
			finished: [],
		});
	});

	it("forces whole-operation database mode when metadata has no complete fixture view", async () => {
		const hgetallKeys: string[] = [];
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "c".repeat(24),
			state: "live",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:00:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 10,
			fixtureTeamCount: 20,
			bonusTeamCount: 2,
		});
		const context = {
			redis: {
				get: async (key: string) => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return metadata;
					return null;
				},
				hgetall: async (key: string) => {
					hgetallKeys.push(key);
					return {};
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const result = await withLiveSnapshotConsistency(context, 33, () =>
			loadLiveFixtureBucketsFromRedis(context, 33, fixtureIdentity)
		);

		expect(result).toBeNull();
		expect(isLiveSnapshotDatabaseFallback(context, 33)).toBe(true);
		expect(hgetallKeys).toEqual(["LiveFixtureV2:2526:33", "LiveFixture:2526:33"]);
	});

	it("rejects same-sized live views whose fixture identities belong to another event", async () => {
		const hgetallKeys: string[] = [];
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "d".repeat(24),
			state: "live",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:00:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 1,
			fixtureTeamCount: 2,
			bonusTeamCount: 2,
		});
		const liveHash = (
			home: { fixtureId?: number; teamId: number; againstId: number },
			away: { fixtureId?: number; teamId: number; againstId: number }
		) => ({
			[String(home.teamId)]: JSON.stringify({
				Playing: [{ ...home, teamScore: 3, againstTeamScore: 2, wasHome: true }],
			}),
			[String(away.teamId)]: JSON.stringify({
				Playing: [{ ...away, teamScore: 2, againstTeamScore: 3, wasHome: false }],
			}),
		});
		const context = {
			redis: {
				get: async (key: string) => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return metadata;
					return null;
				},
				hgetall: async (key: string) => {
					hgetallKeys.push(key);
					return key.startsWith("LiveFixtureV2:")
						? liveHash(
								{ fixtureId: 999, teamId: 1, againstId: 2 },
								{ fixtureId: 999, teamId: 2, againstId: 1 }
							)
						: liveHash({ teamId: 9, againstId: 10 }, { teamId: 10, againstId: 9 });
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const result = await withLiveSnapshotConsistency(context, 33, () =>
			loadLiveFixtureBucketsFromRedis(context, 33, fixtureIdentity)
		);

		expect(result).toBeNull();
		expect(isLiveSnapshotDatabaseFallback(context, 33)).toBe(true);
		expect(hgetallKeys).toEqual(["LiveFixtureV2:2526:33", "LiveFixture:2526:33"]);
	});
});

describe("loadUpcomingEventFixtures", () => {
	it("coordinates next-event fallback with the next-event snapshot decision", async () => {
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 34,
			revision: "e".repeat(24),
			state: "scheduled",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:00:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 2,
			fixtureTeamCount: 4,
			bonusTeamCount: 0,
		});
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:34") return metadata;
					return null;
				},
				set: async (): Promise<"OK"> => "OK",
				hgetall: async () => ({
					"3401": JSON.stringify({
						id: 3401,
						code: 3401,
						event: 34,
						finished: false,
						kickoffTime: "2026-04-25T14:00:00.000Z",
						minutes: 0,
						started: false,
						teamH: 1,
						teamA: 2,
					}),
				}),
			},
			supabase: {
				from: () => {
					const result = {
						data: [
							{
								id: 3402,
								code: 3402,
								event_id: 34,
								finished: false,
								finished_provisional: false,
								kickoff_time: "2026-04-25T16:30:00.000Z",
								minutes: 0,
								started: false,
								team_h_id: 3,
								team_a_id: 4,
								team_h_score: null,
								team_a_score: null,
								team_h_difficulty: 3,
								team_a_difficulty: 3,
							},
						],
						error: null,
					};
					const builder = {
						select: () => builder,
						eq: () => builder,
						order: async () => result,
					};
					return builder;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const fixtures = await loadUpcomingEventFixtures(context, 33);

		expect(fixtures.map((fixture) => fixture.id)).toEqual([3402]);
		expect(isLiveSnapshotDatabaseFallback(context, 34)).toBe(true);
		expect(await loadOperationLiveSnapshotMeta(context, 34)).toBeNull();
	});
});
