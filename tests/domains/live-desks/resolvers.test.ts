import { describe, expect, it } from "bun:test";

describe("live desks tournament selection index", () => {
	it("uses the reporting read model instead of request-time pick scans", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const selectionIndex = source.slice(
			source.indexOf("tournamentSelectionIndex: async"),
			source.indexOf("tournamentEntrySquads: async")
		);
		expect(selectionIndex).toContain("getTournamentSelectionIndexRows");
		expect(selectionIndex).toContain("getEventScopedPlayerAndTeamMaps");
		expect(selectionIndex).toContain("args.ref.season");
		expect(selectionIndex).toContain("getCoreDataSnapshot");
		expect(selectionIndex).toContain("player?.web_name");
		expect(selectionIndex).toContain("Player ${row.playerId}");
		expect(selectionIndex).not.toContain(
			"Tournament selection index references an unknown core player"
		);
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

	it("loads squads only for the requested comparison pair and verifies tournament membership", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const comparison = source.slice(
			source.indexOf("tournamentEntrySquads: async"),
			source.indexOf("tournamentLiveParticipants: async")
		);
		expect(comparison).toContain("new Set(args.comparedEntryIds)");
		expect(comparison).toContain("selectTournamentComparisonEntryIds");
		expect(comparison).toContain("tournamentEntryIds.has(args.entryId)");
		expect(comparison).toContain("ids.length > 2");
		expect(comparison).toContain("getTournamentEntryIdsUncached");
		expect(comparison).toContain("normalizeTournamentRosterEntryIds");
		expect(comparison).toContain("usesPlatformAdminTournamentBypass");
		expect(comparison).not.toContain("getTournamentEntryIds(context");
		expect(comparison).not.toContain("slice(0, 2)");
	});

	it("bounds a large lightweight board before manager and batch reads", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const board = source.slice(
			source.indexOf("entryLiveCompetitionBoard: async"),
			source.indexOf("entryLiveCompetitionsDesk: async")
		);
		expect(board).toContain("selectTournamentDeskEntryWindow");
		expect(board).toContain("getTournamentEntryIdsUncached");
		expect(board).toContain("normalizeTournamentRosterEntryIds");
		expect(board).toContain("usesPlatformAdminTournamentBypass");
		expect(board).toContain("getEventScopedPlayerAndTeamMaps");
		expect(board).toContain("requireExactEventIdentity:");
		expect(board.indexOf("selectTournamentDeskEntryWindow")).toBeLessThan(
			board.indexOf("loadManagerScores")
		);
		expect(board).toContain("totalEntries: allEntryIds.length");
		expect(board).toContain("unavailableEntryIds: deferredEntryIds");
	});
});
