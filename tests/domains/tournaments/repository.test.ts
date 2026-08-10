import { describe, expect, it } from "bun:test";
import { LeagueType } from "../../../src/domains/leagues/repository";
import {
	type DbTournamentBattleGroupResultRow,
	type DbTournamentEntryRow,
	type DbTournamentInfoRow,
	type DbTournamentPointsGroupResultRow,
	type TournamentEventResult,
	extractTournamentIds,
	GroupMode,
	KnockoutMode,
	mapTournamentBattleGroupResult,
	mapTournamentEventResult,
	mapTournamentInfo,
	TournamentMode,
	TournamentRosterMode,
	TournamentSetupPhase,
	TournamentSetupStatus,
	TournamentState,
	tournamentsRepository,
} from "../../../src/domains/tournaments/repository";
import type { GraphQLContext } from "../../../src/graphql/context";
import { gqlCacheKey } from "../../../src/infra/cache-key";

const testCacheKey = (key: string): string =>
	gqlCacheKey(
		{
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
		} as GraphQLContext,
		key
	);

type QueryAction = { type: string; args: unknown[] };

const filterRowsByActions = (rows: unknown[], actions: QueryAction[]): unknown[] =>
	rows.filter((row) => {
		if (typeof row !== "object" || row === null) {
			return false;
		}
		const record = row as Record<string, unknown>;
		return actions.every((action) => {
			const column = String(action.args[0] ?? "");
			const value = record[column];
			if (action.type === "eq") {
				return value === action.args[1];
			}
			if (action.type === "in") {
				const values = Array.isArray(action.args[1]) ? action.args[1] : [];
				return values.includes(value);
			}
			if (action.type === "gte") {
				return typeof value === "number" && typeof action.args[1] === "number"
					? value >= action.args[1]
					: true;
			}
			if (action.type === "lte") {
				return typeof value === "number" && typeof action.args[1] === "number"
					? value <= action.args[1]
					: true;
			}
			return true;
		});
	});

describe("extractTournamentIds", () => {
	it("returns an empty array for empty input", () => {
		expect(extractTournamentIds([])).toEqual([]);
	});

	it("deduplicates tournament ids while preserving first-seen order", () => {
		const rows: DbTournamentEntryRow[] = [
			{ tournament_id: 5 },
			{ tournament_id: 7 },
			{ tournament_id: 5 },
			{ tournament_id: 9 },
			{ tournament_id: 7 },
		];

		expect(extractTournamentIds(rows)).toEqual([5, 7, 9]);
	});
});

describe("mapTournamentInfo", () => {
	it("maps a tournament info row to domain model", () => {
		const row: DbTournamentInfoRow = {
			id: 11,
			name: "Mini League Cup",
			creator: "alice",
			admin_entry_id: 1001,
			league_id: 999,
			league_type: "h2h",
			total_team_num: 32,
			tournament_mode: "normal",
			group_mode: "points_races",
			group_team_num: 4,
			group_num: 8,
			group_started_event_id: 1,
			group_ended_event_id: 8,
			group_auto_averages: true,
			group_rounds: 2,
			group_play_against_num: 1,
			group_qualify_num: 2,
			knockout_mode: "single_elimination",
			knockout_team_num: 16,
			knockout_rounds: 4,
			knockout_event_num: 4,
			knockout_started_event_id: 9,
			knockout_ended_event_id: 12,
			knockout_play_against_num: 1,
			state: "active",
			created_at: "2026-04-21T00:00:00.000Z",
			updated_at: "2026-04-21T00:00:00.000Z",
		};

		expect(mapTournamentInfo(row)).toEqual({
			id: 11,
			name: "Mini League Cup",
			creator: "alice",
			adminEntryId: 1001,
			leagueId: 999,
			leagueType: LeagueType.H2H,
			sourceLeagueName: null,
			rosterMode: TournamentRosterMode.SNAPSHOT,
			rosterSyncStatus: null,
			rosterLastSyncedAt: null,
			totalTeamNum: 32,
			tournamentMode: TournamentMode.NORMAL,
			groupMode: GroupMode.POINTS_RACES,
			groupTeamNum: 4,
			groupNum: 8,
			groupStartedEventId: 1,
			groupEndedEventId: 8,
			groupAutoAverages: true,
			groupRounds: 2,
			groupPlayAgainstNum: 1,
			groupQualifyNum: 2,
			knockoutMode: KnockoutMode.SINGLE_ELIMINATION,
			knockoutTeamNum: 16,
			knockoutRounds: 4,
			knockoutEventNum: 4,
			knockoutStartedEventId: 9,
			knockoutEndedEventId: 12,
			knockoutPlayAgainstNum: 1,
			state: TournamentState.ACTIVE,
			setupStatus: TournamentSetupStatus.READY,
			setupPhase: TournamentSetupPhase.READY,
			setupCompletedUnits: 0,
			setupTotalUnits: 0,
			setupProgressUpdatedAt: null,
			standingsReadyAt: "2026-04-21T00:00:00.000Z",
			setupHasWarnings: false,
			setupStartedAt: null,
			setupFinishedAt: null,
			createdAt: "2026-04-21T00:00:00.000Z",
			updatedAt: "2026-04-21T00:00:00.000Z",
		});
	});

	it("treats nullable legacy setup status as an already-published tournament", () => {
		const updatedAt = "2026-04-21T00:00:00.000Z";
		const row: DbTournamentInfoRow = {
			id: 12,
			name: "Legacy League",
			creator: "alice",
			admin_entry_id: 1001,
			league_id: 999,
			league_type: "classic",
			total_team_num: 2,
			tournament_mode: "normal",
			group_mode: null,
			group_team_num: null,
			group_num: null,
			group_started_event_id: null,
			group_ended_event_id: null,
			group_auto_averages: false,
			group_rounds: null,
			group_play_against_num: null,
			group_qualify_num: null,
			knockout_mode: null,
			knockout_team_num: null,
			knockout_rounds: null,
			knockout_event_num: null,
			knockout_started_event_id: null,
			knockout_ended_event_id: null,
			knockout_play_against_num: null,
			state: "active",
			setup_status: null as unknown as string,
			setup_phase: null as unknown as string,
			standings_ready_at: null,
			created_at: updatedAt,
			updated_at: updatedAt,
		};

		expect(mapTournamentInfo(row)).toMatchObject({
			setupStatus: TournamentSetupStatus.READY,
			setupPhase: TournamentSetupPhase.READY,
			standingsReadyAt: updatedAt,
		});
	});
});

