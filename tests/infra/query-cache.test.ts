import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../src/graphql/context";
import {
	deleteQueryCache,
	QUERY_CACHE_TTL_SECONDS,
	readJsonQueryCache,
	readJsonQueryCacheBatch,
	writeJsonQueryCache,
	writeQueryCache,
} from "../../src/infra/query-cache";

describe("GraphQL query cache policy", () => {
	it("keeps the accepted live, metadata, reporting, market and historical TTL classes", () => {
		expect(QUERY_CACHE_TTL_SECONDS).toEqual({
			LIVE: 10,
			METADATA: 60,
			REPORTING: 300,
			MARKET: 300,
			HISTORICAL: 3600,
		});
	});

	it("treats Redis writes and deletes as best-effort", async () => {
		const warnings: unknown[] = [];
		const context = {
			redis: {
				set: async () => {
					throw new Error("cache unavailable");
				},
				del: async () => {
					throw new Error("cache unavailable");
				},
			},
			logger: { warn: (...args: unknown[]) => warnings.push(args) },
		} as unknown as GraphQLContext;

		await expect(writeQueryCache(context, "key", "value", 60)).resolves.toBe(false);
		await expect(deleteQueryCache(context, "key")).resolves.toBe(false);
		expect(warnings).toHaveLength(2);
	});

	it("rejects non-expiring query-cache writes", async () => {
		const context = {} as GraphQLContext;
		await expect(writeQueryCache(context, "key", "value", 0)).rejects.toThrow(
			"must be a positive integer"
		);
	});

	it("decodes JSON caches and evicts malformed or rejected values", async () => {
		const values = new Map<string, string>([
			["valid", JSON.stringify({ id: 1 })],
			["bad-json", "{"],
			["wrong-shape", JSON.stringify({ id: "not-a-number" })],
		]);
		const context = {
			redis: {
				get: async (key: string) => values.get(key) ?? null,
				mget: async (...keys: string[]) => keys.map((key) => values.get(key) ?? null),
				del: async (key: string) => {
					values.delete(key);
				},
				set: async () => "OK",
			},
			logger: { warn: () => {} },
		} as unknown as GraphQLContext;
		const decode = (value: unknown): { id: number } | null => {
			if (typeof value !== "object" || value === null || !("id" in value)) return null;
			const id = (value as { id?: unknown }).id;
			return typeof id === "number" ? { id } : null;
		};
		expect(await readJsonQueryCache(context, "valid", decode)).toEqual({ id: 1 });
		expect(await readJsonQueryCache(context, "bad-json", decode)).toBeUndefined();
		expect(await readJsonQueryCache(context, "wrong-shape", decode)).toBeUndefined();
		expect(values.has("bad-json")).toBe(false);
		expect(values.has("wrong-shape")).toBe(false);
		expect(await readJsonQueryCacheBatch(context, ["valid", "missing"], decode)).toEqual([
			{ id: 1 },
			undefined,
		]);
		expect(await writeJsonQueryCache(context, "new", { id: 2 }, 60)).toBe(true);
	});
});
