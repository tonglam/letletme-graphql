import { describe, expect, it } from "bun:test";
import { parseBoundedPositiveIntegerEnv, parsePositiveIntegerEnv } from "../../src/infra/env-value";

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

describe("bounded environment values", () => {
	it("accepts the default and rejects values outside the operational range", () => {
		expect(parseBoundedPositiveIntegerEnv(undefined, "TIMEOUT", 12000, 1000, 60000)).toBe(12000);
		expect(parseBoundedPositiveIntegerEnv("1000", "TIMEOUT", 12000, 1000, 60000)).toBe(1000);
		expect(() => parseBoundedPositiveIntegerEnv("999", "TIMEOUT", 12000, 1000, 60000)).toThrow(
			"TIMEOUT must be between 1000 and 60000"
		);
	});
});