describe("mapTournamentEventResult", () => {
	it("maps joined tournament event data with league row priority for names", () => {
		const tournament = mapTournamentInfo({
			id: 11,
			name: "Mini League Cup",
			creator: "alice",
			admin_entry_id: 1001,
			league_id: 999,
			league_type: "classic",
			total_team_num: 32,
			tournament_mode: "normal",
			group_mode: "points_races",
			group_team_num: 4,
			group_num: 8,
			group_started_event_id: 1,
			group_ended_event_id: 8,
			group_auto_averages: true,
			group_rounds: 2,
			group_play_against_num: 1,
			group_qualify_num: 2,
			knockout_mode: "no_knockout",
			knockout_team_num: null,
			knockout_rounds: null,
			knockout_event_num: null,
			knockout_started_event_id: null,
			knockout_ended_event_id: null,
			knockout_play_against_num: null,
			state: "active",
			created_at: "2026-04-21T00:00:00.000Z",
			updated_at: "2026-04-21T00:00:00.000Z",
		});
		const row: DbTournamentPointsGroupResultRow = {
			tournament_id: 11,
			group_id: 3,
			event_id: 33,
			entry_id: 12345,
			event_group_rank: 2,
			event_points: 81,
			event_cost: 4,
			event_net_points: 77,
			event_rank: 201,
		};

		expect(
			mapTournamentEventResult(
				tournament,
				row,
				{
					league_id: 999,
					league_type: "classic",
					event_id: 33,
					entry_id: 12345,
					entry_name: "League Entry",
					player_name: "League Player",
					overall_points: 1987,
					overall_rank: 10022,
					event_chip: "freehit",
					captain_id: 430,
					captain_points: 12,
					team_value: 1030,
					bank: 22,
				},
				{
					id: 12345,
					entry_name: "Fallback Entry",
					player_name: "Fallback Player",
				}
			)
		).toEqual({
			tournament,
			eventId: 33,
			groupId: 3,
			entryId: 12345,
			entryName: "League Entry",
			playerName: "League Player",
			eventGroupRank: 2,
			eventPoints: 81,
			eventCost: 4,
			eventNetPoints: 77,
			eventRank: 201,
			overallPoints: 1987,
			overallRank: 10022,
			eventChip: "freehit",
			captainId: 430,
			captainPoints: 12,
			teamValue: 1030,
			bank: 22,
		});
	});

	it("falls back to entry info names when league enrichment names are missing", () => {
		const tournament = mapTournamentInfo({
			id: 11,
			name: "Mini League Cup",
			creator: "alice",
			admin_entry_id: 1001,
			league_id: 999,
			league_type: "classic",
			total_team_num: 32,
			tournament_mode: "normal",
			group_mode: "points_races",
			group_team_num: 4,
			group_num: 8,
			group_started_event_id: 1,
			group_ended_event_id: 8,
			group_auto_averages: true,
			group_rounds: 2,
			group_play_against_num: 1,
			group_qualify_num: 2,
			knockout_mode: "no_knockout",
			knockout_team_num: null,
			knockout_rounds: null,
			knockout_event_num: null,
			knockout_started_event_id: null,
			knockout_ended_event_id: null,
			knockout_play_against_num: null,
			state: "active",
			created_at: "2026-04-21T00:00:00.000Z",
			updated_at: "2026-04-21T00:00:00.000Z",
		});

		const result = mapTournamentEventResult(
			tournament,
			{
				tournament_id: 11,
				group_id: 1,
				event_id: 33,
				entry_id: 7,
				event_group_rank: 1,
				event_points: 90,
				event_cost: 0,
				event_net_points: 90,
				event_rank: 5,
			},
			{
				league_id: 999,
				league_type: "classic",
				event_id: 33,
				entry_id: 7,
				entry_name: null,
				player_name: null,
				overall_points: 2000,
				overall_rank: 50,
				event_chip: null,
				captain_id: null,
				captain_points: null,
				team_value: null,
				bank: null,
			},
			{
				id: 7,
				entry_name: "Fallback Entry",
				player_name: "Fallback Player",
			}
		);

		expect(result.entryName).toBe("Fallback Entry");
		expect(result.playerName).toBe("Fallback Player");
	});
});

