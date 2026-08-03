import { describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import { schema } from "../../../src/graphql/schema";
import type { GraphQLContext } from "../../../src/graphql/context";

describe("liveSnapshot GraphQL contract", () => {
	it("exposes revision, freshness, state, and completeness without reshaping metadata", async () => {
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "a".repeat(24),
			state: "live",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:01:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 10,
			fixtureTeamCount: 20,
			bonusTeamCount: 4,
		});
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return metadata;
					return null;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
			supabase: {},
		} as unknown as GraphQLContext;

		const result = await graphql({
			schema,
			source: `
				query Snapshot($eventId: Int!) {
					liveSnapshot(eventId: $eventId) {
						schemaVersion season eventId revision state
						publishedAt checkedAt eventLiveCount fixtureCount
						fixtureTeamCount bonusTeamCount
					}
				}
			`,
			variableValues: { eventId: 33 },
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveSnapshot).toEqual({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "a".repeat(24),
			state: "LIVE",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:01:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 10,
			fixtureTeamCount: 20,
			bonusTeamCount: 4,
		});
	});

	it("infers the current event when the optional eventId is omitted", async () => {
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "b".repeat(24),
			state: "scheduled",
			publishedAt: "2025-08-15T18:00:00.000Z",
			checkedAt: "2025-08-15T18:01:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 10,
			fixtureTeamCount: 20,
			bonusTeamCount: 0,
		});
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "event:current") return JSON.stringify({ id: 33, isCurrent: true });
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return metadata;
					return null;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
			supabase: {},
		} as unknown as GraphQLContext;

		const result = await graphql({
			schema,
			source: `query { liveSnapshot { eventId revision state bonusTeamCount } }`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveSnapshot).toEqual({
			eventId: 33,
			revision: "b".repeat(24),
			state: "SCHEDULED",
			bonusTeamCount: 0,
		});
	});

	it("pins one inferred current event across sibling root fields", async () => {
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "d".repeat(24),
			state: "live",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:01:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 10,
			fixtureTeamCount: 20,
			bonusTeamCount: 2,
		});
		let currentEventReads = 0;
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "event:current") {
						currentEventReads += 1;
						return JSON.stringify({ id: currentEventReads === 1 ? 33 : 34, isCurrent: true });
					}
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return metadata;
					return null;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
			supabase: {},
		} as unknown as GraphQLContext;

		const result = await graphql({
			schema,
			source: `query {
				first: liveSnapshot { eventId revision }
				second: liveSnapshot { eventId revision }
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.first).toEqual({ eventId: 33, revision: "d".repeat(24) });
		expect(result.data?.second).toEqual({ eventId: 33, revision: "d".repeat(24) });
		expect(currentEventReads).toBe(1);
	});

	it("shares one final metadata read across explicit snapshot aliases", async () => {
		let metadataReads = 0;
		const metadata = (revision: string) =>
			JSON.stringify({
				schemaVersion: 1,
				season: "2526",
				eventId: 33,
				revision,
				state: "live",
				publishedAt: "2025-08-15T20:00:00.000Z",
				checkedAt: "2025-08-15T20:01:00.000Z",
				eventLiveCount: 700,
				fixtureCount: 10,
				fixtureTeamCount: 20,
				bonusTeamCount: 2,
			});
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") {
						metadataReads += 1;
						return metadata(metadataReads === 1 ? "e".repeat(24) : "f".repeat(24));
					}
					return null;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
			supabase: {},
		} as unknown as GraphQLContext;

		const result = await graphql({
			schema,
			source: `query {
				first: liveSnapshot(eventId: 33) { revision }
				second: liveSnapshot(eventId: 33) { revision }
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.first).toEqual({ revision: "e".repeat(24) });
		expect(result.data?.second).toEqual({ revision: "e".repeat(24) });
		expect(metadataReads).toBe(1);
	});

	it("coordinates public event fixtures with snapshot fallback for the operation", async () => {
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision: "1".repeat(24),
			state: "live",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:01:00.000Z",
			eventLiveCount: 700,
			fixtureCount: 2,
			fixtureTeamCount: 4,
			bonusTeamCount: 2,
		});
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return metadata;
					return null;
				},
				hgetall: async () => ({
					"101": JSON.stringify({
						id: 101,
						code: 101,
						event: 33,
						finished: false,
						finishedProvisional: false,
						kickoffTime: null,
						minutes: 45,
						started: true,
						teamH: 1,
						teamA: 2,
						teamHScore: 1,
						teamAScore: 0,
						teamHDifficulty: 2,
						teamADifficulty: 4,
					}),
				}),
			},
			supabase: {
				from: () => ({
					select: () => ({
						eq: () => ({
							order: async () => ({
								data: [
									{
										id: 101,
										code: 101,
										event_id: 33,
										finished: false,
										finished_provisional: false,
										kickoff_time: null,
										minutes: 46,
										started: true,
										team_h_id: 1,
										team_a_id: 2,
										team_h_score: 2,
										team_a_score: 0,
										team_h_difficulty: 2,
										team_a_difficulty: 4,
									},
								],
								error: null,
							}),
						}),
					}),
				}),
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const result = await graphql({
			schema,
			source: `query {
				eventFixtures(eventId: 33) { id code minutes homeScore }
				liveSnapshot(eventId: 33) { revision }
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.eventFixtures).toEqual([{ id: 101, code: 101, minutes: 46, homeScore: 2 }]);
		expect(result.data?.liveSnapshot).toBeNull();
	});

	it("does not report a Redis revision when live scores reuse its database fallback cache", async () => {
		const revision = "2".repeat(24);
		const metadata = JSON.stringify({
			schemaVersion: 1,
			season: "2526",
			eventId: 33,
			revision,
			state: "live",
			publishedAt: "2025-08-15T20:00:00.000Z",
			checkedAt: "2025-08-15T20:01:00.000Z",
			eventLiveCount: 1,
			fixtureCount: 1,
			fixtureTeamCount: 2,
			bonusTeamCount: 0,
		});
		const fallback = JSON.stringify([
			{
				eventId: 33,
				playerId: 1,
				minutes: 90,
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
				bps: 20,
				starts: true,
				defensiveContribution: 0,
				expectedGoals: null,
				expectedAssists: null,
				expectedGoalInvolvements: null,
				expectedGoalsConceded: null,
				inDreamTeam: false,
				totalPoints: 9,
			},
		]);
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return metadata;
					if (key === `gql:v2:2526:live:all:33:revision:${revision}:fallback15`) {
						return fallback;
					}
					return null;
				},
				hgetall: async (key: string): Promise<Record<string, string>> =>
					key === "Fixtures:2526:33"
						? {
								"101": JSON.stringify({
									id: 101,
									code: 101,
									event: 33,
									finished: false,
									finishedProvisional: false,
									kickoffTime: null,
									minutes: 45,
									started: true,
									teamH: 1,
									teamA: 2,
									teamHScore: 1,
									teamAScore: 0,
									teamHDifficulty: 2,
									teamADifficulty: 4,
								}),
							}
						: {},
				hmget: async (): Promise<string[]> => [
					JSON.stringify({
						id: 1,
						code: 1,
						webName: "Player",
						teamId: 1,
						type: 3,
						price: 50,
						startPrice: 50,
					}),
				],
			},
			supabase: {
				from: () => ({
					select: () => ({
						eq: () => ({
							order: async () => ({
								data: [
									{
										id: 101,
										code: 101,
										event_id: 33,
										finished: false,
										finished_provisional: false,
										kickoff_time: null,
										minutes: 46,
										started: true,
										team_h_id: 1,
										team_a_id: 2,
										team_h_score: 2,
										team_a_score: 0,
										team_h_difficulty: 2,
										team_a_difficulty: 4,
									},
								],
								error: null,
							}),
						}),
					}),
				}),
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const result = await graphql({
			schema,
			source: `query {
				liveScores(eventId: 33) { totalPoints }
				eventFixtures(eventId: 33) { minutes homeScore }
				liveSnapshot(eventId: 33) { revision }
			}`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveScores).toEqual([{ totalPoints: 7 }]);
		expect(result.data?.eventFixtures).toEqual([{ minutes: 46, homeScore: 2 }]);
		expect(result.data?.liveSnapshot).toBeNull();
	});
});
