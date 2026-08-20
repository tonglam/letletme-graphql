import { describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import { schema } from "../../../src/graphql/schema";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const context = () => {
	const core = buildTestCoreData(3);
	return buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)));
};

describe("playerStatsDesk", () => {
	it("bootstraps from one directory SQL without loading the full core publication", async () => {
		const core = buildTestCoreData(3);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const mgetKeys: string[] = [];
		const originalMget = redis.mget;
		redis.mget = async (...keys: string[]) => {
			mgetKeys.push(...keys);
			return originalMget(...keys);
		};
		let databaseQueries = 0;
		const requestContext = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseQueries += 1;
				const player = core.players[0]!;
				const team = core.teams.find((candidate) => candidate.id === player.teamId)!;
				return {
					rows: [
						{
							id: player.id,
							web_name: player.webName,
							element_type: player.type,
							team_id: team.id,
							team_name: team.name,
							team_short_name: team.shortName,
							price: player.price,
							selected_by_percent: player.selectedByPercent,
							total_points: player.totalPoints,
							form: null,
							total_count: core.players.length,
						},
					],
				};
			},
		});

		const result = await graphql({
			schema,
			source: `
				query Bootstrap {
					playerStatsBootstrap(limit: 1) {
						context { revision currentEventId }
						teams { id }
						directory { items { id } totalCount nextCursor }
					}
				}
			`,
			contextValue: requestContext,
		});

		expect(result.errors).toBeUndefined();
		expect(JSON.parse(JSON.stringify(result.data))).toMatchObject({
			playerStatsBootstrap: {
				context: { revision: "7", currentEventId: 3 },
				teams: core.teams.map((team) => ({ id: team.id })),
				directory: {
					items: [{ id: core.players[0]!.id }],
					totalCount: core.players.length,
				},
			},
		});
		expect(databaseQueries).toBe(1);
		expect(mgetKeys.some((key) => /:(players|fixtures|phases)$/.test(key))).toBe(false);
	});

	it("preserves the one-or-two-player input order on a pinned event revision", async () => {
		const requestContext = context();
		const result = await graphql({
			schema,
			source: `
				query Desk($ids: [Int!]!, $event: Int!) {
					playerStatsDesk(playerIds: $ids, eventId: $event, horizon: 5) {
						eventId horizon entries { playerId }
					}
				}
			`,
			variableValues: { ids: [27, 13], event: 3 },
			contextValue: requestContext,
		});

		expect(result.errors).toBeUndefined();
		expect(JSON.parse(JSON.stringify(result.data))).toEqual({
			playerStatsDesk: {
				eventId: 3,
				horizon: 5,
				entries: [{ playerId: 27 }, { playerId: 13 }],
			},
		});
		expect(requestContext.dataRevision).toBe("core-7");
	});

	it("rejects duplicates, oversized batches, invalid gameweeks, and invalid horizons", async () => {
		for (const variables of [
			{ ids: [13, 13], event: 1, horizon: 5 },
			{ ids: [1, 2, 3], event: 1, horizon: 5 },
			{ ids: [13], event: 39, horizon: 5 },
			{ ids: [13], event: 1, horizon: 9 },
		]) {
			const result = await graphql({
				schema,
				source: `
					query Desk($ids: [Int!]!, $event: Int!, $horizon: Int!) {
						playerStatsDesk(playerIds: $ids, eventId: $event, horizon: $horizon) {
							entries { playerId }
						}
					}
				`,
				variableValues: variables,
				contextValue: context(),
			});
			expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
		}
	});
});