describe("tournamentsRepository.getTournamentEventResults", () => {
	const buildContext = (options: {
		tournamentData?: unknown[];
		tournamentEntriesData?: unknown[];
		resultData?: unknown[];
		entryEventResultsData?: unknown[];
		tournamentError?: unknown;
		tournamentEntriesError?: unknown;
		resultError?: unknown;
		entryEventResultsError?: unknown;
		cacheSeed?: string | null;
	}): GraphQLContext => {
		const redisState = new Map<string, string>();
		if (options.cacheSeed) {
			redisState.set(
				testCacheKey(`tournaments:event-results:{"eventId":33,"tournamentId":1}`),
				options.cacheSeed
			);
		}
		const queryLog: Array<{
			table: string;
			actions: Array<{ type: string; args: unknown[] }>;
		}> = [];

		const makeBuilder = (table: string) => {
			const actions: Array<{ type: string; args: unknown[] }> = [];
			queryLog.push({ table, actions });

			const resolveResult = () => {
				if (table === "competition.tournaments") {
					return {
						data: options.tournamentData ?? [],
						error: options.tournamentError ?? null,
					};
				}
				if (table === "reporting.tournament_event_results") {
					return {
						data: options.resultData ?? [],
						error: options.resultError ?? null,
					};
				}
				if (table === "competition.tournament_entries") {
					return {
						data: filterRowsByActions(options.tournamentEntriesData ?? [], actions),
						error: options.tournamentEntriesError ?? null,
					};
				}
				if (table === "competition.entry_event_results") {
					return {
						data: filterRowsByActions(options.entryEventResultsData ?? [], actions),
						error: options.entryEventResultsError ?? null,
					};
				}
				return { data: [], error: null };
			};

			let resolvePromise!: (value: ReturnType<typeof resolveResult>) => void;
			const promise = new Promise<ReturnType<typeof resolveResult>>((resolve) => {
				resolvePromise = resolve;
			});
			queueMicrotask(() => resolvePromise(resolveResult()));

			const builder = Object.assign(promise, {
				select(...args: unknown[]) {
					actions.push({ type: "select", args });
					return builder;
				},
				eq(...args: unknown[]) {
					actions.push({ type: "eq", args });
					return builder;
				},
				in(...args: unknown[]) {
					actions.push({ type: "in", args });
					return builder;
				},
				gte(...args: unknown[]) {
					actions.push({ type: "gte", args });
					return builder;
				},
				lte(...args: unknown[]) {
					actions.push({ type: "lte", args });
					return builder;
				},
				order(...args: unknown[]) {
					actions.push({ type: "order", args });
					return builder;
				},
				async limit(...args: unknown[]) {
					actions.push({ type: "limit", args });
					return resolveResult();
				},
			});

			return builder;
		};

		return {
			database: {
				query: async () => {
					throw new Error("Unexpected database query");
				},
			} as never,
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			data: {
				read(table: string) {
					return makeBuilder(table);
				},
			} as never,
			redis: {
				async get(key: string) {
					return redisState.get(key) ?? null;
				},
				async set(key: string, value: string) {
					redisState.set(key, value);
					return "OK";
				},
			} as never,
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			} as never,
			user: undefined,
			// Test helpers
			__queryLog: queryLog,
			__redisState: redisState,
		} as GraphQLContext;
	};

	const tournamentRow: DbTournamentInfoRow = {
		id: 1,
		name: "Tournament 1",
		creator: "tong",
		admin_entry_id: 15702,
		league_id: 12121,
		league_type: "classic",
		total_team_num: 3,
		tournament_mode: "normal",
		group_mode: "points_races",
		group_team_num: 3,
		group_num: 1,
		group_started_event_id: 1,
		group_ended_event_id: 38,
		group_auto_averages: false,
		group_rounds: null,
		group_play_against_num: null,
		group_qualify_num: null,
		knockout_mode: null,
		knockout_team_num: null,
		knockout_rounds: null,
		knockout_event_num: null,
		knockout_started_event_id: null,
		knockout_ended_event_id: null,
		knockout_play_against_num: null,
		state: "active",
		created_at: "2026-04-21T00:00:00.000Z",
		updated_at: "2026-04-21T00:00:00.000Z",
	};

	it("returns cached results when available", async () => {
		const cached = [
			{
				tournament: mapTournamentInfo(tournamentRow),
				eventId: 33,
				groupId: 1,
				entryId: 123,
				entryName: "Cached",
				playerName: "Cached Player",
				eventGroupRank: 1,
				eventPoints: 90,
				eventCost: 0,
				eventNetPoints: 90,
				eventRank: 10,
				overallPoints: 2000,
				overallRank: 100,
				eventChip: "bboost",
				captainId: 430,
				captainPoints: 12,
				teamValue: 1030,
				bank: 25,
			},
		];
		const context = buildContext({ cacheSeed: JSON.stringify(cached) });

		const result = await tournamentsRepository.getTournamentEventResults(context, 1, 33);
		expect(result).toEqual(cached);
	});

	it("returns empty array when the tournament has no results", async () => {
		const context = buildContext({ resultData: [] });
		const result = await tournamentsRepository.getTournamentEventResults(context, 1, 33);
		expect(result).toEqual([]);
	});

	it("returns empty array when the tournament mode is not POINTS_RACES", async () => {
		const context = buildContext({
			resultData: [
				{
					tournament_id: 1,
					event_id: 33,
					entry_id: 100,
					group_id: 1,
					event_group_rank: 1,
					event_points: 98,
					event_cost: 0,
					event_net_points: 98,
					event_rank: 50,
					overall_points: 2001,
					overall_rank: 200,
					event_chip: "bboost",
					captain_id: 430,
					captain_points: 12,
					team_value: 1038,
					bank: 22,
					entry_name: "League Entry 100",
					player_name: "Manager 100",
					_tournament_id: 1,
					_tournament_name: "Tournament 1",
					_tournament_creator: "tong",
					_tournament_admin_entry_id: 15702,
					_tournament_league_id: 12121,
					_tournament_league_type: "classic",
					_tournament_total_team_num: 3,
					_tournament_tournament_mode: "normal",
					_tournament_group_mode: "battle_races",
					_tournament_group_team_num: 3,
					_tournament_group_num: 1,
					_tournament_group_started_event_id: 1,
					_tournament_group_ended_event_id: 38,
					_tournament_group_auto_averages: false,
					_tournament_group_rounds: null,
					_tournament_group_play_against_num: null,
					_tournament_group_qualify_num: null,
					_tournament_knockout_mode: null,
					_tournament_knockout_team_num: null,
					_tournament_knockout_rounds: null,
					_tournament_knockout_event_num: null,
					_tournament_knockout_started_event_id: null,
					_tournament_knockout_ended_event_id: null,
					_tournament_knockout_play_against_num: null,
					_tournament_state: "active",
					_tournament_created_at: "2026-04-21T00:00:00.000Z",
					_tournament_updated_at: "2026-04-21T00:00:00.000Z",
				},
			],
		});
		const result = await tournamentsRepository.getTournamentEventResults(context, 1, 33);
		expect(result).toEqual([]);
	});

	it("returns rows ordered by group and event_group_rank and caches the merged result", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			resultData: [
				{
					tournament_id: 1,
					event_id: 33,
					entry_id: 100,
					group_id: 1,
					event_group_rank: 1,
					event_points: 98,
					event_cost: 0,
					event_net_points: 98,
					event_rank: 50,
					overall_points: 2001,
					overall_rank: 200,
					event_chip: "bboost",
					captain_id: 430,
					captain_points: 12,
					team_value: 1038,
					bank: 22,
					entry_name: "League Entry 100",
					player_name: "Manager 100",
					_tournament_id: 1,
					_tournament_name: "Tournament 1",
					_tournament_creator: "tong",
					_tournament_admin_entry_id: 15702,
					_tournament_league_id: 12121,
					_tournament_league_type: "classic",
					_tournament_total_team_num: 3,
					_tournament_tournament_mode: "normal",
					_tournament_group_mode: "points_races",
					_tournament_group_team_num: 3,
					_tournament_group_num: 1,
					_tournament_group_started_event_id: 1,
					_tournament_group_ended_event_id: 38,
					_tournament_group_auto_averages: false,
					_tournament_group_rounds: null,
					_tournament_group_play_against_num: null,
					_tournament_group_qualify_num: null,
					_tournament_knockout_mode: null,
					_tournament_knockout_team_num: null,
					_tournament_knockout_rounds: null,
					_tournament_knockout_event_num: null,
					_tournament_knockout_started_event_id: null,
					_tournament_knockout_ended_event_id: null,
					_tournament_knockout_play_against_num: null,
					_tournament_state: "active",
					_tournament_created_at: "2026-04-21T00:00:00.000Z",
					_tournament_updated_at: "2026-04-21T00:00:00.000Z",
				},
				{
					tournament_id: 1,
					event_id: 33,
					entry_id: 300,
					group_id: 2,
					event_group_rank: 2,
					event_points: 81,
					event_cost: 4,
					event_net_points: 77,
					event_rank: 201,
					overall_points: 1880,
					overall_rank: 1000,
					event_chip: "freehit",
					captain_id: 99,
					captain_points: 8,
					team_value: 1025,
					bank: 10,
					entry_name: "Fallback Entry 300",
					player_name: "Fallback Manager 300",
					_tournament_id: 1,
					_tournament_name: "Tournament 1",
					_tournament_creator: "tong",
					_tournament_admin_entry_id: 15702,
					_tournament_league_id: 12121,
					_tournament_league_type: "classic",
					_tournament_total_team_num: 3,
					_tournament_tournament_mode: "normal",
					_tournament_group_mode: "points_races",
					_tournament_group_team_num: 3,
					_tournament_group_num: 1,
					_tournament_group_started_event_id: 1,
					_tournament_group_ended_event_id: 38,
					_tournament_group_auto_averages: false,
					_tournament_group_rounds: null,
					_tournament_group_play_against_num: null,
					_tournament_group_qualify_num: null,
					_tournament_knockout_mode: null,
					_tournament_knockout_team_num: null,
					_tournament_knockout_rounds: null,
					_tournament_knockout_event_num: null,
					_tournament_knockout_started_event_id: null,
					_tournament_knockout_ended_event_id: null,
					_tournament_knockout_play_against_num: null,
					_tournament_state: "active",
					_tournament_created_at: "2026-04-21T00:00:00.000Z",
					_tournament_updated_at: "2026-04-21T00:00:00.000Z",
				},
			],
		});

		const result = await tournamentsRepository.getTournamentEventResults(context, 1, 33);

		expect(result).toHaveLength(2);
		expect(result[0].groupId).toBe(1);
		expect(result[0].entryId).toBe(100);
		expect(result[0].entryName).toBe("League Entry 100");
		expect(result[1].groupId).toBe(2);
		expect(result[1].entryId).toBe(300);
		expect(result[1].entryName).toBe("Fallback Entry 300");
		expect(result[1].eventChip).toBe("freehit");

		const cached = await context.redis.get(
			testCacheKey(`tournaments:event-results:{"eventId":33,"tournamentId":1}`)
		);
		expect(cached).not.toBeNull();
	});
});

