import { describe, expect, it } from "bun:test";

describe("live desks tournament selection index", () => {
	it("uses the reporting read model instead of request-time pick scans", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const selectionIndex = source.slice(
			source.indexOf("tournamentSelectionIndex:"),
			source.indexOf("tournamentEntrySquads:")
		);
		expect(source).toContain("getTournamentSelectionIndexRows");
		expect(selectionIndex).not.toContain("getEntryEventPicksByIds");
		expect(selectionIndex).not.toContain("getTournamentEntryIds(context, args.tournamentId)");
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

	it("revalidates the selected membership before reading a cached competition board", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const desk = source.slice(
			source.indexOf("entryLiveCompetitionsDesk: async"),
			source.indexOf("liveTournamentSelectionStats: async")
		);
		expect(desk.indexOf("await assertMember(context, selected, args.entryId)")).toBeGreaterThan(0);
		expect(desk.indexOf("await assertMember(context, selected, args.entryId)")).toBeLessThan(
			desk.indexOf("readCompetitionBoardCache")
		);
	});
});
