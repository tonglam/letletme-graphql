import { describe, expect, it } from "bun:test";
import { buildTeamMap } from "../../src/infra/team-map";
import type { GraphQLContext } from "../../src/graphql/context";

describe("team map preseason compatibility", () => {
	it("preserves a nullable team strength from Redis", async () => {
		const context = {
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
						points: 0,
						played: 0,
						win: 0,
						draw: 0,
						loss: 0,
						strengthOverallHome: 0,
						strengthOverallAway: 0,
						strengthAttackHome: 0,
						strengthAttackAway: 0,
						strengthDefenceHome: 0,
						strengthDefenceAway: 0,
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

	it("falls back when a required cached numeric field is malformed", async () => {
		const context = {
			redis: {
				get: async () => "2627",
				hgetall: async () => ({
					"1": JSON.stringify({
						id: 1,
						code: "unknown",
						name: "Arsenal",
						shortName: "ARS",
						position: 1,
						points: 0,
						played: 0,
						win: 0,
						draw: 0,
						loss: 0,
						strengthOverallHome: 0,
						strengthOverallAway: 0,
						strengthAttackHome: 0,
						strengthAttackAway: 0,
						strengthDefenceHome: 0,
						strengthDefenceAway: 0,
					}),
				}),
			} as never,
			supabase: {
				from: () => ({
					select: () => ({
						order: async () => ({
							data: [
								{
									id: 1,
									code: 3,
									name: "Arsenal",
									short_name: "ARS",
									position: 1,
									points: 0,
									played: 0,
									win: 0,
									draw: 0,
									loss: 0,
									strength_overall_home: 0,
									strength_overall_away: 0,
									strength_attack_home: 0,
									strength_attack_away: 0,
									strength_defence_home: 0,
									strength_defence_away: 0,
								},
							],
							error: null,
						}),
					}),
				}),
			} as never,
			logger: { warn: () => undefined, error: () => undefined } as never,
		} as unknown as GraphQLContext;

		const teams = await buildTeamMap(context);

		expect(teams.get(1)?.code).toBe(3);
	});
});
