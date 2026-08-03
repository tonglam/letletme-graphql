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
});
