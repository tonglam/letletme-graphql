import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { myFplTestables } from "../../../src/domains/my-fpl/repository";

describe("My FPL review repository", () => {
	it("normalizes bounded search and legacy chip values", () => {
		expect(myFplTestables.normalizeSearch("  North London  ")).toBe("North London");
		expect(() => myFplTestables.normalizeSearch("x".repeat(81))).toThrow(
			"search must contain at most 80 characters"
		);
		expect(myFplTestables.normalizeChip("bboost")).toBe("BENCH_BOOST");
		expect(myFplTestables.normalizeChip("3xc")).toBe("TRIPLE_CAPTAIN");
		expect(myFplTestables.normalizeChip(null)).toBe("NONE");
		expect([1, 2, 3, 4, 5].map(myFplTestables.positionName)).toEqual([
			"GKP",
			"DEF",
			"MID",
			"FWD",
			"",
		]);
	});

	it("maps compact board JSON without losing stable rank values", () => {
		expect(
			myFplTestables.mapBoardJsonRow({
				event_id: 8,
				group_id: 2,
				entry_id: 123,
				entry_name: "Codex XI",
				player_name: "Test Manager",
				rank: "7",
				previous_rank: "9",
				event_points: 61,
				event_cost: 4,
				event_net_points: 57,
				event_rank: 12345,
				overall_points: 510,
				overall_rank: 67890,
				event_chip: "freehit",
				captain_id: 11,
				captain_web_name: "Captain",
				captain_team_short_name: "ARS",
				captain_points: 20,
				team_value: 1007,
				bank: 13,
			})
		).toMatchObject({
			eventId: 8,
			groupId: 2,
			entryId: 123,
			rank: 7,
			previousRank: 9,
			eventChip: "FREE_HIT",
		});
	});

	it("keeps the domain on finalized durable review data and lightweight core", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		expect(source).toContain("getCoreEventSnapshot");
		expect(source).not.toContain("getCoreDataSnapshot");
		expect(source).toContain("event.finished");
		expect(source).toContain("event.data_checked");
		expect(source).toContain("event.live_snapshot_finalized_at IS NOT NULL");
		expect(source).toContain("result.rich_synced_at IS NOT NULL");
		expect(source).not.toMatch(/entry-live|live-bonus|self.?calc/i);
	});

	it("does not select picks for season history and batches gameweek detail", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		const historyStart = source.indexOf("const loadTeamHistory");
		const pastSeasonStart = source.indexOf("const loadPastSeasons");
		const historySource = source.slice(historyStart, pastSeasonStart);
		expect(historySource).not.toContain("entry_event_picks");
		expect(historySource).not.toContain("event_picks");

		const gameweekQueryCount = source.match(/JOIN competition\.entry_event_picks pick/g);
		expect(gameweekQueryCount).toHaveLength(1);
		expect(source).toContain("LEFT JOIN fpl.player_gameweek_stats stats");
		const preparedStart = source.indexOf("const loadTeamGameweekPrepared");
		const preparedEnd = source.indexOf("const loadTeamDesk", preparedStart);
		const prepared = source.slice(preparedStart, preparedEnd);
		expect(prepared.indexOf("finalizedEventIds.has(eventId)")).toBeGreaterThan(-1);
		expect(prepared.indexOf("loadTeamGameweekRows")).toBeGreaterThan(
			prepared.indexOf("finalizedEventIds.has(eventId)")
		);

		const gameweekMapStart = source.indexOf("const mapGameweekPick", pastSeasonStart);
		const pastSeasonSource = source.slice(pastSeasonStart, gameweekMapStart);
		expect(pastSeasonSource).toContain("WHERE season_id = $1");
		expect(pastSeasonSource).toContain("entry_id = $2");
		expect(pastSeasonSource).not.toContain("season_id < $2");
	});

	it("pins the lightweight Core revision before reading the Team Desk cache", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		const deskStart = source.indexOf("const loadTeamDesk");
		const gameweekStart = source.indexOf("const loadTeamGameweek", deskStart + 1);
		const deskSource = source.slice(deskStart, gameweekStart);
		expect(deskSource.indexOf("await getCoreEventSnapshot(context)")).toBeGreaterThan(-1);
		expect(deskSource.indexOf("await getCoreEventSnapshot(context)")).toBeLessThan(
			deskSource.indexOf("const cacheKey = gqlCacheKey")
		);
	});

	it("pins the lightweight Core revision before reading the competition catalog cache", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		const deskStart = source.indexOf("const loadCompetitionsDesk");
		const pathStart = source.indexOf("const loadCompetitionSeasonPath", deskStart + 1);
		const deskSource = source.slice(deskStart, pathStart);
		expect(deskSource.indexOf("await getCoreEventSnapshot(context)")).toBeGreaterThan(-1);
		expect(deskSource.indexOf("await getCoreEventSnapshot(context)")).toBeLessThan(
			deskSource.indexOf("tournamentsRepository.getEntryTournaments")
		);
	});

	it("uses one paginated board projection and one season-path CTE", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		expect(source).toContain("LIMIT $5 OFFSET $6");
		expect(source).toContain("'totalRows', (SELECT count(*)::integer FROM filtered)");
		expect(source).toContain("viewer_row");
		expect(source).toContain('toLocaleLowerCase("en-US")}:${entryId}`');
		expect(source).toContain("parsed.viewerRow !== null");
		expect(source).toContain("WITH field AS MATERIALIZED");
		expect(source).toContain("points_vs_average");
	});

	it("keeps historical clubs and durable readiness checkpoints honest", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		expect(source).toContain("FROM fpl.player_fixture_stats fixture_stats");
		expect(source).toContain("COALESCE(historical_team.team_id, player.team_id)");
		expect(source).toContain("match.team_h_id = COALESCE(historical_team.team_id, player.team_id)");
		expect(source).toContain("captain_historical_team");
		expect(source).toContain("COALESCE(captain_historical_team.team_id, player.team_id)");
		expect(source).toContain("historical_team_in");
		expect(source).toContain("COALESCE(historical_team_in.team_id, player_in.team_id)");
		expect(source).toContain("transfers_synced_through_event_id");
		expect(source).toContain(
			'return { state: "PENDING", context: loadedContext.value, gameweeks: [] }'
		);
		expect(source).toContain("tournament.setupStatus !== TournamentSetupStatus.READY");
		expect(source).toContain('normalizeChip(row.event_chip) !== "BENCH_BOOST"');
		expect(source).toContain("expectedHistoryEventIds");
		expect(source).toContain('state = historyComplete ? "READY" : "PENDING"');
	});

	it("does not materialize unbounded competition aggregates", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		expect(source).toContain("MAX_AGGREGATE_FIELD_SIZE");
		expect(source).toContain("Skipping My FPL aggregate for oversized tournament");
		expect(source).toContain("SELECT count(*)::integer AS field_size");
	});

	it("resolves an explicitly authorized tournament outside the cached catalog", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		expect(source).toContain("requestedTournamentPromise");
		expect(source).toContain("getTournamentInfosUncached");
		expect(source).toContain("tournamentId ? requestedTournament : tournaments[0]");
	});

	it("revalidates default membership and rejects unsupported tournament modes", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		const deskStart = source.indexOf("const loadCompetitionsDesk");
		const selectedEventStart = source.indexOf(
			"const selectedEventId = eventId ?? loadedContext.value.latestFinalizedEventId",
			deskStart
		);
		const membershipStart = source.indexOf(
			"await assertTournamentMembership(context, selectedTournament.id, entryId)",
			deskStart
		);
		expect(membershipStart).toBeGreaterThan(deskStart);
		expect(membershipStart).toBeLessThan(selectedEventStart);
		expect(source).toContain("filterCurrentTournamentMemberships");
		expect(source).toContain("missingTournamentIds");
		expect(source).toContain("getTournamentInfoUncached(context, tournamentId)");
		expect(source).toContain("metadata.groupMode !== GroupMode.POINTS_RACES");
		expect(source).toContain("tournament.groupMode !== GroupMode.POINTS_RACES");
		const boardStart = source.indexOf("const loadCompetitionBoardPrepared");
		const boardEnd = source.indexOf("const loadCompetitionBoard =", boardStart);
		const boardSource = source.slice(boardStart, boardEnd);
		expect(boardSource.indexOf("metadata.groupMode !== GroupMode.POINTS_RACES")).toBeLessThan(
			boardSource.indexOf("loadedContext.finalizedEventIds.has(eventId)")
		);
	});

	it("bounds board pagination and normalizes legacy readiness fields", () => {
		const source = readFileSync("src/domains/my-fpl/repository.ts", "utf8");
		expect(source).toContain("MAX_COMPETITION_BOARD_PAGE");
		expect(source).toContain("page must be an integer between 1 and 100");
		expect(source).toContain("hasRequestedEvent");
		expect(source).toContain('state: hasRequestedEvent ? "READY" : "PENDING"');
		expect(source).toContain(
			"setupStatus: (row.setup_status ?? TournamentSetupStatus.PENDING).toUpperCase()"
		);
		expect(source).toContain('setupPhase: (row.setup_phase ?? "queued").toUpperCase()');
		expect(source).toContain("row.setup_completed_units ?? 0");
		expect(source).toContain("row.setup_warning_count ?? 0");
		expect(source).toContain("team.short_name AS captain_team_short_name");
		expect(source).toContain('return { ...base, state: "PENDING", result: null }');
		expect(source).toContain('state: hasRequestedEvent ? "READY" : "PENDING"');
		expect(source).toContain("stateTtl(payload.state)");
	});
});
