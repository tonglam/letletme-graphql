import { afterEach, describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import type { GraphQLContext } from "../../src/graphql/context";
import { entryLiveBatchService } from "../../src/domains/entry-live/batch-service";
import type { LiveCalcData } from "../../src/domains/entry-live/calc-service";
import { schema } from "../../src/graphql/schema";

const originalBatchCalc = entryLiveBatchService.calcLivePointsForEntries;

afterEach(() => {
	entryLiveBatchService.calcLivePointsForEntries = originalBatchCalc;
});

describe("calcLivePointsByEntry availability contract", () => {
	it("keeps the base selection executable and exposes explicit no-picks availability", async () => {
		const noPicks = {
			availability: "NO_PICKS",
			event: 7,
			entry: 123,
			livePoints: 0,
			pickList: [],
		} as unknown as LiveCalcData;
		entryLiveBatchService.calcLivePointsForEntries = async () => ({
			results: new Map([[123, noPicks]]),
			errors: [],
			meta: { eventId: 7, totalEntries: 1, succeededCount: 1, failedCount: 0 },
		});
		const context = {
			logger: { warn: () => undefined },
			dataRevision: "test-revision",
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
		} as unknown as GraphQLContext;

		const base = await graphql({
			schema,
			source: `
				query BaseCalc($eventId: Int!, $entryId: Int!) {
					calcLivePointsByEntry(eventId: $eventId, entryId: $entryId) {
						entry
						event
						livePoints
						pickList { element }
					}
				}
			`,
			variableValues: { eventId: 7, entryId: 123 },
			contextValue: context,
		});
		expect(base.errors).toBeUndefined();
		expect(base.data?.calcLivePointsByEntry).toEqual({
			entry: 123,
			event: 7,
			livePoints: 0,
			pickList: [],
		});

		const extended = await graphql({
			schema,
			source: `
				query ExtendedCalc($eventId: Int!, $entryId: Int!) {
					calcLivePointsByEntry(eventId: $eventId, entryId: $entryId) {
						availability
						snapshot { revision }
					}
				}
			`,
			variableValues: { eventId: 7, entryId: 123 },
			contextValue: context,
		});
		expect(extended.errors).toBeUndefined();
		expect(extended.data?.calcLivePointsByEntry).toEqual({
			availability: "NO_PICKS",
			snapshot: null,
		});
	});
});
