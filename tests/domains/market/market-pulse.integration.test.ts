import { describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import { emptyMarketPulse, type MarketPulse } from "../../../src/domains/market/repository";
import { schema } from "../../../src/graphql/schema";

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
			...emptyMarketPulse(14),
			coverage: {
				requestedDays: 14,
				observedDays: 1,
				firstDate: "2026-08-03",
				latestDate: "2026-08-03",
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
		const context = {
			redis: {
				get: async (key: string) => {
					if (key === "Season:active") return "2627";
					if (key === "gql:v2:2627:market-pulse:v2:14") return JSON.stringify(pulse);
					return null;
				},
				del: async () => 1,
			},
			logger: { warn: () => undefined, error: () => undefined },
			supabase: {},
		} as never;

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
