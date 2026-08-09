import { describe, expect, it } from "bun:test";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { graphql } from "graphql";
import { eventsRepository } from "../../../src/domains/events/repository";
import { eventsResolvers } from "../../../src/domains/events/resolvers";
import { eventsTypeDefs } from "../../../src/domains/events/schema";
import { baseResolvers, baseTypeDefs } from "../../../src/graphql/base-schema";
import type { GraphQLContext } from "../../../src/graphql/context";

type DbMetadataRow = {
	id: number;
	deadline_time: string | null;
	deadline_time_epoch: number | null;
	is_current: boolean;
	is_next: boolean;
};

type ContextOptions = {
	currentId?: number | null;
	events?: Record<string, unknown>[];
	databaseRows?: DbMetadataRow[];
	databaseError?: unknown;
};

const event = (id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id,
	name: `Gameweek ${id}`,
	deadlineTime: `2030-08-${String(id).padStart(2, "0")}T17:30:00Z`,
	deadlineTimeEpoch: 1_912_000_000 + id,
	finished: false,
	dataChecked: false,
	isPrevious: false,
	isCurrent: false,
	isNext: false,
	...overrides,
});

const buildContext = (options: ContextOptions = {}): GraphQLContext => {
	const events = options.events ?? [];
	return {
		database: {
			query: async () => {
				throw new Error("Unexpected database query");
			},
		} as never,
		currentSeason: { seasonId: 2026, seasonCode: "2627" },
		redis: {
			get: async (key: string) => {
				if (key === "Season:active") return "2627";
				if (key === "event:current" && options.currentId) {
					return JSON.stringify(event(options.currentId, { isCurrent: true }));
				}
				return null;
			},
			hvals: async (key: string) =>
				key === "Event:2627" ? events.map((row) => JSON.stringify(row)) : [],
			hget: async (key: string, field: string) => {
				if (key !== "Event:2627") return null;
				const row = events.find((candidate) => String(candidate.id) === field);
				return row ? JSON.stringify(row) : null;
			},
		} as never,
		data: {
			read: () => ({
				select: () => ({
					order: async () => ({
						data: options.databaseRows ?? [],
						error: options.databaseError ?? null,
					}),
				}),
			}),
		} as never,
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		} as never,
		user: undefined,
	} as GraphQLContext;
};

describe("eventsRepository.getCurrentEventInfo", () => {
	it("returns pre-season GW1 as next without inventing a current event", async () => {
		const context = buildContext({
			events: [
				event(1, {
					isNext: true,
					deadlineTime: "2030-08-01 17:30:00+00",
				}),
			],
		});

		await expect(eventsRepository.getCurrentEventInfo(context)).resolves.toEqual({
			season: "2627",
			currentEvent: null,
			nextEvent: 1,
			nextUtcDeadline: "2030-08-01T17:30:00.000Z",
		});
	});

	it("returns the active event and the following event", async () => {
		const context = buildContext({
			currentId: 3,
			events: [event(3, { isCurrent: true }), event(4, { deadlineTime: "2030-08-04 17:30:00+00" })],
		});

		await expect(eventsRepository.getCurrentEventInfo(context)).resolves.toEqual({
			season: "2627",
			currentEvent: 3,
			nextEvent: 4,
			nextUtcDeadline: "2030-08-04T17:30:00.000Z",
		});
	});

	it("returns no next event at GW38", async () => {
		const context = buildContext({
			currentId: 38,
			events: [event(38, { isCurrent: true })],
		});

		await expect(eventsRepository.getCurrentEventInfo(context)).resolves.toEqual({
			season: "2627",
			currentEvent: 38,
			nextEvent: null,
			nextUtcDeadline: null,
		});
	});

	it("uses database metadata when Redis has no event rows", async () => {
		const context = buildContext({
			databaseRows: [
				{
					id: 1,
					deadline_time: "2030-08-01 17:30:00+00",
					deadline_time_epoch: 1_912_000_001,
					is_current: false,
					is_next: true,
				},
			],
		});

		await expect(eventsRepository.getCurrentEventInfo(context)).resolves.toEqual({
			season: "2627",
			currentEvent: null,
			nextEvent: 1,
			nextUtcDeadline: "2030-08-01T17:30:00.000Z",
		});
	});

	it("keeps dependency failures explicit", async () => {
		const context = buildContext({ databaseError: new Error("database unavailable") });

		await expect(eventsRepository.getCurrentEventInfo(context)).rejects.toMatchObject({
			message: "Current event metadata is unavailable",
			extensions: { code: "CACHE_METADATA_UNAVAILABLE" },
		});
	});
});

describe("event deadline serialization", () => {
	it("serializes cached PostgreSQL deadlines through the executable schema", async () => {
		const schema = makeExecutableSchema({
			typeDefs: [baseTypeDefs, eventsTypeDefs],
			resolvers: [baseResolvers, eventsResolvers],
		});
		const context = buildContext({
			events: [
				event(1, {
					isNext: true,
					deadlineTime: "2030-08-01 17:30:00+00",
				}),
			],
		});

		const result = await graphql({
			schema,
			source: `
				query ReadNextEvent {
					events(filter: { isNext: true }) { deadlineTime }
					currentEventInfo { season currentEvent nextEvent nextUtcDeadline }
				}
			`,
			contextValue: context,
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
