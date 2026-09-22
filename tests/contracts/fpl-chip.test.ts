import { describe, expect, test } from "bun:test";
import {
	CANONICAL_FPL_CHIPS,
	isCanonicalFplChip,
	normalizeFplChip,
} from "../../src/contracts/fpl-chip";

describe("shared FPL chip normalization", () => {
	test("exposes one canonical runtime value set", () => {
		expect(CANONICAL_FPL_CHIPS).toEqual([
			"NONE",
			"BENCH_BOOST",
			"TRIPLE_CAPTAIN",
			"FREE_HIT",
			"WILDCARD",
			"MANAGER",
		]);
		expect(new Set(CANONICAL_FPL_CHIPS).size).toBe(CANONICAL_FPL_CHIPS.length);
		expect(CANONICAL_FPL_CHIPS.every(isCanonicalFplChip)).toBe(true);
		expect(isCanonicalFplChip("AM")).toBe(false);
	});

	test("maps known aliases to one canonical value", () => {
		expect(normalizeFplChip("bench boost")).toBe("BENCH_BOOST");
		expect(normalizeFplChip("3xc")).toBe("TRIPLE_CAPTAIN");
		expect(normalizeFplChip("free_hit")).toBe("FREE_HIT");
		expect(normalizeFplChip("wc")).toBe("WILDCARD");
		expect(normalizeFplChip("am")).toBe("MANAGER");
	});

	test("keeps explicit no-chip and caller fallback semantics", () => {
		expect(normalizeFplChip("NA")).toBe("NONE");
		expect(normalizeFplChip("unknown", null)).toBeNull();
		expect(normalizeFplChip(null, null)).toBeNull();
		expect(normalizeFplChip("NA", null, { emptyAsNone: false })).toBeNull();
	});
});