describe("tournamentsRepository.getTournamentEntryRankingSummary", () => {
	const buildContext = (options: {
		tournamentData?: unknown[];
		snapshotData?: unknown[];
		tournamentError?: unknown;
		snapshotError?: unknown;
		cacheSeed?: string | null;
		eventResults?: TournamentEventResult[];
	}): GraphQLContext => {
		const redisState = new Map<string, string>();
		if (options.cacheSeed) {
			redisState.set(
				testCacheKey(
					`tournaments:ranking-summary:v2:{"entryId":15702,"eventId":3,"tournamentId":1}`
				),
				options.cacheSeed
			);
		}
		if (options.eventResults) {
			redisState.set(
				testCacheKey(`tournaments:event-results:{"eventId":3,"tournamentId":1}`),
				JSON.stringify(options.eventResults)
			);
		}

		const makeBuilder = (table: string) => {
			const actions: QueryAction[] = [];

			const resolveResult = () => {
				if (table === "competition.tournaments") {
					return {
						data: options.tournamentData ?? [],
						error: options.tournamentError ?? null,
					};
				}
				if (table === "reporting.tournament_entry_event_summaries") {
					return {
						data: filterRowsByActions(options.snapshotData ?? [], actions),
						error: options.snapshotError ?? null,
					};
				}
				return { data: [], error: null };
			};

			let resolvePromise!: (value: ReturnType<typeof resolveResult>) => void;
			const promise = new Promise<ReturnType<typeof resolveResult>>((resolve) => {
				resolvePromise = resolve;
			});
			queueMicrotask(() => resolvePromise(resolveResult()));

			const builder = Object.assign(promise, {
				select(...args: unknown[]) {
					actions.push({ type: "select", args });
					return builder;
				},
				eq(...args: unknown[]) {
					actions.push({ type: "eq", args });
					return builder;
				},
				in(...args: unknown[]) {
					actions.push({ type: "in", args });
					return builder;
				},
				gte(...args: unknown[]) {
					actions.push({ type: "gte", args });
					return builder;
				},
				lte(...args: unknown[]) {
					actions.push({ type: "lte", args });
					return builder;
				},
				order(...args: unknown[]) {
					actions.push({ type: "order", args });
					return builder;
				},
				async limit(...args: unknown[]) {
					actions.push({ type: "limit", args });
					return resolveResult();
				},
			});

			return builder;
		};

		return {
			database: {
				query: async () => {
					throw new Error("Unexpected database query");
				},
			} as never,
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			data: {
				read(table: string) {
					return makeBuilder(table);
				},
			} as never,
			redis: {
				async get(key: string) {
					return redisState.get(key) ?? null;
				},
				async set(key: string, value: string) {
					redisState.set(key, value);
					return "OK";
				},
			} as never,
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			} as never,
			user: undefined,
		} as GraphQLContext;
	};

	const tournamentRow: DbTournamentInfoRow = {
		id: 1,
		name: "Tournament 1",
		creator: "tong",
		admin_entry_id: 15702,
		league_id: 12121,
		league_type: "classic",
		total_team_num: 2,
		tournament_mode: "normal",
		group_mode: "points_races",
		group_team_num: 2,
		group_num: 1,
		group_started_event_id: 2,
		group_ended_event_id: 38,
		group_auto_averages: false,
		group_rounds: null,
		group_play_against_num: null,
		group_qualify_num: null,
		knockout_mode: null,
		knockout_team_num: null,
		knockout_rounds: null,
		knockout_event_num: null,
		knockout_started_event_id: null,
		knockout_ended_event_id: null,
		knockout_play_against_num: null,
		state: "active",
		created_at: "2026-04-21T00:00:00.000Z",
		updated_at: "2026-04-21T00:00:00.000Z",
	};

	it("returns cached summary when available", async () => {
		const cached = {
			eventId: 3,
			entryId: 15702,
			overallRank: 500,
			tournamentOverallRank: 2,
			teamValue: 1020,
			tournamentTeamValueRank: 1,
			transfersNum: 3,
			tournamentTransfersRank: 2,
			totalCosts: 4,
			tournamentCostsRank: 2,
			totalBenchPoints: 20,
			tournamentBenchPointsRank: 1,
			autoSubPoints: 5,
			tournamentAutoSubRank: 1,
			overallPoints: 1120,
			leaderOverallPoints: 1200,
			gapToLeader: 80,
			pointsBehindNext: 40,
			pointsAheadOfPrev: 12,
		};
		const context = buildContext({ cacheSeed: JSON.stringify(cached) });

		const result = await tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			1,
			3,
			15702
		);

		expect(result).toEqual(cached);
	});

	it("returns empty summary for non-points-race tournaments from the v3 tournament model", async () => {
		const context = buildContext({
			tournamentData: [{ ...tournamentRow, group_mode: "battle_races" }],
		});

		const result = await tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			1,
			3,
			15702
		);
		expect(result.overallRank).toBeNull();
		expect(result.tournamentOverallRank).toBeNull();
		expect(result.teamValue).toBeNull();
		expect(result.transfersNum).toBe(0);
	});

	it("returns empty summary for non-points-race tournaments when snapshot row carries group_mode", async () => {
		const context = buildContext({
			snapshotData: [
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 15702,
					group_mode: "battle_races",
					tournament_overall_rank: 2,
					overall_rank: 1000,
					team_value: 1020,
					cum_transfers_num: 3,
					cum_total_costs: 4,
					cum_total_bench_points: 11,
					cum_auto_sub_points: 7,
					tournament_team_value_rank: 1,
					tournament_transfers_rank: 2,
					tournament_costs_rank: 2,
					tournament_bench_points_rank: 1,
					tournament_auto_sub_rank: 1,
				},
			],
		});

		const result = await tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			1,
			3,
			15702
		);
		expect(result.overallRank).toBeNull();
		expect(result.tournamentOverallRank).toBeNull();
		expect(result.teamValue).toBeNull();
		expect(result.transfersNum).toBe(0);
	});

	it("builds cumulative summary and metric-specific ranks", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			snapshotData: [
				{
					tournament_id: 1,
					event_id: 2,
					entry_id: 15702,
					group_mode: "points_races",
					tournament_overall_rank: 2,
					overall_rank: 1100,
					team_value: 1015,
					cum_transfers_num: 1,
					cum_total_costs: 0,
					cum_total_bench_points: 5,
					cum_auto_sub_points: 3,
					tournament_team_value_rank: 1,
					tournament_transfers_rank: 2,
					tournament_costs_rank: 1,
					tournament_bench_points_rank: 1,
					tournament_auto_sub_rank: 1,
				},
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 15702,
					group_mode: "points_races",
					tournament_overall_rank: 2,
					overall_rank: 1000,
					team_value: 1020,
					cum_transfers_num: 3,
					cum_total_costs: 4,
					cum_total_bench_points: 11,
					cum_auto_sub_points: 7,
					tournament_team_value_rank: 1,
					tournament_transfers_rank: 2,
					tournament_costs_rank: 2,
					tournament_bench_points_rank: 1,
					tournament_auto_sub_rank: 1,
				},
			],
		});

		const result = await tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			1,
			3,
			15702
		);

		expect(result.overallRank).toBe(1000);
		expect(result.tournamentOverallRank).toBe(2);
		expect(result.teamValue).toBe(1020);
		expect(result.tournamentTeamValueRank).toBe(1);
		expect(result.transfersNum).toBe(3);
		expect(result.tournamentTransfersRank).toBe(2);
		expect(result.totalCosts).toBe(4);
		expect(result.tournamentCostsRank).toBe(2);
		expect(result.totalBenchPoints).toBe(11);
		expect(result.tournamentBenchPointsRank).toBe(1);
		expect(result.autoSubPoints).toBe(7);
		expect(result.tournamentAutoSubRank).toBe(1);
		// Gaps come from event results (empty in this unit fixture → nulls)
		expect(result.overallPoints).toBeNull();
		expect(result.leaderOverallPoints).toBeNull();
		expect(result.gapToLeader).toBeNull();
		expect(result.pointsBehindNext).toBeNull();
		expect(result.pointsAheadOfPrev).toBeNull();
	});

	it("returns null ranks and zero cumulative metrics when snapshot row is missing", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			snapshotData: [],
		});

		const result = await tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			1,
			3,
			15702
		);

		expect(result.overallRank).toBeNull();
		expect(result.tournamentOverallRank).toBeNull();
		expect(result.teamValue).toBeNull();
		expect(result.tournamentTeamValueRank).toBeNull();
		expect(result.transfersNum).toBe(0);
		expect(result.tournamentTransfersRank).toBeNull();
		expect(result.totalCosts).toBe(0);
		expect(result.tournamentCostsRank).toBeNull();
		expect(result.totalBenchPoints).toBe(0);
		expect(result.tournamentBenchPointsRank).toBeNull();
		expect(result.autoSubPoints).toBe(0);
		expect(result.tournamentAutoSubRank).toBeNull();
	});

	const seasonEventResult = (
		entryId: number,
		groupRank: number,
		overallPoints: number,
		teamValue: number
	): TournamentEventResult => ({
		tournament: mapTournamentInfo(tournamentRow),
		eventId: 3,
		groupId: 1,
		entryId,
		entryName: `Entry ${entryId}`,
		playerName: `Manager ${entryId}`,
		eventGroupRank: groupRank,
		eventPoints: 70,
		eventCost: 0,
		eventNetPoints: 70,
		eventRank: 100,
		overallPoints,
		overallRank: 1000 + groupRank,
		eventChip: null,
		captainId: null,
		captainPoints: null,
		teamValue,
		bank: 10,
	});

	it("builds one tournament season snapshot from v3 reporting rows", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			eventResults: [
				seasonEventResult(15702, 1, 1120, 1020),
				seasonEventResult(20002, 1, 1200, 1030),
				seasonEventResult(30003, 1, 1090, 1010),
			],
			snapshotData: [
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 15702,
					team_value: 1020,
					cum_transfers_num: 2,
					cum_total_costs: 0,
					cum_total_bench_points: 12,
					cum_auto_sub_points: 3,
				},
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 20002,
					team_value: 1030,
					cum_transfers_num: 4,
					cum_total_costs: 4,
					cum_total_bench_points: 10,
					cum_auto_sub_points: 7,
				},
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 30003,
					team_value: 1010,
					cum_transfers_num: 3,
					cum_total_costs: 8,
					cum_total_bench_points: 18,
					cum_auto_sub_points: 1,
				},
			],
		});

		const result = await tournamentsRepository.getTournamentSeasonSnapshot(context, 1, 3);

		expect(result).toMatchObject({
			asOfEventId: 3,
			entryCount: 3,
			leaderOverallPoints: 1200,
			secondOverallPoints: 1120,
			gapFirstSecond: 80,
			averageOverallPoints: 1137,
		});
		expect(result.standings.map((row) => row.entryId)).toEqual([20002, 15702, 30003]);
		expect(result.standings.map((row) => row.rank)).toEqual([1, 2, 3]);
		expect(result.metrics.find((metric) => metric.key === "TEAM_VALUE")).toMatchObject({
			leaderEntryId: 20002,
			leaderValue: 1030,
		});
		expect(result.metrics.find((metric) => metric.key === "TRANSFERS")).toMatchObject({
			leaderEntryId: 15702,
			leaderValue: 2,
			higherIsBetter: false,
		});
	});

	it("returns an empty season snapshot for unsupported tournament modes", async () => {
		const context = buildContext({
			tournamentData: [{ ...tournamentRow, group_mode: "battle_races" }],
			snapshotData: [
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 15702,
					cum_transfers_num: 2,
				},
			],
		});

		const result = await tournamentsRepository.getTournamentSeasonSnapshot(context, 1, 3);
		expect(result).toMatchObject({ entryCount: 0, metrics: [], standings: [] });
	});

	it("fails closed when the cumulative metric scope is incomplete", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			eventResults: [
				seasonEventResult(15702, 1, 1120, 1020),
				seasonEventResult(20002, 1, 1200, 1030),
			],
			snapshotData: [
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 15702,
					cum_transfers_num: 2,
				},
			],
		});

		await expect(tournamentsRepository.getTournamentSeasonSnapshot(context, 1, 3)).rejects.toThrow(
			"Tournament season metrics are incomplete"
		);
	});
});

