import { describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import { emptyMarketPulse, type MarketPulse } from "../../../src/domains/market/repository";
import { schema } from "../../../src/graphql/schema";
import { gqlCacheKey } from "../../../src/infra/cache-key";

const query = /* GraphQL */ `
	query MarketPulse {
		marketPulse {
			coverage {
				firstDate
				latestDate
				capturedAt
			}
			mostSelected {
				playerId
				webName
				position
				selectedByPercent
			}
			availabilityHighlights {
				status
				player {
					playerId
				}
			}
		}
	}
`;

describe("marketPulse GraphQL contract", () => {
	it("serializes calendar dates, capture timestamps, positions, and ownership", async () => {
		const pulse: MarketPulse = {
			...emptyMarketPulse(7),
			coverage: {
				requestedDays: 7,
				observedDays: 1,
				firstDate: "2026-08-03",
				latestDate: "2026-08-03",
				missingDates: [],
				capturedAt: "2026-08-03T01:40:00.000Z",
				complete: false,
				stale: false,
			},
			mostSelected: [
				{
					playerId: 1,
					playerCode: 101,
					webName: "Popular Player",
					teamId: 1,
					teamName: "Arsenal",
					teamShortName: "ARS",
					position: "MIDFIELDER",
					price: 75,
					selectedByPercent: 42.5,
				},
			],
		};
		const strings = new Map<string, string>();
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-test",
			redis: {
				get: async (key: string) => strings.get(key) ?? null,
				del: async () => 1,
			},
			logger: { warn: () => undefined, error: () => undefined },
			data: {},
		} as never;
		strings.set(gqlCacheKey(context, "market-pulse:v4:7"), JSON.stringify(pulse));

		const result = await graphql({ schema, source: query, contextValue: context });

		expect(result.errors).toBeUndefined();
		const wireData = JSON.parse(JSON.stringify(result.data)) as unknown;
		expect(wireData).toEqual({
			marketPulse: {
				coverage: {
					firstDate: "2026-08-03",
					latestDate: "2026-08-03",
					capturedAt: "2026-08-03T01:40:00.000Z",
				},
				mostSelected: [
					{
						playerId: 1,
						webName: "Popular Player",
						position: "MIDFIELDER",
						selectedByPercent: 42.5,
					},
				],
				availabilityHighlights: [],
			},
		});
	});
});
