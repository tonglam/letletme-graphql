import { describe, expect, test } from "bun:test";
import { GRAPHQL_CACHE_NAMESPACE, gqlCacheKey } from "../../src/infra/cache-key";
import type { GraphQLContext } from "../../src/graphql/context";

const context = (seasonCode = "2627", dataRevision: string | null = "core-7") =>
	({
		currentSeason: { seasonId: 2026, seasonCode },
		dataRevision,
	}) as GraphQLContext;

describe("gqlCacheKey", () => {
	test("namespaces every query by Data dataset revision", () => {
		const key = gqlCacheKey(context(), "players:list:all");

		expect(key.startsWith(`${GRAPHQL_CACHE_NAMESPACE}:core-7:`)).toBe(true);
	});

	test("isolates cache entries by revision, season and raw query arguments", () => {
		const base = gqlCacheKey(context(), "players:list:all");

		expect(gqlCacheKey(context("2627", "core-8"), "players:list:all")).not.toBe(base);
		expect(gqlCacheKey(context("2728"), "players:list:all")).not.toBe(base);
		expect(gqlCacheKey(context(), "players:list:midfielders")).not.toBe(base);
	});

	test("rejects missing or non-canonical dataset revisions", () => {
		expect(() => gqlCacheKey(context("2627", null), "players:list:all")).toThrow(
			"requires a Data dataset revision"
		);
		expect(() => gqlCacheKey(context(), "players:list:all", "core/7")).toThrow(
			"Invalid Data dataset revision"
		);
	});
});