describe("mapTournamentBattleGroupResult", () => {
	const tournament = mapTournamentInfo({
		id: 7,
		name: "H2H League",
		creator: "tong",
		admin_entry_id: 100,
		league_id: 24221,
		league_type: "h2h",
		total_team_num: 16,
		tournament_mode: "normal",
		group_mode: "battle_races",
		group_team_num: 2,
		group_num: 8,
		group_started_event_id: 1,
		group_ended_event_id: 38,
		group_auto_averages: false,
		group_rounds: null,
		group_play_against_num: null,
		group_qualify_num: null,
		knockout_mode: null,
		knockout_team_num: null,
		knockout_rounds: null,
		knockout_event_num: null,
		knockout_started_event_id: null,
		knockout_ended_event_id: null,
		knockout_play_against_num: null,
		state: "active",
		created_at: "2026-04-21T00:00:00.000Z",
		updated_at: "2026-04-21T00:00:00.000Z",
	});

	const row: DbTournamentBattleGroupResultRow = {
		id: 501,
		tournament_id: 7,
		group_id: 3,
		event_id: 15,
		home_entry_id: 1001,
		home_net_points: 72,
		home_rank: 1,
		home_match_points: 3,
		away_entry_id: 2002,
		away_net_points: 65,
		away_rank: 2,
		away_match_points: 0,
	};

	const nameMap = new Map([
		[1001, { id: 1001, entry_name: "Home Team FC", player_name: "Alice" }],
		[2002, { id: 2002, entry_name: "Away Side", player_name: "Bob" }],
	]);

	it("maps all fields correctly", () => {
		expect(mapTournamentBattleGroupResult(tournament, row, nameMap)).toEqual({
			tournament,
			matchId: 501,
			groupId: 3,
			eventId: 15,
			homeEntryId: 1001,
			homeEntryName: "Home Team FC",
			homePlayerName: "Alice",
			homeNetPoints: 72,
			homeRank: 1,
			homeMatchPoints: 3,
			awayEntryId: 2002,
			awayEntryName: "Away Side",
			awayPlayerName: "Bob",
			awayNetPoints: 65,
			awayRank: 2,
			awayMatchPoints: 0,
		});
	});

	it("falls back to null names when entry is absent from the map", () => {
		const result = mapTournamentBattleGroupResult(tournament, row, new Map());
		expect(result.homeEntryName).toBeNull();
		expect(result.homePlayerName).toBeNull();
		expect(result.awayEntryName).toBeNull();
		expect(result.awayPlayerName).toBeNull();
	});

	it("handles null points and match points", () => {
		const nullRow: DbTournamentBattleGroupResultRow = {
			...row,
			home_net_points: null,
			home_rank: null,
			home_match_points: null,
			away_net_points: null,
			away_rank: null,
			away_match_points: null,
		};
		const result = mapTournamentBattleGroupResult(tournament, nullRow, nameMap);
		expect(result.homeNetPoints).toBeNull();
		expect(result.homeRank).toBeNull();
		expect(result.homeMatchPoints).toBeNull();
		expect(result.awayNetPoints).toBeNull();
		expect(result.awayRank).toBeNull();
		expect(result.awayMatchPoints).toBeNull();
	});

	it("homeMatchPoints + awayMatchPoints equals 3 for a win/loss row", () => {
		const result = mapTournamentBattleGroupResult(tournament, row, nameMap);
		expect(result.homeMatchPoints! + result.awayMatchPoints!).toBe(3);
	});

	it("homeMatchPoints + awayMatchPoints equals 2 for a draw row", () => {
		const drawRow: DbTournamentBattleGroupResultRow = {
			...row,
			home_match_points: 1,
			away_match_points: 1,
		};
		const result = mapTournamentBattleGroupResult(tournament, drawRow, nameMap);
		expect(result.homeMatchPoints! + result.awayMatchPoints!).toBe(2);
	});
});

