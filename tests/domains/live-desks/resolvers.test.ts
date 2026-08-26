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

	it("logs bounded metadata when a fixture-player snapshot is unavailable", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const snapshotResolver = source.slice(
			source.indexOf("const resolveSnapshot"),
			source.indexOf("const teamName")
		);
		expect(snapshotResolver).toContain("context.logger.warn");
		expect(snapshotResolver).toContain("claimLivePublicationFailureLog");
		expect(snapshotResolver).toContain("livePublicationFailureDetails(");
		expect(snapshotResolver).not.toContain("ref?.revision ?? null");
		expect(snapshotResolver).not.toContain("cause: error");
		expect(snapshotResolver).not.toContain("err: error");
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

	it("uses the verified principal entry for the management fallback", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const helper = source.slice(
			source.indexOf("const assertMemberOrManager"),
			source.indexOf("const managerBoardMeta")
		);
		expect(helper).toContain("verifiedManagerEntryId");
		expect(helper).toContain("context.principal.fplEntryId");
		expect(helper).toContain("getManagedTournament");
		expect(helper).not.toMatch(/getManagedTournament\(context, tournamentId, entryId\)/);
	});
});
