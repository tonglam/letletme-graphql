import { describe, expect, it } from "bun:test";
import { eventsRepository } from "../../../src/domains/events/repository";
import type { GraphQLContext } from "../../../src/graphql/context";

const buildRedisContext = (): GraphQLContext =>
	({
		redis: {
			get: async (key: string) => {
				if (key === "Season:active") return "2627";
				if (key === "event:current") {
					return JSON.stringify({ id: 3, name: "Gameweek 3", isCurrent: true });
				}
				return null;
			},
			hlen: async (key: string) => (key === "Event:2627" ? 38 : 0),
			hget: async (key: string, field: string) =>
				key === "Event:2627" && field === "4"
					? JSON.stringify({ deadlineTime: "2026-09-01T17:30:00.000Z" })
					: null,
		} as never,
		supabase: {
			from: () => {
				throw new Error("database fallback should not be used");
			},
		} as never,
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		} as never,
		user: undefined,
	}) as GraphQLContext;

describe("eventsRepository.getCurrentEventInfo", () => {
	it("returns the authoritative active season with the current event", async () => {
		await expect(eventsRepository.getCurrentEventInfo(buildRedisContext())).resolves.toEqual({
			season: "2627",
			currentEvent: 3,
			nextUtcDeadline: "2026-09-01T17:30:00.000Z",
		});
	});
});
