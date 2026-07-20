import { describe, expect, it } from "bun:test";
import { normalizePlayerValueHistoryArgs } from "../../../src/domains/player-values/resolvers";

describe("normalizePlayerValueHistoryArgs", () => {
	it("passes through playerId and dates", () => {
		const fromDate = new Date("2026-04-01T00:00:00.000Z");
		const toDate = new Date("2026-04-10T00:00:00.000Z");

		const result = normalizePlayerValueHistoryArgs({
			playerId: 7,
			fromDate,
			toDate,
		});

		expect(result.playerId).toBe(7);
		expect(result.fromDate).toBe(fromDate);
		expect(result.toDate).toBe(toDate);
	});

	it("throws when fromDate is after toDate", () => {
		const fromDate = new Date("2026-04-10T00:00:00.000Z");
		const toDate = new Date("2026-04-01T00:00:00.000Z");

		expect(() =>
			normalizePlayerValueHistoryArgs({
				playerId: 7,
				fromDate,
				toDate,
			})
		).toThrow("Invalid date range");
	});
});
