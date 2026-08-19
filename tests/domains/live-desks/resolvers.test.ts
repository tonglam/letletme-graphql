import { describe, expect, it } from "bun:test";

describe("live desks tournament selection index", () => {
	it("uses the reporting read model instead of request-time pick scans", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		expect(source).toContain("getTournamentSelectionIndexRows");
		expect(source).not.toContain("getEntryEventPicksByIds");
		expect(source).not.toContain("getTournamentEntryIds(context, args.tournamentId)");
	});
});