describe("tournamentsRepository.getTournamentEntryIdsUncached", () => {
	it("bypasses a stale cached roster", async () => {
		let membershipReads = 0;
		let readinessReads = 0;
		const membershipQuery = {
			select() {
				return membershipQuery;
			},
			async eq() {
				membershipReads += 1;
				return {
					data: [{ entry_id: 101 }, { entry_id: 202 }],
					error: null,
				};
			},
		};
		const readinessQuery = {
			select() {
				return readinessQuery;
			},
			eq() {
				readinessReads += 1;
				return readinessQuery;
			},
			async limit() {
				return {
					data: [{ standings_ready_at: "2026-04-21T00:00:00.000Z", setup_status: "ready" }],
					error: null,
				};
			},
		};
		const cache = new Map<string, string>([
			[testCacheKey("tournaments:entry-ids:7"), JSON.stringify([999])],
		]);
		const context = {
			database: {
				query: async () => {
					throw new Error("Unexpected database query");
				},
			} as never,
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			data: {
				read(table: string) {
					return table === "competition.tournaments" ? readinessQuery : membershipQuery;
				},
			},
			redis: {
				async get(key: string) {
					return cache.get(key) ?? null;
				},
				async set(key: string, value: string) {
					cache.set(key, value);
					return "OK";
				},
				async del(key: string) {
					cache.delete(key);
					return 1;
				},
			},
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			},
		} as unknown as GraphQLContext;

		expect(await tournamentsRepository.getTournamentEntryIds(context, 7)).toEqual([999]);
		expect(membershipReads).toBe(0);
		expect(readinessReads).toBe(1);
		expect(await tournamentsRepository.getTournamentEntryIdsUncached(context, 7)).toEqual([
			101, 202,
		]);
		expect(membershipReads).toBe(1);
	});

	it("does not reuse or repopulate a roster cache before standings publish", async () => {
		let membershipReads = 0;
		const cache = new Map<string, string>([
			[testCacheKey("tournaments:entry-ids:7"), JSON.stringify([999])],
		]);
		const membershipQuery = {
			select() {
				return membershipQuery;
			},
			async eq() {
				membershipReads += 1;
				return { data: [{ entry_id: 101 }, { entry_id: 202 }], error: null };
			},
		};
		const readinessQuery = {
			select() {
				return readinessQuery;
			},
			eq() {
				return readinessQuery;
			},
			async limit() {
				return { data: [{ standings_ready_at: null, setup_status: "processing" }], error: null };
			},
		};
		const context = {
			database: {
				query: async () => {
					throw new Error("Unexpected database query");
				},
			} as never,
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			data: {
				read(table: string) {
					return table === "competition.tournaments" ? readinessQuery : membershipQuery;
				},
			},
			redis: {
				async get(key: string) {
					return cache.get(key) ?? null;
				},
				async set(key: string, value: string) {
					cache.set(key, value);
					return "OK";
				},
				async del(key: string) {
					cache.delete(key);
					return 1;
				},
			},
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			},
		} as unknown as GraphQLContext;

		expect(await tournamentsRepository.getTournamentEntryIds(context, 7)).toEqual([101, 202]);
		expect(membershipReads).toBe(1);
		expect(cache.has(testCacheKey("tournaments:entry-ids:7"))).toBe(false);
	});
});

describe("tournamentsRepository.getEntryTournaments", () => {
	it("caches setup-era tournament metadata only for a short TTL", async () => {
		const updatedAt = "2026-04-21T00:00:00.000Z";
		const row: DbTournamentInfoRow = {
			id: 7,
			name: "Setting Up League",
			creator: "alice",
			admin_entry_id: 1001,
			league_id: 999,
			league_type: "classic",
			total_team_num: 2,
			tournament_mode: "normal",
			group_mode: null,
			group_team_num: null,
			group_num: null,
			group_started_event_id: null,
			group_ended_event_id: null,
			group_auto_averages: false,
			group_rounds: null,
			group_play_against_num: null,
			group_qualify_num: null,
			knockout_mode: null,
			knockout_team_num: null,
			knockout_rounds: null,
			knockout_event_num: null,
			knockout_started_event_id: null,
			knockout_ended_event_id: null,
			knockout_play_against_num: null,
			state: "active",
			setup_status: "processing",
			setup_phase: "syncing_entries",
			standings_ready_at: null,
			created_at: updatedAt,
			updated_at: updatedAt,
		};
		const cache = new Map<string, string>();
		let cacheWrites = 0;
		let cacheTtl: number | undefined;
		const membershipQuery = {
			select() {
				return membershipQuery;
			},
			async eq() {
				return { data: [{ tournament_id: 7 }], error: null };
			},
		};
		const infoQuery = {
			select() {
				return infoQuery;
			},
			in() {
				return infoQuery;
			},
			async order() {
				return { data: [row], error: null };
			},
		};
		const context = {
			database: {
				query: async () => {
					throw new Error("Unexpected database query");
				},
			} as never,
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			data: {
				read(table: string) {
					return table === "competition.tournaments" ? infoQuery : membershipQuery;
				},
			},
			redis: {
				async get(key: string) {
					return cache.get(key) ?? null;
				},
				async set(key: string, value: string, _mode?: string, ttl?: number) {
					cacheWrites += 1;
					cacheTtl = ttl;
					cache.set(key, value);
					return "OK";
				},
				async del(key: string) {
					cache.delete(key);
					return 1;
				},
			},
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			},
		} as unknown as GraphQLContext;

		const result = await tournamentsRepository.getEntryTournaments(context, 55);
		expect(result).toHaveLength(1);
		expect(result[0]?.standingsReadyAt).toBeNull();
		expect(cacheWrites).toBe(1);
		expect(cacheTtl).toBe(15);
		expect(cache.has(testCacheKey("tournaments:entry:55"))).toBe(true);

		const cachedResult = await tournamentsRepository.getEntryTournaments(context, 55);
		expect(cachedResult).toHaveLength(1);
		expect(cacheWrites).toBe(1);
	});
});

