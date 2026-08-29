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

	it("uses event-qualified membership for every live tournament board", async () => {
		const resolverSource = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const pagedBoard = resolverSource.slice(
			resolverSource.indexOf("entryLiveCompetitionBoard: async"),
			resolverSource.indexOf("entryLiveCompetitionsDesk: async")
		);
		const legacyBoard = resolverSource.slice(
			resolverSource.indexOf("entryLiveCompetitionsDesk: async"),
			resolverSource.indexOf("liveTournamentSelectionStats: async")
		);
		for (const board of [pagedBoard, legacyBoard]) {
			expect(board).toContain("loadTournamentEventEligibility");
			expect(board.indexOf("loadTournamentEventEligibility")).toBeLessThan(
				board.indexOf("selectTournamentDeskEntryWindow")
			);
		}

		const repositorySource = await Bun.file("src/domains/tournaments/repository.ts").text();
		const detailBoard = repositorySource.slice(
			repositorySource.indexOf("async getTournamentDetailDesk"),
			repositorySource.indexOf("async getManagedTournamentStatus")
		);
		expect(detailBoard).toContain("loadTournamentEventEligibility");
		expect(detailBoard.indexOf("loadTournamentEventEligibility")).toBeLessThan(
			detailBoard.indexOf("selectTournamentDeskEntryWindow")
		);
	});

	it("keeps the live competition board on durable manager heads", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const board = source.slice(
			source.indexOf("entryLiveCompetitionBoard: async"),
			source.indexOf("entryLiveCompetitionsDesk: async")
		);
		expect(board.match(/readMode: "CACHE_ONLY"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(board.match(/managerReadMode: "CACHE_ONLY"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

		const repositorySource = await Bun.file("src/domains/tournaments/repository.ts").text();
		const detailBoard = repositorySource.slice(
			repositorySource.indexOf("async getTournamentDetailDesk"),
			repositorySource.indexOf("async getManagedTournamentStatus")
		);
		expect(detailBoard).toContain('managerReadMode: "CACHE_ONLY"');
	});

	it("keeps every interactive legacy desk and squad comparison on durable manager heads", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const desk = source.slice(
			source.indexOf("entryLiveCompetitionsDesk: async"),
			source.indexOf("tournamentSelectionIndex: async")
		);
		const squads = source.slice(
			source.indexOf("tournamentEntrySquads: async"),
			source.indexOf("tournamentLiveParticipants: async")
		);
		expect(desk).toContain('managerReadMode: "CACHE_ONLY"');
		expect(squads).toContain('managerReadMode: "CACHE_ONLY"');
	});

	it("expands ordinary legacy desks without relaxing explicit revision reads", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const desk = source.slice(
			source.indexOf("entryLiveCompetitionsDesk: async"),
			source.indexOf("tournamentSelectionIndex: async")
		);
		expect(desk).toContain("calcLivePointsForEntriesInChunks");
		expect(desk).toContain("const calculationEntryIds = args.ref ? boundedEntryIds : allEntryIds");
		expect(desk).toContain("...(args.ref && snapshot?.publicationId");
		expect(desk).not.toContain("...(snapshot?.publicationId");

		const repositorySource = await Bun.file("src/domains/tournaments/repository.ts").text();
		const detail = repositorySource.slice(
			repositorySource.indexOf("async getTournamentDetailDesk"),
			repositorySource.indexOf("async getManagedTournamentStatus")
		);
		expect(detail).toContain("calcLivePointsForEntriesInChunks");
		expect(detail).toContain("const calculationEntryIds = rosterEntryIds");
		expect(detail).not.toContain("liveRef: {");
	});

	it("requires a fresh manager heartbeat before advertising provisional full-field ranks", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const board = source.slice(
			source.indexOf("entryLiveCompetitionBoard: async"),
			source.indexOf("entryLiveCompetitionsDesk: async")
		);
		expect(board).toContain("const fullFieldManagerFreshnessReady");
		expect(board).toContain("isManagerScoreLiveHeartbeatFresh(snapshot?.lastSuccessfulFetchAt)");
		expect(board.match(/fullFieldManagerFreshnessReady/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
	});

	it("uses durable last-good heads for ordinary boards without weakening explicit refs", async () => {
		const source = await Bun.file("src/domains/live-desks/resolvers.ts").text();
		const board = source.slice(
			source.indexOf("entryLiveCompetitionBoard: async"),
			source.indexOf("entryLiveCompetitionsDesk: async")
		);
		expect(board).toContain("const managerLiveRef");
		expect(board).toContain("managerScoreLoadCanUseLastGood");
		expect(board).toContain('dataAvailability: "LAST_GOOD"');
		expect(board).toContain("if (fullFieldBoard && !managerNeedsLastGoodDetailFence)");
	});
});
