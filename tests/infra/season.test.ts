import { describe, expect, it } from "bun:test";
import { GraphQLError } from "graphql";
import { getCurrentSeason } from "../../src/infra/season";

const makeContext = (seasonValue: string | null): Parameters<typeof getCurrentSeason>[0] => ({
	redis: {
		get: async () => seasonValue,
	} as never,
	supabase: {} as never,
	logger: {} as never,
});

describe("getCurrentSeason", () => {
	it("shares one in-flight Redis read across concurrent callers", async () => {
		let reads = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const context = {
			redis: {
				get: async () => {
					reads += 1;
					await gate;
					return "2526";
				},
			} as never,
			supabase: {} as never,
			logger: {} as never,
		};
		const first = getCurrentSeason(context);
		const second = getCurrentSeason(context);
		release();
		await expect(Promise.all([first, second])).resolves.toEqual(["2526", "2526"]);
		expect(reads).toBe(1);
	});

	it("returns the season value from Redis when valid", async () => {
		const context = makeContext("2526");
		const result = await getCurrentSeason(context);
		expect(result).toBe("2526");
	});

	it("rejects when Redis returns null", async () => {
		const context = makeContext(null);
		await expect(getCurrentSeason(context)).rejects.toBeInstanceOf(GraphQLError);
	});

	it("rejects when Redis returns empty string", async () => {
		const context = makeContext("");
		await expect(getCurrentSeason(context)).rejects.toBeInstanceOf(GraphQLError);
	});

	it("rejects when Redis returns a non-numeric value", async () => {
		const context = makeContext("abc");
		await expect(getCurrentSeason(context)).rejects.toBeInstanceOf(GraphQLError);
	});

	it("rejects when Redis returns a value with the wrong length", async () => {
		const context = makeContext("25261");
		await expect(getCurrentSeason(context)).rejects.toBeInstanceOf(GraphQLError);
	});

	it("rejects when Redis is unavailable", async () => {
		const context = {
			redis: { get: async () => Promise.reject(new Error("offline")) } as never,
			supabase: {} as never,
			logger: { warn: () => undefined } as never,
		};
		await expect(getCurrentSeason(context)).rejects.toBeInstanceOf(GraphQLError);
	});

	it("returns a 4-digit season when Redis has a valid one", async () => {
		const context = makeContext("2527");
		const result = await getCurrentSeason(context);
		expect(result).toBe("2527");
	});
});
