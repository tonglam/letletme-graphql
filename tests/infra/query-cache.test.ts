import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../src/graphql/context";
import {
	deleteQueryCache,
	QUERY_CACHE_TTL_SECONDS,
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
});
