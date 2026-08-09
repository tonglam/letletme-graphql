import { describe, expect, it } from "bun:test";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { graphql } from "graphql";
import { eventsRepository } from "../../../src/domains/events/repository";
import { eventsResolvers } from "../../../src/domains/events/resolvers";
import { eventsTypeDefs } from "../../../src/domains/events/schema";
import { baseResolvers, baseTypeDefs } from "../../../src/graphql/base-schema";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const contextForEvent = (currentEventId: number | null) => {
	const core = buildTestCoreData(currentEventId);
	const events = core.events.map((event, index) => ({
		...event,
		deadlineTime: new Date(Date.UTC(2030, 7, 1 + index * 7, 17, 30)).toISOString(),
	}));
	const publication = buildCorePublication("2627", 7, { ...core, events, currentEventId });
	return buildSnapshotContext(new TestRedis(publication));
};

describe("eventsRepository over the v3 core publication", () => {
	it("returns pre-season GW1 as next without inventing a current event", async () => {
		await expect(eventsRepository.getCurrentEventInfo(contextForEvent(null))).resolves.toEqual({
			season: "2627",
			currentEvent: null,
			nextEvent: 1,
			nextUtcDeadline: "2030-08-01T17:30:00.000Z",
		});
	});

	it("does not invent event state from the GraphQL host clock", async () => {
		const core = buildTestCoreData(null);
		const events = core.events.map((event) => ({
			...event,
			deadlineTime: "2020-08-01T17:30:00.000Z",
			deadlineTimeEpoch: 1_596_302_200,
			isCurrent: false,
			isNext: false,
		}));
		const publication = buildCorePublication("2627", 7, { ...core, events });
		const context = buildSnapshotContext(new TestRedis(publication));

		await expect(eventsRepository.getCurrentEventInfo(context)).resolves.toBeNull();
	});

	it("returns the active event and following event from one pinned revision", async () => {
		const context = contextForEvent(3);
		await expect(eventsRepository.getCurrentEventInfo(context)).resolves.toEqual({
			season: "2627",
			currentEvent: 3,
			nextEvent: 4,
			nextUtcDeadline: "2030-08-22T17:30:00.000Z",
		});
		expect((await eventsRepository.getEventById(context, 3))?.isCurrent).toBe(true);
	});

	it("returns no next event at GW38", async () => {
		await expect(eventsRepository.getCurrentEventInfo(contextForEvent(38))).resolves.toEqual({
			season: "2627",
			currentEvent: 38,
			nextEvent: null,
			nextUtcDeadline: null,
		});
	});

	it("serializes publication deadlines through the executable schema", async () => {
		const schema = makeExecutableSchema({
			typeDefs: [baseTypeDefs, eventsTypeDefs],
			resolvers: [baseResolvers, eventsResolvers],
		});
		const result = await graphql({
			schema,
			source: `
				query ReadNextEvent {
					events(filter: { isNext: true }) { deadlineTime }
					currentEventInfo { season currentEvent nextEvent nextUtcDeadline }
				}
			`,
			contextValue: contextForEvent(null),
		});

		expect(result.errors).toBeUndefined();
		expect(JSON.parse(JSON.stringify(result.data))).toEqual({
			events: [{ deadlineTime: "2030-08-01T17:30:00.000Z" }],
			currentEventInfo: {
				season: "2627",
				currentEvent: null,
				nextEvent: 1,
				nextUtcDeadline: "2030-08-01T17:30:00.000Z",
			},
		});
	});
});