describe("tournamentsRepository.getTournamentBattleGroupResults", () => {
	const buildContext = (options: {
		battleGroupData?: unknown[];
		tournamentData?: unknown[];
		tournamentEntriesData?: unknown[];
		entryInfosData?: unknown[];
		battleGroupError?: unknown;
		cacheSeed?: string | null;
	}): GraphQLContext & { __redisState: Map<string, string> } => {
		const redisState = new Map<string, string>();
		if (options.cacheSeed !== undefined && options.cacheSeed !== null) {
			redisState.set(
				testCacheKey(`tournaments:battle-results:{"eventId":15,"tournamentId":7}`),
				options.cacheSeed
			);
		}

		const makeBuilder = (table: string) => {
			const actions: Array<{ type: string; args: unknown[] }> = [];

			const resolveResult = () => {
				if (table === "competition.tournament_battle_group_results") {
					return {
						data: options.battleGroupData ?? [],
						error: options.battleGroupError ?? null,
					};
				}
				if (table === "competition.tournaments") {
					return { data: options.tournamentData ?? [], error: null };
				}
				if (table === "competition.tournament_entries") {
					return {
						data: filterRowsByActions(options.tournamentEntriesData ?? [], actions),
						error: null,
					};
				}
				if (table === "competition.entries") {
					return {
						data: filterRowsByActions(options.entryInfosData ?? [], actions),
						error: null,
					};
				}
				return { data: [], error: null };
			};

			let resolvePromise!: (value: ReturnType<typeof resolveResult>) => void;
			const promise = new Promise<ReturnType<typeof resolveResult>>((resolve) => {
				resolvePromise = resolve;
			});
			queueMicrotask(() => resolvePromise(resolveResult()));

			const builder = Object.assign(promise, {
				select(...args: unknown[]) {
					actions.push({ type: "select", args });
					return builder;
				},
				eq(...args: unknown[]) {
					actions.push({ type: "eq", args });
					return builder;
				},
				in(...args: unknown[]) {
					actions.push({ type: "in", args });
					return builder;
				},
				order(...args: unknown[]) {
					actions.push({ type: "order", args });
					return builder;
				},
				async limit(...args: unknown[]) {
					actions.push({ type: "limit", args });
					return resolveResult();
				},
			});

			return builder;
		};

		return {
			database: {
				query: async () => {
					throw new Error("Unexpected database query");
				},
			} as never,
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			data: { read: (table: string) => makeBuilder(table) } as never,
			redis: {
				async get(key: string) {
					return redisState.get(key) ?? null;
				},
				async set(key: string, value: string) {
					redisState.set(key, value);
					return "OK";
				},
			} as never,
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			} as never,
			user: undefined,
			__redisState: redisState,
		} as GraphQLContext & { __redisState: Map<string, string> };
	};

	const tournamentRow: DbTournamentInfoRow = {
		id: 7,
		name: "H2H League",
		creator: "tong",
		admin_entry_id: 100,
		league_id: 24221,
		league_type: "h2h",
		total_team_num: 16,
		tournament_mode: "normal",
		group_mode: "battle_races",
		group_team_num: 2,
		group_num: 8,
		group_started_event_id: 1,
		group_ended_event_id: 38,
		group_auto_averages: false,
		group_rounds: null,
		group_play_against_num: null,
		group_qualify_num: null,
		knockout_mode: null,
		knockout_team_num: null,
		knockout_rounds: null,
		knockout_event_num: null,
		knockout_started_event_id: null,
		knockout_ended_event_id: null,
		knockout_play_against_num: null,
		state: "active",
		created_at: "2026-04-21T00:00:00.000Z",
		updated_at: "2026-04-21T00:00:00.000Z",
	};

	const matchRow: DbTournamentBattleGroupResultRow = {
		id: 501,
		tournament_id: 7,
		group_id: 3,
		event_id: 15,
		home_entry_id: 1001,
		home_net_points: 72,
		home_rank: 1,
		home_match_points: 3,
		away_entry_id: 2002,
		away_net_points: 65,
		away_rank: 2,
		away_match_points: 0,
	};

	it("returns cached results without hitting PostgreSQL", async () => {
		const cached = [
			{
				tournament: mapTournamentInfo(tournamentRow),
				matchId: 501,
				groupId: 3,
				eventId: 15,
				homeEntryId: 1001,
				homeEntryName: "Cached Home",
				homePlayerName: "Alice",
				homeNetPoints: 72,
				homeRank: 1,
				homeMatchPoints: 3,
				awayEntryId: 2002,
				awayEntryName: "Cached Away",
				awayPlayerName: "Bob",
				awayNetPoints: 65,
				awayRank: 2,
				awayMatchPoints: 0,
			},
		];
		const context = buildContext({ cacheSeed: JSON.stringify(cached) });
		const result = await tournamentsRepository.getTournamentBattleGroupResults(context, 7, 15);
		expect(result).toEqual(cached);
	});

	it("returns empty array and caches it when no match rows exist", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			tournamentEntriesData: [],
			battleGroupData: [],
		});
		const result = await tournamentsRepository.getTournamentBattleGroupResults(context, 7, 15);
		expect(result).toEqual([]);
		expect(
			context.__redisState.get(
				testCacheKey(`tournaments:battle-results:{"eventId":15,"tournamentId":7}`)
			)
		).toBe(JSON.stringify([]));
	});

	it("maps rows and enriches with entry names", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			tournamentEntriesData: [
				{ tournament_id: 7, entry_id: 1001 },
				{ tournament_id: 7, entry_id: 2002 },
			],
			battleGroupData: [matchRow],
			entryInfosData: [
				{ id: 1001, entry_name: "Home Team FC", player_name: "Alice" },
				{ id: 2002, entry_name: "Away Side", player_name: "Bob" },
			],
		});
		const result = await tournamentsRepository.getTournamentBattleGroupResults(context, 7, 15);
		expect(result).toHaveLength(1);
		expect(result[0].matchId).toBe(501);
		expect(result[0].homeEntryName).toBe("Home Team FC");
		expect(result[0].awayEntryName).toBe("Away Side");
		expect(result[0].homeMatchPoints).toBe(3);
		expect(result[0].awayMatchPoints).toBe(0);
	});

	it("derives battle-result name lookups from canonical match rows", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			tournamentEntriesData: [
				{ tournament_id: 7, entry_id: 1001 },
				{ tournament_id: 7, entry_id: 2002 },
			],
			battleGroupData: [matchRow],
			entryInfosData: [
				{ id: 1001, entry_name: "Home Team FC", player_name: "Alice" },
				{ id: 2002, entry_name: "Away Side", player_name: "Bob" },
			],
		});
		context.__redisState.set(testCacheKey("tournaments:entry-ids:7"), JSON.stringify([1001]));

		const result = await tournamentsRepository.getTournamentBattleGroupResults(context, 7, 15);

		expect(result[0].homeEntryName).toBe("Home Team FC");
		expect(result[0].awayEntryName).toBe("Away Side");
	});

	it("throws on PostgreSQL error fetching match rows", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			tournamentEntriesData: [],
			battleGroupError: { message: "db error" },
		});
		await expect(
			tournamentsRepository.getTournamentBattleGroupResults(context, 7, 15)
		).rejects.toThrow("Failed to fetch tournament battle group results");
	});
});

