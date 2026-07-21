import { describe, expect, it } from "bun:test";
import { playersRepository } from "../../../src/domains/players/repository";

describe("playersRepository.getPlayerByIdForEvent", () => {
	it("returns and caches the base player when event-stat enrichment fails", async () => {
		const cache = new Map<string, string>([["Season:active", "2526"]]);
		const writes: string[] = [];
		const redis = {
			get: async (key: string) => cache.get(key) ?? null,
			hget: async () =>
				JSON.stringify({
					code: 101,
					webName: "Base Player",
					teamId: 1,
					type: 3,
					price: 75,
					startPrice: 70,
					totalPoints: 42,
				}),
			set: async (key: string, value: string) => {
				cache.set(key, value);
				writes.push(key);
				return "OK";
			},
			del: async () => 0,
		};

		const queryResult = { data: null, error: { message: "player_stats unavailable" } };
		const supabase = {
			from: () => {
				const query = Promise.resolve(queryResult);
				type Builder = typeof query & {
					select: () => Builder;
					eq: () => Builder;
					limit: () => Builder;
				};
				const builder = query as Builder;
				Object.assign(builder, {
					select: () => builder,
					eq: () => builder,
					limit: () => builder,
				});
				return builder;
			},
		};

		const context = {
			redis,
			supabase,
			logger: { warn: () => undefined, error: () => undefined },
		} as never;

		const player = await playersRepository.getPlayerByIdForEvent(context, 10, 12);
		expect(player).toMatchObject({ id: 10, webName: "Base Player", totalPoints: 42 });
		expect(writes).toContain("gql:v2:2526:players:id:10:event:12");
	});
});
