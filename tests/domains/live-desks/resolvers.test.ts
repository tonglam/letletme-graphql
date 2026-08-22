import { describe, expect, it } from "bun:test";

describe("live desks tournament selection index", () => {
	it("uses the reporting read model instead of request-time pick scans", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		expect(source).toContain("getTournamentSelectionIndexRows");
		expect(source).not.toContain("getEntryEventPicksByIds");
		expect(source).not.toContain("getTournamentEntryIds(context, args.tournamentId)");
	});

	it("routes tournament anchoring through the shared live window", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		expect(source).toContain("const [tournaments, liveWindow] = await Promise.all");
		expect(source).not.toContain("const [tournaments, eventCore, fixtureCore]");
	});

	it("keeps the shared live window independent from player identity data", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const windowReader = source.slice(
			source.indexOf("const readLiveWindow"),
			source.indexOf("const resolveSnapshot")
		);
		expect(windowReader).not.toContain("getCoreLiveIdentitySnapshot");
		expect(source).toContain(
			"matches: matchRows(snapshot.eventId, snapshot.fixtures, fixtureCore)"
		);
	});
});
