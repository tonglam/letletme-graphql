import { describe, expect, it } from "bun:test";
import { getActiveSeasonDateWindow } from "../../src/infra/season-window";

const contextFor = (row: unknown, error: { message: string } | null = null) => {
	const result = Promise.resolve({ data: row === undefined ? [] : [row], error });
	const builder = result as typeof result & Record<string, (...args: unknown[]) => typeof builder>;
	for (const method of ["select", "eq", "limit"]) {
		builder[method] = () => builder;
	}
	return {
		supabase: { from: () => builder },
		logger: { warn: () => undefined },
	} as never;
};

describe("getActiveSeasonDateWindow", () => {
	it("uses the GW1 deadline with the market pipeline's sixty-day lead", async () => {
		await expect(
			getActiveSeasonDateWindow(contextFor({ deadline_time: "2026-08-15T12:00:00.000Z" }), "2627")
		).resolves.toEqual({ fromDate: "2026-06-16", untilDate: "2027-08-15" });
	});

	it("keeps a bounded season fallback when GW1 metadata is unavailable", async () => {
		await expect(getActiveSeasonDateWindow(contextFor(undefined), "2627")).resolves.toEqual({
			fromDate: "2026-06-01",
			untilDate: "2027-09-01",
		});
	});
});
