import { describe, expect, it } from "bun:test";
import { normalizePlayerPickerSearch } from "../../../src/domains/players/resolvers";

describe("normalizePlayerPickerSearch", () => {
	it("trims a bounded query and treats blank input as browse mode", () => {
		expect(normalizePlayerPickerSearch("  Haal  ")).toBe("Haal");
		expect(normalizePlayerPickerSearch("   ")).toBeNull();
		expect(normalizePlayerPickerSearch(undefined)).toBeNull();
	});

	it("rejects queries longer than fifty characters", () => {
		expect(() => normalizePlayerPickerSearch("x".repeat(51))).toThrow("50 characters or fewer");
	});
});
