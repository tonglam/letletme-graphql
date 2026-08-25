import { describe, expect, it, mock } from "bun:test";
import { graphql } from "graphql";
import { movementFromRanks, type HomePersonalDesk } from "../../../src/domains/home/repository";
import {
	compactHomeMarketPulse,
	reconcileHomeOfficialH2HRanks,
	settleHomeTransfers,
} from "../../../src/domains/home/service";
import { gameweekService } from "../../../src/domains/gameweek/service";
import type { MarketPulse } from "../../../src/domains/market/repository";
import { Position } from "../../../src/domains/players/repository";
import { playersService } from "../../../src/domains/players/service";
import { schema } from "../../../src/graphql/schema";
import { LIGHTWEIGHT_CORE_FIELDS } from "../../../src/graphql/root-field-policy";
import type { GraphQLContext } from "../../../src/graphql/context";
import type { Principal } from "../../../src/infra/principal";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const principal: Principal = {
	userId: "home-user",
	source: "website",
	fplEntryId: 123,
	fplEntryVerifiedAt: "2026-08-14T00:00:00.000Z",
};

const withDurableBoardRows = (context: ReturnType<typeof buildSnapshotContext>): void => {
	context.data = {
		read: (model: string) => {
			const rows =
				model === "fpl.player_gameweek_stats"
					? Array.from({ length: 11 }, (_, index) => ({
							event_id: 1,
							element_id: index + 1,
							minutes: 90,
							in_dream_team: true,
							total_points: 20 - index,
						}))
					: [];
			const result = Promise.resolve({ data: rows, error: null });
			const builder = {
				select: () => builder,
				eq: () => builder,
				in: () => builder,
				or: () => builder,
				then: result.then.bind(result),
			};
			return builder as never;
		},
	} as never;
};

