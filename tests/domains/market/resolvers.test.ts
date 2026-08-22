import { describe, expect, it } from "bun:test";
import {
	normalizeMarketAvailabilityLimit,
	normalizeMarketAvailabilityOffset,
	normalizeMarketPulseDays,
} from "../../../src/domains/market/resolvers";

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

describe("normalizeMarketAvailabilityPage", () => {
	it("uses bounded defaults", () => {
		expect(normalizeMarketAvailabilityLimit(undefined)).toBe(20);
		expect(normalizeMarketAvailabilityOffset(undefined)).toBe(0);
		expect(normalizeMarketAvailabilityLimit(1)).toBe(1);
		expect(normalizeMarketAvailabilityLimit(20)).toBe(20);
		expect(normalizeMarketAvailabilityOffset(5000)).toBe(5000);
	});

	it.each([0, 21, 1.5, Number.NaN])("rejects invalid page limits %p", (limit) => {
		expect(() => normalizeMarketAvailabilityLimit(limit)).toThrow("between 1 and 20");
	});

	it.each([-1, 1.5, 5001, Number.NaN])("rejects invalid offsets %p", (offset) => {
		expect(() => normalizeMarketAvailabilityOffset(offset)).toThrow("between 0 and 5000");
	});
});
