import { describe, expect, it } from "bun:test";
import { buildPlayerMap } from "../../src/infra/player-map";
import type { GraphQLContext } from "../../src/graphql/context";

describe("player map cache validation", () => {
	it("falls back when a cached player is missing required identity fields", async () => {
		const dbResult = {
			data: [
				{
					id: 10,
					code: 10010,
					web_name: "Haaland",
					first_name: "Erling",
					second_name: "Haaland",
					team_id: 13,
					type: 4,
					price: 150,
					start_price: 145,
				},
			],
			error: null,
		};
		const context = {
			redis: {
				get: async () => "2627",
				hmget: async () => [JSON.stringify({ teamId: 13, type: 4, code: 0, webName: "" })],
			},
			supabase: {
				from: () => {
					const promise = Promise.resolve(dbResult);
					const builder = Object.assign(promise, {
						select: () => builder,
						in: () => builder,
					});
					return builder;
				},
			},
			logger: { warn: () => undefined },
		} as unknown as GraphQLContext;

		const players = await buildPlayerMap(context, [10]);
		expect(players.get(10)).toMatchObject({ id: 10, code: 10010, webName: "Haaland" });
	});
});
