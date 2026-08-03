import { describe, expect, it } from "bun:test";
import { normalizeTopPerformersLimit } from "../../../src/domains/live/resolvers";

describe("normalizeTopPerformersLimit", () => {
	it("keeps the schema default and non-negative limits", () => {
		expect(normalizeTopPerformersLimit()).toBe(10);
		expect(normalizeTopPerformersLimit(null)).toBe(10);
		expect(normalizeTopPerformersLimit(3)).toBe(3);
	});

	it("defensively prevents negative slicing", () => {
		expect(normalizeTopPerformersLimit(-1)).toBe(0);
	});
});