describe("tournamentsRepository.getEntryH2HMatchResults readiness cache", () => {
	const tournamentRow = (id: number, ready: boolean): DbTournamentInfoRow => ({
		id,
		name: `Tournament ${id}`,
		creator: "owner",
		admin_entry_id: 100,
		league_id: id,
		league_type: "h2h",
		total_team_num: 2,
		tournament_mode: "normal",
		group_mode: "battle_races",
		group_team_num: 2,
		group_num: 1,
		group_started_event_id: 1,
		group_ended_event_id: 38,
		group_auto_averages: false,
		group_rounds: null,
		group_play_against_num: null,
		group_qualify_num: null,
		knockout_mode: "no_knockout",
		knockout_team_num: null,
		knockout_rounds: null,
		knockout_event_num: null,
		knockout_started_event_id: null,
		knockout_ended_event_id: null,
		knockout_play_against_num: null,
		state: "active",
		setup_status: ready ? "ready" : "processing",
		setup_phase: ready ? "ready" : "calculating_standings",
		standings_ready_at: ready ? "2026-08-04T00:00:00.000Z" : null,
		created_at: "2026-08-04T00:00:00.000Z",
		updated_at: "2026-08-04T00:00:00.000Z",
	});

	it("revalidates memberships and caches only complete H2H histories", async () => {
		const state: {
			matches: DbTournamentBattleGroupResultRow[];
			tournamentEntries: Array<{ tournament_id: number; entry_id: number }>;
			tournaments: DbTournamentInfoRow[];
		} = {
			matches: [
				{
					id: 701,
					tournament_id: 7,
					group_id: 1,
					event_id: 1,
					home_entry_id: 100,
					home_net_points: 70,
					home_rank: 1,
					home_match_points: 3,
					away_entry_id: 200,
					away_net_points: 60,
					away_rank: 2,
					away_match_points: 0,
				},
			],
			tournamentEntries: [
				{ tournament_id: 7, entry_id: 100 },
				{ tournament_id: 8, entry_id: 100 },
			],
			tournaments: [tournamentRow(7, true), tournamentRow(8, false)],
		};
		const tournamentInCalls: unknown[][] = [];
		let matchReads = 0;
		let membershipReads = 0;
		const redisState = new Map<string, string>();
		const h2hCacheKey = (tournamentIds: number[]) =>
			testCacheKey(`tournaments:entry-h2h:v3:100:${JSON.stringify(tournamentIds)}`);

		const makeBuilder = (table: string) => {
			const actions: QueryAction[] = [];
			const resolveResult = () => {
				if (table === "competition.tournament_battle_group_results") {
					matchReads += 1;
					return { data: state.matches, error: null };
				}
				if (table === "competition.tournament_entries") {
					membershipReads += 1;
					return { data: filterRowsByActions(state.tournamentEntries, actions), error: null };
				}
				if (table === "competition.tournaments") {
					return { data: filterRowsByActions(state.tournaments, actions), error: null };
				}
				if (table === "competition.entries") {
					return {
						data: [100, 200, 300].map((id) => ({
							id,
							entry_name: `Entry ${id}`,
							player_name: `Player ${id}`,
						})),
						error: null,
					};
				}
				return { data: [], error: null };
			};
			const builder = {
				select(...args: unknown[]) {
					actions.push({ type: "select", args });
					return builder;
				},
				or(...args: unknown[]) {
					actions.push({ type: "or", args });
					return builder;
				},
				eq(...args: unknown[]) {
					actions.push({ type: "eq", args });
					return builder;
				},
				order(...args: unknown[]) {
					actions.push({ type: "order", args });
					return builder;
				},
				in(...args: unknown[]) {
					actions.push({ type: "in", args });
					if (table === "competition.tournaments") tournamentInCalls.push(args);
					return builder;
				},
				then<TResult1 = ReturnType<typeof resolveResult>, TResult2 = never>(
					onfulfilled?:
						((value: ReturnType<typeof resolveResult>) => TResult1 | PromiseLike<TResult1>) | null,
					onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
				) {
					return Promise.resolve(resolveResult()).then(onfulfilled, onrejected);
				},
			};
			return builder;
		};

		const context = {
			database: {
				query: async () => {
					throw new Error("Unexpected database query");
				},
			} as never,
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "core-test",
			data: { read: (table: string) => makeBuilder(table) },
			redis: {
				async get(key: string) {
					return redisState.get(key) ?? null;
				},
				async set(key: string, value: string) {
					redisState.set(key, value);
					return "OK";
				},
				async del(key: string) {
					return redisState.delete(key) ? 1 : 0;
				},
			},
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			},
		} as unknown as GraphQLContext;

		const first = await tournamentsRepository.getEntryH2HMatchResults(context, 100);
		expect(first.map((result) => result.tournament.id)).toEqual([7]);
		expect(tournamentInCalls).toEqual([["id", [7, 8]]]);
		expect(redisState.has(h2hCacheKey([7, 8]))).toBe(false);

		state.matches.push({
			id: 801,
			tournament_id: 8,
			group_id: 1,
			event_id: 1,
			home_entry_id: 100,
			home_net_points: 65,
			home_rank: 1,
			home_match_points: 1,
			away_entry_id: 300,
			away_net_points: 65,
			away_rank: 1,
			away_match_points: 1,
		});
		state.tournaments = [tournamentRow(7, true), tournamentRow(8, true)];
		const second = await tournamentsRepository.getEntryH2HMatchResults(context, 100);
		expect(second.map((result) => result.tournament.id)).toEqual([7, 8]);
		expect(tournamentInCalls).toEqual([
			["id", [7, 8]],
			["id", [7, 8]],
		]);
		const readyCacheKey = h2hCacheKey([7, 8]);
		expect(redisState.has(readyCacheKey)).toBe(true);
		const matchReadsAfterPublication = matchReads;
		const membershipReadsAfterPublication = membershipReads;
		expect(
			(await tournamentsRepository.getEntryH2HMatchResults(context, 100)).map(
				(result) => result.tournament.id
			)
		).toEqual([7, 8]);
		expect(matchReads).toBe(matchReadsAfterPublication);
		expect(membershipReads).toBe(membershipReadsAfterPublication + 1);

		// A new membership must bypass the populated cache immediately.
		state.tournamentEntries.push({ tournament_id: 9, entry_id: 100 });
		state.matches.push({
			id: 901,
			tournament_id: 9,
			group_id: 1,
			event_id: 1,
			home_entry_id: 100,
			home_net_points: 72,
			home_rank: 1,
			home_match_points: 3,
			away_entry_id: 400,
			away_net_points: 60,
			away_rank: 2,
			away_match_points: 0,
		});
		state.tournaments.push(tournamentRow(9, true));
		const afterJoin = await tournamentsRepository.getEntryH2HMatchResults(context, 100);
		expect(afterJoin.map((result) => result.tournament.id)).toEqual([7, 8, 9]);
		expect(matchReads).toBe(matchReadsAfterPublication + 1);
		expect(redisState.has(h2hCacheKey([7, 8, 9]))).toBe(true);

		// A participant may leave after their matches are finalized. Force a
		// canonical read to prove persisted history remains visible even though
		// there are no current tournament_entries rows for that entry.
		state.tournamentEntries = [];
		tournamentInCalls.length = 0;
		const historical = await tournamentsRepository.getEntryH2HMatchResults(context, 100);
		expect(historical.map((result) => result.tournament.id)).toEqual([7, 8, 9]);
		expect(tournamentInCalls).toEqual([["id", [7, 8, 9]]]);
		expect(redisState.has(h2hCacheKey([]))).toBe(true);

		// A ready membership with no battle rows is a stable empty result.
		state.matches = [];
		state.tournamentEntries = [{ tournament_id: 7, entry_id: 100 }];
		state.tournaments = [tournamentRow(7, true)];
		expect(await tournamentsRepository.getEntryH2HMatchResults(context, 100)).toEqual([]);
		expect(redisState.get(h2hCacheKey([7]))).toBe(JSON.stringify([]));
		const matchReadsAfterEmptyPublication = matchReads;
		expect(await tournamentsRepository.getEntryH2HMatchResults(context, 100)).toEqual([]);
		expect(matchReads).toBe(matchReadsAfterEmptyPublication);
	});
});
