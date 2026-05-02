import { describe, expect, it } from "bun:test";
import { getCurrentSeason } from "../../src/infra/season";

const makeContext = (
	seasonValue: string | null,
): Parameters<typeof getCurrentSeason>[0] => ({
	redis: {
		get: async () => seasonValue,
	} as never,
	supabase: {} as never,
	logger: {} as never,
});

describe("getCurrentSeason", () => {
	it("returns the season value from Redis when valid", async () => {
		const context = makeContext("2526");
		const result = await getCurrentSeason(context);
		expect(result).toBe("2526");
	});

	it("returns default season when Redis returns null", async () => {
		const context = makeContext(null);
		const result = await getCurrentSeason(context);
		expect(result).toBe("2526");
	});

	it("returns default season when Redis returns empty string", async () => {
		const context = makeContext("");
		const result = await getCurrentSeason(context);
		expect(result).toBe("2526");
	});

	it("returns default season when Redis returns non-numeric value", async () => {
		const context = makeContext("abc");
		const result = await getCurrentSeason(context);
		expect(result).toBe("2526");
	});

	it("returns default season when Redis returns value with wrong length", async () => {
		const context = makeContext("25261");
		const result = await getCurrentSeason(context);
		expect(result).toBe("2526");
	});

	it("returns a 4-digit season when Redis has a valid one", async () => {
		const context = makeContext("2527");
		const result = await getCurrentSeason(context);
		expect(result).toBe("2527");
	});
});
