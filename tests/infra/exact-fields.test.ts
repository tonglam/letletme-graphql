import { describe, expect, it } from "bun:test";
import { hasExactFields } from "../../src/infra/exact-fields";

describe("exact object field helper", () => {
	it("rejects missing, extra, and inherited fields", () => {
		expect(hasExactFields({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
		expect(hasExactFields({ a: 1 }, ["a", "b"])).toBe(false);
		expect(hasExactFields({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
		const inherited = Object.create({ b: 2 }) as { a: number };
		inherited.a = 1;
		expect(hasExactFields(inherited, ["a", "b"])).toBe(false);
	});
});
