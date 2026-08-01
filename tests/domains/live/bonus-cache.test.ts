import { describe, expect, it } from "bun:test";
import { loadLiveBonusByPlayerId } from "../../../src/domains/live/bonus-cache";
import type { GraphQLContext } from "../../../src/graphql/context";

const contextWithRedis = (hgetall: (key: string) => Promise<Record<string, string>>) =>
	({
		redis: {
			get: async (key: string) => (key === "Season:active" ? "2526" : null),
			hgetall,
		},
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
	}) as unknown as GraphQLContext;

describe("loadLiveBonusByPlayerId", () => {
	it("returns all fixture-summed overrides from a valid hash", async () => {
		const result = await loadLiveBonusByPlayerId(
			contextWithRedis(async () => ({
				"1": JSON.stringify({ "101": 5, "102": 0 }),
				"2": JSON.stringify({ "201": 3 }),
			})),
			12
		);

		expect(Object.fromEntries(result)).toEqual({ 101: 5, 102: 0, 201: 3 });
	});

	it("returns no override when any cached value is malformed", async () => {
		const result = await loadLiveBonusByPlayerId(
			contextWithRedis(async () => ({
				"1": JSON.stringify({ "101": 3 }),
				"2": JSON.stringify({ "201": "3oops" }),
			})),
			12
		);

		expect(result.size).toBe(0);
	});

	it("returns no override on Redis WRONGTYPE failures", async () => {
		const result = await loadLiveBonusByPlayerId(
			contextWithRedis(async () => {
				throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
			}),
			12
		);

		expect(result.size).toBe(0);
	});
});
