import { describe, expect, it } from "bun:test";
import { buildTeamMap } from "../../src/infra/team-map";
import type { GraphQLContext } from "../../src/graphql/context";

describe("team map preseason compatibility", () => {
	it("preserves a nullable team strength from Redis", async () => {
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			redis: {
				get: async () => "2627",
				hgetall: async () => ({
					"1": JSON.stringify({
						id: 1,
						code: 3,
						name: "Arsenal",
						shortName: "ARS",
						strength: null,
						position: 0,
					}),
				}),
			} as never,
			logger: {
				warn: () => undefined,
				error: () => undefined,
			} as never,
		} as unknown as GraphQLContext;

		const teams = await buildTeamMap(context);

		expect(teams.get(1)?.strength).toBeNull();
		expect(teams.get(1)?.position).toBe(0);
	});
});
