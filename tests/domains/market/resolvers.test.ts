import { describe, expect, it } from "bun:test";
import { normalizeMarketPulseDays } from "../../../src/domains/market/resolvers";

describe("normalizeMarketPulseDays", () => {
	it("uses seven days by default and accepts the public bounds", () => {
		expect(normalizeMarketPulseDays(undefined)).toBe(7);
		expect(normalizeMarketPulseDays(1)).toBe(1);
		expect(normalizeMarketPulseDays(30)).toBe(30);
	});

	it.each([0, 31, 1.5, Number.NaN])("rejects invalid days %p", (days) => {
		expect(() => normalizeMarketPulseDays(days)).toThrow("between 1 and 30");
	});
});
