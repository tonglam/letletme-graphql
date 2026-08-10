import { describe, expect, it } from "bun:test";
import { getCurrentEventFromRedis } from "../../src/infra/event";
import type { GraphQLContext } from "../../src/graphql/context";

const contextFor = (raw: string | null): GraphQLContext =>
	({
		redis: { get: async () => raw },
		logger: { warn: () => undefined },
	}) as unknown as GraphQLContext;

describe("event:current parsing", () => {
	it("accepts a positive integer id and whole numeric string", async () => {
		await expect(
			getCurrentEventFromRedis(contextFor(JSON.stringify({ id: "12" })))
		).resolves.toMatchObject({ id: 12 });
	});

	it("rejects coerced non-integer ids", async () => {
		for (const id of [true, [], 1.5, "3.5"]) {
			await expect(
				getCurrentEventFromRedis(contextFor(JSON.stringify({ id })))
			).resolves.toBeNull();
		}
	});
});
