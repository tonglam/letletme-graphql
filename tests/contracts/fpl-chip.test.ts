import { describe, expect, test } from "bun:test";
import { normalizeFplChip } from "../../src/contracts/fpl-chip";

describe("shared FPL chip normalization", () => {
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
