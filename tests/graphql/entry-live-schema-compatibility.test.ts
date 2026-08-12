import { afterEach, describe, expect, it } from "bun:test";
import { graphql } from "graphql";
import type { GraphQLContext } from "../../src/graphql/context";
import { entryLiveRepository } from "../../src/domains/entry-live/repository";
import { schema } from "../../src/graphql/schema";

const originalGetPick = entryLiveRepository.getEntryEventPick;

afterEach(() => {
	entryLiveRepository.getEntryEventPick = originalGetPick;
});

describe("calcLivePointsByEntry additive schema compatibility", () => {
	it("keeps the legacy selection executable and exposes explicit no-picks availability", async () => {
		entryLiveRepository.getEntryEventPick = async () => null;
		const context = {} as GraphQLContext;

		const legacy = await graphql({
			schema,
			source: `
				query LegacyCalc($eventId: Int!, $entryId: Int!) {
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
		expect(legacy.errors).toBeUndefined();
		expect(legacy.data?.calcLivePointsByEntry).toEqual({
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