describe("Home GraphQL contracts", () => {
	it("bounds every Home market list and preserves owned-first availability", () => {
		const player = (playerId: number, selectedByPercent: number) => ({
			playerId,
			playerCode: 10_000 + playerId,
			webName: `P${playerId}`,
			teamId: 1,
			teamName: "Arsenal",
			teamShortName: "ARS",
			position: "MIDFIELDER" as const,
			price: 100,
			selectedByPercent,
		});
		const availability = Array.from({ length: 8 }, (_, index) => ({
			player: player(index + 1, index < 3 ? 0.5 : index + 1),
			status: "a",
			previousStatus: null,
			news: "",
			newsAdded: null,
			observedDate: "2026-08-14",
			chanceOfPlayingThisRound: 100,
			chanceOfPlayingNextRound: 100,
		}));
		const pulse = {
			coverage: {
				requestedDays: 14,
				observedDays: 1,
				firstDate: "2026-08-14",
				latestDate: "2026-08-14",
				missingDates: [],
				capturedAt: "2026-08-14T00:00:00.000Z",
				complete: false,
				stale: false,
			},
			mostSelected: Array.from({ length: 8 }, (_, index) => player(index + 1, 20)),
			transferMovers: [],
			availabilityUpdates: availability,
			availabilityHighlights: [],
			availabilityEvidence: availability,
			newPlayers: [],
			priceChanges: [],
		} satisfies MarketPulse;

		const compact = compactHomeMarketPulse(pulse);
		expect(compact.mostSelected).toHaveLength(5);
		expect(compact.availabilityUpdates).toHaveLength(5);
		expect(compact.availabilityUpdates.map((row) => row.player.playerId)).toEqual([4, 5, 6, 7, 8]);
	});

	it("exposes only compact league-rank fields on the Home schema", async () => {
		const result = await graphql({
			schema,
			source: `
				query {
					homePersonalDesk {
						leagueRanks { totalTeamNum officialH2H startedEvent state }
					}
				}
			`,
			contextValue: buildSnapshotContext(new TestRedis()),
		});

		expect(result.errors?.map((error) => error.message).join(" ")).toContain("Cannot query field");
		expect(result.data).toBeUndefined();
	});

	it("classifies the combined Home gameweek roots as lightweight", async () => {
		for (const field of ["homePublicBootstrap", "homePersonalDesk", "homeGameweek"]) {
			expect(LIGHTWEIGHT_CORE_FIELDS.has(field)).toBe(true);
		}
	});

	it("keeps the Home gameweek desk when one transfer section fails", async () => {
		const originalDesk = gameweekService.getGameweekDesk;
		const originalTransfersIn = playersService.getTopTransfersInEnriched;
		const originalTransfersOut = playersService.getTopTransfersOutEnriched;
		const player = {
			id: 1,
			code: 101,
			webName: "Safe Player",
			firstName: "Safe",
			secondName: "Player",
			teamId: 1,
			position: Position.MIDFIELDER,
			price: 75,
			startPrice: 70,
			totalPoints: 12,
			selectedByPercent: 4.5,
		};
		gameweekService.getGameweekDesk = async () => ({ eventId: 1, lifecycle: "SCHEDULED" }) as never;
		playersService.getTopTransfersInEnriched = async () => ({
			stats: [{ playerId: 1, eventId: 1, transfersInEvent: 1200, transfersOutEvent: 10 }],
			players: { 1: player },
		});
		playersService.getTopTransfersOutEnriched = async () => {
			throw new Error("transfer section unavailable");
		};

		try {
			const result = await graphql({
				schema,
				source: `
					query {
						homeGameweek(eventId: 1) {
							transfersState
							gameweekDesk { eventId lifecycle }
							topTransfersIn {
								eventId transfersInEvent transfersOutEvent
								player { id webName position price }
							}
							topTransfersOut { player { id } }
						}
					}
				`,
				contextValue: buildSnapshotContext(new TestRedis()),
			});

			expect(result.errors).toBeUndefined();
			expect(result.data?.homeGameweek).toEqual({
				transfersState: "UNAVAILABLE",
				gameweekDesk: { eventId: 1, lifecycle: "SCHEDULED" },
				topTransfersIn: [
					{
						eventId: 1,
						transfersInEvent: 1200,
						transfersOutEvent: 10,
						player: { id: 1, webName: "Safe Player", position: "MIDFIELDER", price: 75 },
					},
				],
				topTransfersOut: [],
			});
		} finally {
			gameweekService.getGameweekDesk = originalDesk;
			playersService.getTopTransfersInEnriched = originalTransfersIn;
			playersService.getTopTransfersOutEnriched = originalTransfersOut;
		}
	});

	it("keeps homeGameweek available when settled boards use durable PostgreSQL rows", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			events: baseCore.events.map((event) =>
				event.id === 1 ? { ...event, finished: true, dataChecked: true } : event
			),
		});
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)), {
			databaseQuery: async () => ({ rows: [] }),
		});
		withDurableBoardRows(context);

		const result = await graphql({
			schema,
			source: `
				query {
					homeGameweek(eventId: 1) {
						gameweekDesk {
							lifecycle boardsState liveRevision publishedAt
							dreamTeam { id }
						}

					}
				}

			`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		const homeGameweek = result.data?.homeGameweek as
			{ gameweekDesk?: { dreamTeam?: unknown[] } } | undefined;
		expect(homeGameweek).toMatchObject({
			gameweekDesk: {
				lifecycle: "SETTLED",
				boardsState: "AVAILABLE",
				liveRevision: null,
				publishedAt: null,
			},
		});
		expect(homeGameweek?.gameweekDesk?.dreamTeam).toHaveLength(11);
	});

	it("marks transfer data unavailable when an enriched row has no player", () => {
		const settled = settleHomeTransfers(
			{
				status: "fulfilled",
				value: {
					stats: [{ playerId: 1, eventId: 1, transfersInEvent: 1, transfersOutEvent: 0 }],
					players: {},
				},
			},
			{ status: "fulfilled", value: { stats: [], players: {} } }
		);
		expect(settled).toEqual({
			topTransfersIn: [],
			topTransfersOut: [],
			transfersState: "UNAVAILABLE",
		});
	});

	it("rejects an out-of-range Home market window before querying", async () => {
		const result = await graphql({
			schema,
			source: "query { homeMarketPulse(days: 31) { coverage { requestedDays } } }",
			contextValue: buildSnapshotContext(new TestRedis()),
		});

		expect(result.data).toBeNull();
		expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
	});

	it("maps rank movement without treating missing ranks as zero", () => {
		expect(movementFromRanks(3, 8)).toEqual({ direction: "UP", places: 5 });
		expect(movementFromRanks(8, 3)).toEqual({ direction: "DOWN", places: 5 });
		expect(movementFromRanks(3, 3)).toEqual({ direction: "FLAT", places: 0 });
		expect(movementFromRanks(null, 3)).toEqual({ direction: "UNKNOWN", places: null });
		expect(movementFromRanks(3, null)).toEqual({ direction: "UNKNOWN", places: null });
		expect(movementFromRanks(0, 0)).toEqual({ direction: "UNKNOWN", places: null });
		expect(movementFromRanks(-1, 3)).toEqual({ direction: "UNKNOWN", places: null });
	});

	it("maps tracked official leagues without requiring frozen tournament-roster membership", async () => {
		const databaseQuery = mock(async (text: unknown, values: unknown) => {
			const sql = String(text);
			expect(sql).toContain("FROM competition.entries");
			expect(sql).toContain("competition.entry_leagues");
			expect(sql).toContain("competition.tournaments");
			expect(sql).not.toContain("competition.tournament_entries");
			expect(sql).toContain("t.roster_mode::text = 'official_sync'");
			expect(sql).toContain("t.official_schedule_locked_at IS NOT NULL");
			expect(sql).toContain("t.setup_status::text = 'ready'");
			expect(sql).toContain("t.updated_at DESC");
			expect(sql).not.toMatch(/ORDER BY t\.tournament_id\s+LIMIT 1/);
			expect(sql).toContain("official_kind");
			expect(sql).toContain("short_name");
			expect(sql).toContain("l.started_event");
			expect(sql).toContain(
				"COALESCE(official_h2h.tournament_id, tracked.tournament_id) AS tournament_id"
			);
			expect(sql).toContain("t.roster_mode::text = 'official_sync'");
			expect(sql).toContain("t.group_mode::text = 'battle_races'");
			expect(sql).not.toContain("competition.tournament_groups");
			expect(sql).toContain("fpl.events");
			expect(sql).toContain("event.finished = TRUE AND event.data_checked = TRUE");
			expect(sql).toContain("tournament_battle_group_results");
			expect(sql).toContain("tournament_knockout_results");
			expect(values).toEqual([2026, 123]);
			return {
				rows: [
					{
						entry_id: 123,
						entry_name: "Compact XI",
						player_name: "Ada Manager",
						overall_points: 123,
						overall_rank: 456,
						team_value: 1005,
						source_checked_at: new Date(),
						league_id: 7,
						league_type: "classic",
						league_name: "Only Rank Data",
						entry_rank: 3,
						entry_last_rank: 8,
						tournament_id: 77,
					},
					{
						entry_id: 123,
						entry_name: "Compact XI",
						player_name: "Ada Manager",
						overall_points: 123,
						overall_rank: 456,
						team_value: 1005,
						source_checked_at: new Date(),
						league_id: 8,
						league_type: "h2h",
						league_name: "Current Match League",
						entry_rank: 1,
						entry_last_rank: 0,
						league_started_event: 1,
						tournament_id: 6,
						h2h_official_match_id: 2_071_743,
						h2h_event_id: 1,
						h2h_home_entry_id: 123,
						h2h_home_entry_name: "Compact XI",
						h2h_home_player_name: "Ada Manager",
						h2h_home_points: 24,
						h2h_home_is_average: false,
						h2h_away_entry_id: 31_056,
						h2h_away_entry_name: "Tong言无忌",
						h2h_away_player_name: "炸群高手 磊磊酱",
						h2h_away_points: 43,
						h2h_away_is_average: false,
						h2h_is_bye: false,
						h2h_source_checked_at: new Date("2026-08-22T20:09:19.668Z"),
						h2h_reference_event_id: 1,
						h2h_event_is_current: true,
						h2h_event_finished: false,
						h2h_event_data_checked: false,
					},
				],
			};
		});
		const context = buildSnapshotContext(new TestRedis(), { databaseQuery });
		context.principal = principal;

		const result = await graphql({
			schema,
			source: `
				query HomePersonalDesk {
					homePersonalDesk {
						entryId state entryName playerName overallPoints overallRank teamValue sourceCheckedAt
						leagueRanks {
							key name leagueType rank tournamentId movement { direction places }
							h2hMatchup {
								officialMatchId eventId isLive isFinal isBye sourceCheckedAt
								viewer { entryId entryName playerName isAverage points }
								opponent { entryId entryName playerName isAverage points }
							}
						}
					}
				}
			`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.homePersonalDesk).toMatchObject({
			entryId: 123,
			state: "READY",
			entryName: "Compact XI",
			leagueRanks: [
				{
					key: "classic:7",
					name: "Only Rank Data",
					leagueType: "CLASSIC",
					rank: 3,
					tournamentId: 77,
					movement: { direction: "UP", places: 5 },
					h2hMatchup: null,
				},
				{
					key: "h2h:8",
					name: "Current Match League",
					leagueType: "H2H",
					rank: null,
					tournamentId: 6,
					movement: { direction: "UNKNOWN", places: null },
					h2hMatchup: {
						officialMatchId: 2_071_743,
						eventId: 1,
						isLive: true,
						isFinal: false,
						isBye: false,
						viewer: {
							entryId: 123,
							entryName: "Compact XI",
							playerName: "Ada Manager",
							isAverage: false,
							points: 24,
						},
						opponent: {
							entryId: 31_056,
							entryName: "Tong言无忌",
							playerName: "炸群高手 磊磊酱",
							isAverage: false,
							points: 43,
						},
					},
				},
			],
		});
		expect(databaseQuery).toHaveBeenCalledTimes(1);
	});

	it("reconciles Home H2H ranks only from the official mirror desk", () => {
		const desk: HomePersonalDesk = {
			entryId: 123,
			state: "READY",
			entryName: "Compact XI",
			playerName: "Ada Manager",
			overallPoints: 49,
			overallRank: 90_000,
			teamValue: 1000,
			sourceCheckedAt: "2026-08-23T01:00:00.000Z",
			leagueRanks: [
				{
					key: "classic:7",
					name: "Classic",
					leagueType: "CLASSIC",
					rank: 7,
					movement: { direction: "FLAT", places: 0 },
					tournamentId: 5,
					h2hMatchup: null,
				},
				{
					key: "h2h:8",
					name: "Official H2H",
					leagueType: "H2H",
					rank: null,
					movement: { direction: "UNKNOWN", places: null },
					tournamentId: 6,
					h2hMatchup: null,
				},
				{
					key: "h2h:9",
					name: "Custom H2H",
					leagueType: "H2H",
					rank: 4,
					movement: { direction: "FLAT", places: 0 },
					tournamentId: 7,
					h2hMatchup: null,
				},
				{
					key: "h2h:10",
					name: "Waiting Official H2H",
					leagueType: "H2H",
					rank: null,
					movement: { direction: "UNKNOWN", places: null },
					tournamentId: 8,
					h2hMatchup: null,
				},
				{
					key: "h2h:11",
					name: "Settled Official H2H",
					leagueType: "H2H",
					rank: 3,
					movement: { direction: "UP", places: 2 },
					tournamentId: 9,
					h2hMatchup: null,
				},
			],
		};
		const officialDesk = [
			{
				tournamentId: 6,
				tournamentName: "Official H2H",
				totalTeams: 21,
				eventId: 1,
				awaitingSchedule: false,
				isLive: true,
				isFinal: false,
				scoreSource: "FPL_EVENT_LIVE" as const,
				scoreRevision: "live:1",
				scoreCheckedAt: "2026-08-24T06:00:00.000Z",
				rank: 2,
				lastRank: null,
				matchPoints: 3,
				standingsPublished: true,
				standingsCurrentEventComplete: true,
				match: null,
				matches: [],
			},
			{
				tournamentId: 8,
				tournamentName: "Waiting Official H2H",
				totalTeams: 21,
				eventId: 1,
				awaitingSchedule: false,
				isLive: true,
				isFinal: false,
				scoreSource: "UNAVAILABLE" as const,
				scoreRevision: null,
				scoreCheckedAt: null,
				rank: 1,
				lastRank: null,
				matchPoints: 0,
				standingsPublished: false,
				standingsCurrentEventComplete: false,
				match: null,
				matches: [],
			},
			{
				tournamentId: 9,
				tournamentName: "Settled Official H2H",
				totalTeams: 21,
				eventId: 2,
				awaitingSchedule: false,
				isLive: true,
				isFinal: false,
				scoreSource: "UNAVAILABLE" as const,
				scoreRevision: null,
				scoreCheckedAt: null,
				rank: 2,
				lastRank: 3,
				matchPoints: 3,
				standingsPublished: true,
				standingsCurrentEventComplete: false,
				match: null,
				matches: [],
			},
		];

		const reconciled = reconcileHomeOfficialH2HRanks(desk, officialDesk);

		expect(reconciled.leagueRanks).toEqual([
			desk.leagueRanks[0],
			{
				...desk.leagueRanks[1],
				rank: 2,
				movement: { direction: "UNKNOWN", places: null },
			},
			desk.leagueRanks[2],
			desk.leagueRanks[3],
			{
				...desk.leagueRanks[4],
				rank: 2,
			},
		]);
	});

	it("keeps the settled official rank during a later live event", async () => {
		const databaseQuery = mock(async () => ({
			rows: [
				{
					entry_id: 123,
					entry_name: "Compact XI",
					player_name: "Ada Manager",
					overall_points: 72,
					overall_rank: 456,
					team_value: 1000,
					source_checked_at: new Date(),
					league_id: 8,
					league_type: "h2h",
					league_name: "Tracked Snapshot H2H",
					entry_rank: 3,
					entry_last_rank: 4,
					league_started_event: 1,
					tournament_id: 6,
					h2h_reference_event_id: 2,
					h2h_event_is_current: true,
					h2h_event_finished: false,
					h2h_event_data_checked: false,
				},
			],
		}));
		const context = buildSnapshotContext(new TestRedis(), { databaseQuery });
		context.principal = principal;

		const result = await graphql({
			schema,
			source: "query { homePersonalDesk { leagueRanks { rank movement { direction places } } } }",
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.homePersonalDesk).toMatchObject({
			leagueRanks: [
				{
					rank: 3,
					movement: { direction: "UP", places: 1 },
				},
			],
		});
	});

	it("hides an H2H placeholder before the league's configured start event", async () => {
		const databaseQuery = mock(async () => ({
			rows: [
				{
					entry_id: 123,
					entry_name: "Compact XI",
					player_name: "Ada Manager",
					overall_points: 72,
					overall_rank: 123,
					team_value: 1000,
					source_checked_at: new Date(),
					league_id: 9,
					league_type: "h2h",
					league_name: "Future-start H2H",
					entry_rank: 1,
					entry_last_rank: 0,
					league_started_event: 5,
					tournament_id: null,
					h2h_reference_event_id: 4,
					h2h_event_is_current: false,
					h2h_event_finished: true,
					h2h_event_data_checked: true,
				},
			],
		}));
		const context = buildSnapshotContext(new TestRedis(), { databaseQuery });
		context.principal = principal;

		const result = await graphql({
			schema,
			source: "query { homePersonalDesk { leagueRanks { rank movement { direction places } } } }",
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.homePersonalDesk).toMatchObject({
			leagueRanks: [
				{
					rank: null,
					movement: { direction: "UNKNOWN", places: null },
				},
			],
		});
	});

	it("keeps a final-gameweek H2H rank from the latest checked event", async () => {
		const databaseQuery = mock(async () => ({
			rows: [
				{
					entry_id: 123,
					entry_name: "Compact XI",
					player_name: "Ada Manager",
					overall_points: 2400,
					overall_rank: 123,
					team_value: 1040,
					source_checked_at: new Date(),
					league_id: 10,
					league_type: "h2h",
					league_name: "Final-week H2H",
					entry_rank: 2,
					entry_last_rank: 0,
					league_started_event: 38,
					tournament_id: null,
					h2h_reference_event_id: 38,
					h2h_event_is_current: false,
					h2h_event_finished: true,
					h2h_event_data_checked: true,
				},
			],
		}));
		const context = buildSnapshotContext(new TestRedis(), { databaseQuery });
		context.principal = principal;

		const result = await graphql({
			schema,
			source: "query { homePersonalDesk { leagueRanks { rank movement { direction places } } } }",
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.homePersonalDesk).toMatchObject({
			leagueRanks: [
				{
					rank: 2,
					movement: { direction: "UNKNOWN", places: null },
				},
			],
		});
	});

	it("keeps a 100-league desk bounded to one query and sorts invitational leagues for home", async () => {
		const now = new Date();
		const databaseQuery = mock(async () => ({
			rows: Array.from({ length: 100 }, (_, index) => ({
				entry_name: "Scale XI",
				player_name: "Scale Manager",
				overall_points: 456,
				overall_rank: 789,
				team_value: 1010,
				source_checked_at: now,
				league_id: index + 1,
				league_type: index % 2 === 0 ? "classic" : "h2h",
				league_name: `League ${String(index + 1).padStart(3, "0")}`,
				entry_rank: index + 1,
				entry_last_rank: index + 2,
				tournament_id: index % 10 === 0 ? index + 10_000 : null,
			})),
		}));
		const context = buildSnapshotContext(new TestRedis(), { databaseQuery });
		context.principal = principal;

		const result = await graphql({
			schema,
			source:
				"query { homePersonalDesk { state leagueRanks { key name leagueType rank movement { direction places } tournamentId } } }",
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		const desk = result.data?.homePersonalDesk as {
			state: string;
			leagueRanks: Array<{ key: string; name: string }>;
		};
		expect(desk.state).toBe("READY");
		expect(desk.leagueRanks).toHaveLength(100);
		expect(desk.leagueRanks[0]).toMatchObject({
			key: "classic:1",
			name: "League 001",
		});
		expect(desk.leagueRanks[99]).toMatchObject({
			key: "h2h:100",
			name: "League 100",
		});
		expect(databaseQuery).toHaveBeenCalledTimes(1);
	});

	it("omits official system and broadcaster leagues from the home preview", async () => {
		const databaseQuery = mock(async () => ({
			rows: [
				{
					entry_name: "WhoamI FC",
					player_name: "Tong W",
					overall_points: 1856,
					overall_rank: 12580,
					team_value: 1035,
					source_checked_at: new Date(),
					league_id: 314,
					league_type: "classic",
					league_name: "Overall",
					entry_rank: 12580,
					entry_last_rank: 12600,
					official_kind: "s",
					short_name: "overall",
					tournament_id: null,
				},
				{
					entry_name: "WhoamI FC",
					player_name: "Tong W",
					overall_points: 1856,
					overall_rank: 12580,
					team_value: 1035,
					source_checked_at: new Date(),
					league_id: 317,
					league_type: "classic",
					league_name: "Stan Sport League",
					entry_rank: 80,
					entry_last_rank: 90,
					official_kind: "s",
					short_name: "brd-stan",
					tournament_id: null,
				},
				{
					entry_name: "WhoamI FC",
					player_name: "Tong W",
					overall_points: 1856,
					overall_rank: 12580,
					team_value: 1035,
					source_checked_at: new Date(),
					league_id: 9002,
					league_type: "classic",
					league_name: "Office League",
					entry_rank: 1,
					entry_last_rank: 2,
					official_kind: "x",
					short_name: null,
					tournament_id: 12,
				},
				{
					entry_name: "WhoamI FC",
					player_name: "Tong W",
					overall_points: 1856,
					overall_rank: 12580,
					team_value: 1035,
					source_checked_at: new Date(),
					league_id: 9001,
					league_type: "classic",
					league_name: "Friends League",
					entry_rank: 3,
					entry_last_rank: 4,
					official_kind: "x",
					short_name: null,
					tournament_id: 11,
				},
			],
		}));
		const context = buildSnapshotContext(new TestRedis(), { databaseQuery });
		context.principal = principal;

		const result = await graphql({
			schema,
			source: "query { homePersonalDesk { state leagueRanks { key name rank } } }",
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.homePersonalDesk).toMatchObject({
			state: "READY",
			leagueRanks: [
				{ key: "classic:9001", name: "Friends League", rank: 3 },
				{ key: "classic:9002", name: "Office League", rank: 1 },
			],
		});
	});

	it("returns a typed empty desk and preserves stale data", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						entry_name: "Stale XI",
						player_name: "Manager",
						overall_points: 10,
						overall_rank: 20,
						team_value: 1000,
						source_checked_at: new Date(Date.now() - 31 * 60 * 60 * 1000),
						league_id: null,
						league_type: null,
						league_name: null,
						entry_rank: null,
						entry_last_rank: null,
						tournament_id: null,
					},
				],
			}),
		});
		context.principal = principal;

		const result = await graphql({
			schema,
			source: "query { homePersonalDesk { state entryName leagueRanks { key } } }",
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.homePersonalDesk).toEqual({
			state: "STALE",
			entryName: "Stale XI",
			leagueRanks: [],
		});
	});

	it("distinguishes a fresh empty league snapshot from an unavailable entry", async () => {
		const freshEmpty = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						entry_name: "No Leagues XI",
						player_name: "Manager",
						overall_points: 10,
						overall_rank: 20,
						team_value: 1000,
						source_checked_at: new Date(),
						league_id: null,
						league_type: null,
						league_name: null,
						entry_rank: null,
						entry_last_rank: null,
						tournament_id: null,
					},
				],
			}),
		});
		freshEmpty.principal = principal;
		const emptyResult = await graphql({
			schema,
			source: "query { homePersonalDesk { state leagueRanks { key } } }",
			contextValue: freshEmpty,
		});
		expect(emptyResult.data?.homePersonalDesk).toEqual({
			state: "EMPTY",
			leagueRanks: [],
		});

		const unavailable = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [] }),
		});
		unavailable.principal = principal;
		const unavailableResult = await graphql({
			schema,
			source: "query { homePersonalDesk { state leagueRanks { key } } }",
			contextValue: unavailable,
		});
		expect(unavailableResult.data?.homePersonalDesk).toEqual({
			state: "UNAVAILABLE",
			leagueRanks: [],
		});
	});

	it("defensively rejects a direct resolver call without a principal", async () => {
		const context = buildSnapshotContext(new TestRedis());
		const result = await graphql({
			schema,
			source: "query { homePersonalDesk { state } }",
			contextValue: context,
		});

		expect(result.data).toBeNull();
		expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
	});

	it("returns next-event fixtures from the same public core revision", async () => {
		const core = buildTestCoreData(null);
		const context = buildSnapshotContext(
			new TestRedis(buildCorePublication("2627", 7, core))
		) as GraphQLContext;
		const result = await graphql({
			schema,
			source: `
				query HomePublicBootstrap {
					homePublicBootstrap {
						context { season revision currentEventId nextEventId nextDeadlineTime }
						fixtures {
							id finished kickoffTime
							homeTeam { id name shortName }
							awayTeam { id name shortName }
							homeScore awayScore
						}
					}
				}
			`,
			contextValue: context,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.homePublicBootstrap).toMatchObject({
			context: { season: "2627", revision: "7", currentEventId: null, nextEventId: 1 },
		});
		expect(
			(result.data?.homePublicBootstrap as { fixtures: Array<{ id: number }> }).fixtures.length
		).toBeGreaterThan(0);
	});
});
