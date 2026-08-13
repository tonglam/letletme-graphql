import { describe, expect, it } from "bun:test";
import { parsePositiveIntegerEnv } from "../../src/infra/env-value";

describe("positive integer environment values", () => {
	it("uses defaults and accepts explicit positive integers", () => {
		expect(parsePositiveIntegerEnv(undefined, "LIMIT", 120)).toBe(120);
		expect(parsePositiveIntegerEnv("", "LIMIT", 120)).toBe(120);
		expect(parsePositiveIntegerEnv("300", "LIMIT", 120)).toBe(300);
	});

	it.each(["0", "-1", "1.5", "not-a-number"])("rejects %s", (value) => {
		expect(() => parsePositiveIntegerEnv(value, "LIMIT", 120)).toThrow(
			"LIMIT must be a positive integer"
		);
	});
});
