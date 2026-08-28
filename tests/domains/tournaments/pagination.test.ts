import { describe, expect, it } from "bun:test";
import { normalizeTournamentEventResultsPagination } from "../../../src/domains/tournaments/repository";

describe("tournament event result pagination", () => {
	it("keeps the complete-result shape when pagination is omitted", () => {
		expect(normalizeTournamentEventResultsPagination(null, null)).toEqual({
			limit: null,
			offset: null,
		});
	});

	it("accepts the bounded page and defaults an omitted offset to zero", () => {
		expect(normalizeTournamentEventResultsPagination(500, null)).toEqual({ limit: 500, offset: 0 });
		expect(normalizeTournamentEventResultsPagination(1, 4999)).toEqual({ limit: 1, offset: 4999 });
	});

	it("rejects invalid bounds and an offset without a limit", () => {
		for (const [limit, offset] of [
			[0, null],
			[501, null],
			[1, -1],
			[1, 5000],
			[null, 0],
		] as const) {
			expect(() => normalizeTournamentEventResultsPagination(limit, offset)).toThrow();
		}
	});
});
