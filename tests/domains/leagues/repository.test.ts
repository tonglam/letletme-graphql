import { describe, expect, it } from "bun:test";
import { leaguesRepository } from "../../../src/domains/leagues/repository";

type LeagueRow = Record<string, unknown>;

type Query = Promise<{ data: LeagueRow[]; error: null }> & {
	select: (columns: string) => Query;
	eq: (column: string, value: unknown) => Query;
};

const makeQuery = (rows: LeagueRow[]) => {
	let projection = "";
	const filters: Array<[string, unknown]> = [];
	const query = Promise.resolve({ data: rows, error: null }) as Query;
	query.select = (columns) => {
		projection = columns;
		return query;
	};
	query.eq = (column, value) => {
		filters.push([column, value]);
		return query;
	};
	return { query, getProjection: () => projection, getFilters: () => filters };
};

const contextFor = (rows: LeagueRow[]) => {
	const readQuery = makeQuery(rows);
	const context = {
		currentSeason: { seasonId: 2026, seasonCode: "2627" },
		dataRevision: "core-17",
		redis: {
			get: async () => null,
			set: async () => "OK",
			del: async () => 0,
		},
		data: {
			read: (relation: string) => {
				expect(relation).toBe("competition.entry_leagues_with_tournament");
				return readQuery.query;
			},
		},
		logger: { warn: () => undefined, error: () => undefined },
	} as never;
	return { context, readQuery };
};

describe("leaguesRepository.getEntryLeagues", () => {
	it("reads joined tournament enrichment in one season-scoped query", async () => {
		const { context, readQuery } = contextFor([
			{
				league_id: 10,
				league_name: "H2H Cup",
				league_type: "h2h",
				entry_id: 123,
				entry_rank: 4,
				entry_last_rank: 7,
				started_event: 1,
				official_kind: null,
				short_name: null,
				tournament_id: 20,
				tournament_name: "H2H Cup Tournament",
				tournament_admin_entry_id: 123,
				tournament_total_team_num: 20,
				tournament_mode: "battle_race",
				tournament_group_mode: "league",
				tournament_state: "active",
				tournament_created_at: "2026-08-20T00:00:00.000Z",
			},
		]);

		const leagues = await leaguesRepository.getEntryLeagues(context, 123, "H2H");

		expect(readQuery.getProjection()).toContain("tournament_id");
		expect(readQuery.getFilters()).toEqual([
			["entry_id", 123],
			["league_type", "h2h"],
		]);
		expect(leagues).toMatchObject([
			{
				id: 10,
				name: "H2H Cup",
				tournamentId: 20,
				tournamentName: "H2H Cup Tournament",
				adminEntry: 123,
				totalTeamNum: 20,
				state: "active",
			},
		]);
	});

	it("keeps tournament fields nullable when no matching tournament exists", async () => {
		const { context } = contextFor([
			{
				league_id: 11,
				league_name: "Friends",
				league_type: "classic",
				entry_id: 123,
				entry_rank: null,
				entry_last_rank: null,
				started_event: null,
				official_kind: null,
				short_name: null,
				tournament_id: null,
				tournament_name: null,
				tournament_admin_entry_id: null,
				tournament_total_team_num: null,
				tournament_mode: null,
				tournament_group_mode: null,
				tournament_state: null,
				tournament_created_at: null,
			},
		]);

		await expect(leaguesRepository.getEntryLeagues(context, 123)).resolves.toMatchObject([
			{
				id: 11,
				tournamentId: null,
				tournamentName: null,
				state: null,
			},
		]);
	});
});
