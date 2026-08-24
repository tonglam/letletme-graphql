import { describe, expect, it } from "bun:test";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import { LeagueType } from "../../../src/domains/leagues/repository";
import {
	type DbTournamentBattleGroupResultRow,
	type DbTournamentEntryRow,
	type DbTournamentInfoRow,
	type DbTournamentPointsGroupResultRow,
	type OfficialH2HSnapshotLoad,
	type TournamentEventResult,
	extractTournamentIds,
	GroupMode,
	KnockoutMode,
	mapTournamentBattleGroupResult,
	mapTournamentEventResult,
	mapTournamentInfo,
	projectHistoricalOfficialH2HStandings,
	projectOfficialH2HEventLiveSnapshot,
	projectOfficialH2HStandingsFromResults,
	resolveOfficialH2HReferenceEventId,
	TournamentMode,
	TournamentRosterMode,
	TournamentSetupPhase,
	TournamentSetupProgressMode,
	TournamentSetupStatus,
	TournamentState,
	tournamentCacheTestables,
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
		key.startsWith("tournaments:") ? `tournaments:v2:${key.slice("tournaments:".length)}` : key
	);

const activeOfficialH2HLoad = (): OfficialH2HSnapshotLoad => ({
	snapshot: {
		tournament: {
			id: 9,
			name: "Official H2H",
			totalTeamNum: 2,
			knockoutTeamNum: 2,
			knockoutEventNum: 1,
			knockoutStartedEventId: 1,
		} as OfficialH2HSnapshotLoad["snapshot"]["tournament"],
		eventId: 1,
		awaitingSchedule: false,
		scoreSource: "UNAVAILABLE",
		scoreRevision: null,
		scoreCheckedAt: null,
		standings: [
			{
				entryId: 101,
				entryName: "Entry 101",
				playerName: "Manager 101",
				rank: 1,
				matchPoints: 3,
				played: 1,
				won: 1,
				drawn: 0,
				lost: 0,
				pointsFor: 23,
			},
			{
				entryId: 102,
				entryName: "Entry 102",
				playerName: "Manager 102",
				rank: 2,
				matchPoints: 0,
				played: 1,
				won: 0,
				drawn: 0,
				lost: 1,
				pointsFor: 19,
			},
		],
		matches: [
			{
				officialMatchId: 7001,
				eventId: 1,
				sourceOrder: 1,
				phase: "REGULAR",
				knockoutName: null,
				isBye: false,
				home: {
					entryId: 101,
					entryName: "Entry 101",
					playerName: "Manager 101",
					isAverage: false,
					points: 23,
					matchPoints: 3,
				},
				away: {
					entryId: 102,
					entryName: "Entry 102",
					playerName: "Manager 102",
					isAverage: false,
					points: 19,
					matchPoints: 0,
				},
				winnerEntryId: 101,
				tiebreak: null,
				sourceCheckedAt: "2026-08-24T00:00:00.000Z",
			},
		],
	},
	history: [
		{
			id: 7001,
			tournament_id: 9,
			group_id: 1,
			event_id: 1,
			home_entry_id: 101,
			home_net_points: 23,
			home_rank: null,
			home_match_points: 3,
			away_entry_id: 102,
			away_net_points: 19,
			away_rank: null,
			away_match_points: 0,
			official_match_id: 7001,
			source_order: 1,
			home_is_average: false,
			away_is_average: false,
			is_bye: false,
			source_checked_at: "2026-08-24T00:00:00.000Z",
		},
	],
	standingsPublished: true,
	currentEventComplete: true,
	validatedFinalizedEventIds: new Set(),
});

describe("projectOfficialH2HEventLiveSnapshot", () => {
	it("replaces a lagging official H2H score with one coherent event-live batch", () => {
		const projected = projectOfficialH2HEventLiveSnapshot(
			activeOfficialH2HLoad(),
			1,
			{
				scores: new Map([
					[101, 37],
					[102, 31],
				]),
				revision: "event-live-gw1-r8",
				checkedAt: "2026-08-24T00:01:00.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot).toMatchObject({
			scoreSource: "FPL_EVENT_LIVE",
			scoreRevision: "event-live-gw1-r8",
			scoreCheckedAt: "2026-08-24T00:01:00.000Z",
			matches: [
				{
					home: { entryId: 101, points: 37, matchPoints: 3 },
					away: { entryId: 102, points: 31, matchPoints: 0 },
					winnerEntryId: 101,
				},
			],
		});
		expect(projected.snapshot.standings).toEqual([
			expect.objectContaining({ entryId: 101, matchPoints: 3, pointsFor: 37 }),
			expect.objectContaining({ entryId: 102, matchPoints: 0, pointsFor: 31 }),
		]);
	});

	it("fails the whole active H2H round closed when one manager score is missing", () => {
		const projected = projectOfficialH2HEventLiveSnapshot(
			activeOfficialH2HLoad(),
			1,
			{
				scores: new Map([[101, 37]]),
				revision: "event-live-gw1-r8",
				checkedAt: "2026-08-24T00:01:00.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot.scoreSource).toBe("UNAVAILABLE");
		expect(projected.snapshot.matches[0]).toMatchObject({
			home: { points: null, matchPoints: null },
			away: { points: null, matchPoints: null },
			winnerEntryId: null,
		});
		expect(projected.snapshot.standings.every((standing) => standing.played === 0)).toBe(true);
	});

	it("accepts an all-zero event-live batch without treating it as missing", () => {
		const projected = projectOfficialH2HEventLiveSnapshot(
			activeOfficialH2HLoad(),
			1,
			{
				scores: new Map([
					[101, 0],
					[102, 0],
				]),
				revision: "event-live-gw1-r9",
				checkedAt: "2026-08-24T00:02:00.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot.scoreSource).toBe("FPL_EVENT_LIVE");
		expect(projected.snapshot.matches[0]).toMatchObject({
			home: { points: 0, matchPoints: 1 },
			away: { points: 0, matchPoints: 1 },
			winnerEntryId: null,
		});
	});

	it("fails closed when the loaded H2H roster is truncated", () => {
		const loaded = activeOfficialH2HLoad();
		loaded.snapshot.tournament.totalTeamNum = 3;
		const projected = projectOfficialH2HEventLiveSnapshot(
			loaded,
			1,
			{
				scores: new Map([
					[101, 37],
					[102, 31],
				]),
				revision: "event-live-gw1-r10",
				checkedAt: "2026-08-24T00:03:00.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot.scoreSource).toBe("UNAVAILABLE");
		expect(projected.snapshot.matches[0]?.home.points).toBeNull();
	});

	it("does not stamp an invalid finalized H2H round as official", () => {
		const loaded = activeOfficialH2HLoad();
		loaded.currentEventComplete = false;
		const projected = projectOfficialH2HEventLiveSnapshot(
			loaded,
			1,
			{
				scores: new Map([
					[101, 37],
					[102, 31],
				]),
				revision: "event-live-gw1-r11",
				checkedAt: "2026-08-24T00:04:00.000Z",
				state: "settled",
			},
			new Set([1])
		);

		expect(projected.snapshot.scoreSource).toBe("UNAVAILABLE");
		expect(projected.snapshot.scoreRevision).toBeNull();
		expect(projected.snapshot.matches[0]?.winnerEntryId).toBeNull();
	});

	it("does not mix an Average Team H2H score into an event-live revision", () => {
		const loaded = activeOfficialH2HLoad();
		const row = loaded.history[0]!;
		row.away_entry_id = null;
		row.away_is_average = true;
		loaded.snapshot.matches[0]!.away.entryId = null;
		loaded.snapshot.matches[0]!.away.isAverage = true;
		const projected = projectOfficialH2HEventLiveSnapshot(
			loaded,
			1,
			{
				scores: new Map([
					[101, 37],
					[102, 31],
				]),
				revision: "event-live-gw1-r12",
				checkedAt: "2026-08-24T00:05:00.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot.scoreSource).toBe("UNAVAILABLE");
		expect(projected.snapshot.matches[0]?.away.points).toBeNull();
	});

	it("uses the event-live batch for an active knockout-only round", () => {
		const loaded = activeOfficialH2HLoad();
		loaded.history = [];
		loaded.currentEventComplete = false;
		loaded.snapshot.matches[0] = {
			...loaded.snapshot.matches[0]!,
			phase: "KNOCKOUT",
			knockoutName: "Final",
		};

		const projected = projectOfficialH2HEventLiveSnapshot(
			loaded,
			1,
			{
				scores: new Map([
					[101, 37],
					[102, 31],
				]),
				revision: "event-live-gw1-knockout",
				checkedAt: "2026-08-24T00:06:00.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot).toMatchObject({
			scoreSource: "FPL_EVENT_LIVE",
			scoreRevision: "event-live-gw1-knockout",
			matches: [
				{
					phase: "KNOCKOUT",
					home: { points: 37, matchPoints: 3 },
					away: { points: 31, matchPoints: 0 },
					winnerEntryId: 101,
				},
			],
		});
	});

	it("preserves a deterministic knockout bye winner during the live overlay", () => {
		const loaded = activeOfficialH2HLoad();
		loaded.history = [];
		loaded.snapshot.matches[0] = {
			...loaded.snapshot.matches[0]!,
			phase: "KNOCKOUT",
			knockoutName: "Final",
			isBye: true,
			away: {
				...loaded.snapshot.matches[0]!.away,
				entryId: null,
				points: null,
				matchPoints: null,
			},
			winnerEntryId: null,
		};

		const projected = projectOfficialH2HEventLiveSnapshot(
			loaded,
			1,
			{
				scores: new Map([[101, 37]]),
				revision: "event-live-gw1-bye",
				checkedAt: "2026-08-24T00:06:30.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot.matches[0]).toMatchObject({
			isBye: true,
			home: { entryId: 101, points: 37, matchPoints: null },
			away: { entryId: null, points: null, matchPoints: null },
			winnerEntryId: 101,
		});
	});

	it("defers a multi-event knockout winner until the aggregate is finalized", () => {
		const loaded = activeOfficialH2HLoad();
		loaded.history = [];
		loaded.snapshot.tournament = {
			...loaded.snapshot.tournament,
			knockoutMode: KnockoutMode.DOUBLE_ELIMINATION,
			knockoutRounds: 2,
			knockoutEventNum: 1,
			knockoutPlayAgainstNum: 2,
		};
		loaded.snapshot.matches[0] = {
			...loaded.snapshot.matches[0]!,
			phase: "KNOCKOUT",
			knockoutName: "Final",
		};

		const projected = projectOfficialH2HEventLiveSnapshot(
			loaded,
			1,
			{
				scores: new Map([
					[101, 37],
					[102, 31],
				]),
				revision: "event-live-gw1-first-leg",
				checkedAt: "2026-08-24T00:06:45.000Z",
				state: "live",
			},
			new Set()
		);

		expect(projected.snapshot.matches[0]).toMatchObject({
			home: { points: 37, matchPoints: null },
			away: { points: 31, matchPoints: null },
			winnerEntryId: null,
		});
	});

	it("accepts a complete finalized knockout-only round", () => {
		const knockout = {
			tournament_id: 9,
			event_id: 1,
			home_entry_id: 101,
			home_net_points: 37,
			away_entry_id: 102,
			away_net_points: 31,
			match_winner: 101,
			official_match_id: 7001,
			source_order: 1,
			knockout_name: "Final",
			tiebreak: null,
			source_checked_at: "2026-08-24T00:07:00.000Z",
		};

		expect(
			tournamentCacheTestables.officialH2HCurrentEventIsComplete(
				false,
				[],
				[knockout],
				1,
				new Set([1]),
				{
					knockoutTeamNum: 2,
					knockoutEventNum: 1,
					knockoutStartedEventId: 1,
				}
			)
		).toBe(true);
	});

	it("rejects an incrementally published partial semifinal round", () => {
		const firstSemifinal = {
			tournament_id: 9,
			event_id: 1,
			home_entry_id: 101,
			home_net_points: 37,
			away_entry_id: 102,
			away_net_points: 31,
			match_winner: 101,
			official_match_id: 7001,
			source_order: 1,
			knockout_name: "Semi-finals",
			tiebreak: null,
			source_checked_at: "2026-08-24T00:07:00.000Z",
		};
		const config = {
			knockoutTeamNum: 4,
			knockoutEventNum: 2,
			knockoutStartedEventId: 1,
		};

		expect(
			tournamentCacheTestables.officialH2HCurrentEventIsComplete(
				false,
				[],
				[firstSemifinal],
				1,
				new Set([1]),
				config
			)
		).toBe(false);
		expect(
			tournamentCacheTestables.officialH2HCurrentEventIsComplete(
				false,
				[],
				[
					firstSemifinal,
					{
						...firstSemifinal,
						home_entry_id: 103,
						away_entry_id: 104,
						match_winner: 103,
						official_match_id: 7002,
						source_order: 2,
					},
				],
				1,
				new Set([1]),
				config
			)
		).toBe(true);
	});

	it("accepts a complete multi-event final using bracket-round cardinality", () => {
		const final = {
			tournament_id: 9,
			event_id: 5,
			home_entry_id: 101,
			home_net_points: 37,
			away_entry_id: 102,
			away_net_points: 31,
			match_winner: 101,
			official_match_id: 7001,
			source_order: 1,
			knockout_name: "Final",
			tiebreak: null,
			source_checked_at: "2026-08-24T00:07:00.000Z",
		};
		const common = {
			knockoutMode: KnockoutMode.DOUBLE_ELIMINATION,
			knockoutTeamNum: 8,
			knockoutStartedEventId: 1,
			knockoutPlayAgainstNum: 2,
		};

		for (const config of [
			{ ...common, knockoutRounds: 3, knockoutEventNum: 6 },
			{ ...common, knockoutRounds: 6, knockoutEventNum: 3 },
		]) {
			expect(
				tournamentCacheTestables.officialH2HCurrentEventIsComplete(
					false,
					[],
					[final],
					5,
					new Set([5]),
					config
				)
			).toBe(true);
		}
	});

	it("requires one source marker across a combined finalized round", () => {
		const battle: DbTournamentBattleGroupResultRow = {
			id: 7000,
			tournament_id: 9,
			group_id: 1,
			event_id: 1,
			home_entry_id: 201,
			home_net_points: 22,
			home_rank: null,
			home_match_points: 3,
			away_entry_id: 202,
			away_net_points: 18,
			away_rank: null,
			away_match_points: 0,
			source_checked_at: "2026-08-24T00:07:00.000Z",
		};
		const knockout = {
			tournament_id: 9,
			event_id: 1,
			home_entry_id: 101,
			home_net_points: 37,
			away_entry_id: 102,
			away_net_points: 31,
			match_winner: 101,
			official_match_id: 7001,
			source_order: 1,
			knockout_name: "Final",
			tiebreak: null,
			source_checked_at: "2026-08-24T00:08:00.000Z",
		};
		const config = {
			knockoutTeamNum: 2,
			knockoutRounds: 1,
			knockoutEventNum: 1,
			knockoutStartedEventId: 1,
		};

		expect(
			tournamentCacheTestables.officialH2HCurrentEventIsComplete(
				true,
				[battle],
				[knockout],
				1,
				new Set([1]),
				config
			)
		).toBe(false);
		expect(
			tournamentCacheTestables.officialH2HCurrentEventIsComplete(
				true,
				[battle],
				[{ ...knockout, source_checked_at: battle.source_checked_at ?? null }],
				1,
				new Set([1]),
				config
			)
		).toBe(true);
	});

	it("does not restore rejected finalized history while suppressing an active round", () => {
		const loaded = activeOfficialH2HLoad();
		loaded.validatedFinalizedEventIds = new Set();
		const suppressed = tournamentCacheTestables.suppressActiveOfficialH2HScores(
			loaded,
			2,
			new Set([1])
		);

		expect(suppressed.snapshot.standings).toEqual([
			expect.objectContaining({ entryId: 101, played: 0, matchPoints: 0 }),
			expect.objectContaining({ entryId: 102, played: 0, matchPoints: 0 }),
		]);
	});
});

describe("applyActiveOfficialH2HScoreAuthority", () => {
	it("isolates event-live score acquisition per tournament", async () => {
		const first = activeOfficialH2HLoad();
		const second = activeOfficialH2HLoad();
		second.snapshot.tournament = { ...second.snapshot.tournament, id: 10 };
		const replaceEntryId = (entryId: number | null): number | null =>
			entryId === 101 ? 201 : entryId === 102 ? 202 : entryId;
		second.snapshot.standings = second.snapshot.standings.map((standing) => ({
			...standing,
			entryId: replaceEntryId(standing.entryId)!,
		}));
		second.snapshot.matches = second.snapshot.matches.map((match) => ({
			...match,
			home: { ...match.home, entryId: replaceEntryId(match.home.entryId) },
			away: { ...match.away, entryId: replaceEntryId(match.away.entryId) },
			winnerEntryId: replaceEntryId(match.winnerEntryId),
		}));
		second.history = second.history.map((row) => ({
			...row,
			tournament_id: 10,
			home_entry_id: replaceEntryId(row.home_entry_id),
			away_entry_id: replaceEntryId(row.away_entry_id),
		}));

		const original = entryLiveBatchService.calcLivePointsForEntries;
		const calls: number[][] = [];
		let lineupRevision = "lineup-a";
		entryLiveBatchService.calcLivePointsForEntries = async (_context, _eventId, entryIds) => {
			calls.push([...entryIds]);
			if (entryIds.includes(201)) throw new Error("second tournament unavailable");
			const checkedAt = "2026-08-24T00:08:00.000Z";
			return {
				results: new Map(
					entryIds.map((entryId, index) => [
						entryId,
						{
							score: {
								revision: `event-live:8:${entryId}:${lineupRevision}`,
								checkedAt,
								source: "FPL_EVENT_LIVE",
								state: "FRESH",
								netEventPoints: 37 - index * 6,
							},
							snapshot: { revision: "8", checkedAt, state: "live" },
						} as never,
					])
				),
				errors: [],
				meta: {
					eventId: 1,
					totalEntries: entryIds.length,
					succeededCount: entryIds.length,
					failedCount: 0,
				},
			};
		};

		try {
			const projected = await tournamentCacheTestables.applyActiveOfficialH2HScoreAuthority(
				{ logger: { warn: () => undefined } } as never,
				new Map([
					[9, first],
					[10, second],
				]),
				1,
				new Set()
			);

			expect(calls.map((entryIds) => entryIds.join(",")).sort()).toEqual(["101,102", "201,202"]);
			expect(projected.get(9)?.snapshot.scoreSource).toBe("FPL_EVENT_LIVE");
			expect(projected.get(10)?.snapshot.scoreSource).toBe("UNAVAILABLE");
			const firstRevision = projected.get(9)?.snapshot.scoreRevision;
			expect(firstRevision).toMatch(/^event-live-h2h:1:[0-9a-f]{24}$/);

			lineupRevision = "lineup-b";
			const refreshed = await tournamentCacheTestables.applyActiveOfficialH2HScoreAuthority(
				{ logger: { warn: () => undefined } } as never,
				new Map([[9, first]]),
				1,
				new Set()
			);
			expect(refreshed.get(9)?.snapshot.scoreRevision).not.toBe(firstRevision);
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = original;
		}
	});
});

describe("projectHistoricalOfficialH2HStandings", () => {
	it("ranks saved official results by match points then Points For with shared ranks", () => {
		const rows: DbTournamentBattleGroupResultRow[] = [
			{
				id: 1,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 50,
				home_rank: null,
				home_match_points: 3,
				away_entry_id: 102,
				away_net_points: 40,
				away_rank: null,
				away_match_points: 0,
			},
			{
				id: 2,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 103,
				home_net_points: 50,
				home_rank: null,
				home_match_points: 3,
				away_entry_id: null,
				away_net_points: 40,
				away_rank: null,
				away_match_points: 0,
				home_is_average: false,
				away_is_average: true,
			},
		];

		expect(projectHistoricalOfficialH2HStandings([101, 102, 103, 104], rows)).toEqual([
			{
				entryId: 101,
				rank: 1,
				matchPoints: 3,
				played: 1,
				won: 1,
				drawn: 0,
				lost: 0,
				pointsFor: 50,
			},
			{
				entryId: 103,
				rank: 1,
				matchPoints: 3,
				played: 1,
				won: 1,
				drawn: 0,
				lost: 0,
				pointsFor: 50,
			},
			{
				entryId: 102,
				rank: 3,
				matchPoints: 0,
				played: 1,
				won: 0,
				drawn: 0,
				lost: 1,
				pointsFor: 40,
			},
			{ entryId: 104, rank: 4, matchPoints: 0, played: 0, won: 0, drawn: 0, lost: 0, pointsFor: 0 },
		]);
	});

	it("derives match outcomes from published scores when stored outcome fields are null", () => {
		const rows: DbTournamentBattleGroupResultRow[] = [
			{
				id: 3,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 24,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 43,
				away_rank: null,
				away_match_points: null,
			},
		];

		expect(projectOfficialH2HStandingsFromResults([101, 102], rows)).toEqual([
			{
				entryId: 102,
				rank: 1,
				matchPoints: 3,
				played: 1,
				won: 1,
				drawn: 0,
				lost: 0,
				pointsFor: 43,
			},
			{
				entryId: 101,
				rank: 2,
				matchPoints: 0,
				played: 1,
				won: 0,
				drawn: 0,
				lost: 1,
				pointsFor: 24,
			},
		]);
	});

	it("counts a finalized 0-0 score as a draw but leaves a live 0-0 unplayed", () => {
		const rows: DbTournamentBattleGroupResultRow[] = [
			{
				id: 4,
				tournament_id: 9,
				group_id: 1,
				event_id: 2,
				home_entry_id: 101,
				home_net_points: 0,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 0,
				away_rank: null,
				away_match_points: null,
			},
		];

		expect(projectOfficialH2HStandingsFromResults([101, 102], rows)).toEqual([
			expect.objectContaining({ entryId: 101, played: 0, drawn: 0 }),
			expect.objectContaining({ entryId: 102, played: 0, drawn: 0 }),
		]);
		expect(
			projectOfficialH2HStandingsFromResults([101, 102], rows, {
				finalizedEventIds: new Set([2]),
			})
		).toEqual([
			expect.objectContaining({
				entryId: 101,
				matchPoints: 1,
				played: 1,
				drawn: 1,
			}),
			expect.objectContaining({
				entryId: 102,
				matchPoints: 1,
				played: 1,
				drawn: 1,
			}),
		]);
	});

	it("derives a validated live or finalized outcome from the latest scores instead of stale saved outcomes", () => {
		const rows: DbTournamentBattleGroupResultRow[] = [
			{
				id: 41,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 20,
				home_rank: 1,
				home_match_points: 3,
				away_entry_id: 102,
				away_net_points: 50,
				away_rank: 2,
				away_match_points: 0,
			},
		];

		expect(
			projectOfficialH2HStandingsFromResults([101, 102], rows, {
				provisionalEventIds: new Set([1]),
			})
		).toEqual([
			expect.objectContaining({ entryId: 102, matchPoints: 3, won: 1, pointsFor: 50 }),
			expect.objectContaining({ entryId: 101, matchPoints: 0, lost: 1, pointsFor: 20 }),
		]);
		expect(
			projectOfficialH2HStandingsFromResults([101, 102], rows, {
				finalizedEventIds: new Set([1]),
			})
		).toEqual([
			expect.objectContaining({ entryId: 102, matchPoints: 3, won: 1, pointsFor: 50 }),
			expect.objectContaining({ entryId: 101, matchPoints: 0, lost: 1, pointsFor: 20 }),
		]);
	});

	it("requires one complete non-zero live score batch across the entire roster", () => {
		const rows: DbTournamentBattleGroupResultRow[] = [
			{
				id: 5,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 49,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 23,
				away_rank: null,
				away_match_points: null,
				home_is_average: false,
				away_is_average: false,
				source_checked_at: "2026-08-23T01:00:00.000Z",
			},
			{
				id: 6,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 103,
				home_net_points: 24,
				home_rank: null,
				home_match_points: null,
				away_entry_id: null,
				away_net_points: 23,
				away_rank: null,
				away_match_points: null,
				home_is_average: false,
				away_is_average: true,
				source_checked_at: new Date("2026-08-23T01:00:00.000Z"),
			},
		];
		const liveOptions = { finalizedEventIds: new Set<number>(), provisionalEventIds: new Set([1]) };

		expect(
			tournamentCacheTestables.officialBattleRowsAreCompleteForEntries(
				[101, 102, 103],
				rows,
				liveOptions
			)
		).toBe(true);
		for (const incomplete of [
			[],
			rows.slice(0, 1),
			[rows[0]!, { ...rows[1]!, home_net_points: null }],
			[rows[0]!, { ...rows[1]!, home_entry_id: 102 }],
			[
				rows[0]!,
				{
					...rows[1]!,
					home_net_points: 0,
					away_net_points: 0,
					source_checked_at: "2026-08-23T01:01:00.000Z",
				},
			],
			rows.map((row) => ({ ...row, home_net_points: 0, away_net_points: 0 })),
		]) {
			expect(
				tournamentCacheTestables.officialBattleRowsAreCompleteForEntries(
					[101, 102, 103],
					incomplete,
					liveOptions
				)
			).toBe(false);
		}
	});

	it("accepts a true bye for atomic coverage without scoring the bye", () => {
		const rows: DbTournamentBattleGroupResultRow[] = [
			{
				id: 7,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 50,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 40,
				away_rank: null,
				away_match_points: null,
				source_checked_at: "2026-08-23T01:00:00.000Z",
			},
			{
				id: 8,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 103,
				home_net_points: null,
				home_rank: null,
				home_match_points: null,
				away_entry_id: null,
				away_net_points: null,
				away_rank: null,
				away_match_points: null,
				is_bye: true,
				source_checked_at: "2026-08-23T01:00:00.000Z",
			},
		];
		const options = { finalizedEventIds: new Set<number>(), provisionalEventIds: new Set([1]) };

		expect(
			tournamentCacheTestables.officialBattleRowsAreCompleteForEntries(
				[101, 102, 103],
				rows,
				options
			)
		).toBe(true);
		expect(projectOfficialH2HStandingsFromResults([101, 102, 103], rows, options)).toContainEqual(
			expect.objectContaining({ entryId: 103, played: 0, matchPoints: 0, pointsFor: 0 })
		);
	});

	it("projects finalized history plus a complete live round only while saved groups lag", () => {
		const groups = [
			{
				tournament_id: 9,
				entry_id: 101,
				group_points: 3,
				group_rank: 1,
				played: 1,
				won: 1,
				drawn: 0,
				lost: 0,
				total_net_points: 40,
			},
			{
				tournament_id: 9,
				entry_id: 102,
				group_points: 0,
				group_rank: 2,
				played: 1,
				won: 0,
				drawn: 0,
				lost: 1,
				total_net_points: 30,
			},
		];
		const history: DbTournamentBattleGroupResultRow[] = [
			{
				id: 9,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 40,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 30,
				away_rank: null,
				away_match_points: null,
				source_checked_at: "2026-08-23T01:00:00.000Z",
			},
			{
				id: 10,
				tournament_id: 9,
				group_id: 1,
				event_id: 2,
				home_entry_id: 101,
				home_net_points: 20,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 50,
				away_rank: null,
				away_match_points: null,
				source_checked_at: "2026-08-23T01:01:00.000Z",
			},
		];

		const projected = tournamentCacheTestables.selectCurrentOfficialH2HProjection(
			2,
			groups,
			history.filter((row) => row.event_id === 2),
			history,
			2,
			2,
			new Set([1])
		);
		expect(projected).toMatchObject({ storedPlayed: 2, derivedPlayed: 4 });
		expect(projected.currentEventComplete).toBe(true);
		expect(projected.standings).toEqual([
			expect.objectContaining({
				entryId: 102,
				rank: 1,
				matchPoints: 3,
				played: 2,
				won: 1,
				lost: 1,
				pointsFor: 80,
			}),
			expect.objectContaining({
				entryId: 101,
				rank: 2,
				matchPoints: 3,
				played: 2,
				won: 1,
				lost: 1,
				pointsFor: 60,
			}),
		]);

		const caughtUpGroups = groups.map((group) =>
			group.entry_id === 101
				? {
						...group,
						group_points: 3,
						group_rank: 2,
						played: 2,
						won: 1,
						lost: 1,
						total_net_points: 60,
					}
				: {
						...group,
						group_points: 3,
						group_rank: 1,
						played: 2,
						won: 1,
						lost: 1,
						total_net_points: 80,
					}
		);
		expect(
			tournamentCacheTestables.selectCurrentOfficialH2HProjection(
				2,
				caughtUpGroups,
				history.filter((row) => row.event_id === 2),
				history,
				2,
				2,
				new Set([1])
			).standings
		).toBeNull();

		const authoritativeTieRanks = caughtUpGroups.map((group) => ({
			...group,
			group_rank: 1,
		}));
		expect(
			tournamentCacheTestables.selectCurrentOfficialH2HProjection(
				2,
				authoritativeTieRanks,
				history.filter((row) => row.event_id === 2),
				history,
				2,
				2,
				new Set([1])
			).standings
		).toBeNull();

		const currentOnlyRows = history.filter((row) => row.event_id === 2);
		const changedScoreAtEqualCoverage = tournamentCacheTestables.selectCurrentOfficialH2HProjection(
			2,
			groups,
			currentOnlyRows,
			currentOnlyRows,
			2,
			2,
			new Set([1])
		);
		expect(changedScoreAtEqualCoverage).toMatchObject({ storedPlayed: 2, derivedPlayed: 2 });
		expect(changedScoreAtEqualCoverage.standings).toEqual([
			expect.objectContaining({
				entryId: 102,
				rank: 1,
				matchPoints: 3,
				played: 1,
				won: 1,
				lost: 0,
				pointsFor: 50,
			}),
			expect.objectContaining({
				entryId: 101,
				rank: 2,
				matchPoints: 0,
				played: 1,
				won: 0,
				lost: 1,
				pointsFor: 20,
			}),
		]);

		const unevenGroupsWithEqualCoverage = [
			{ ...groups[0]!, played: 2 },
			{ ...groups[1]!, played: 0 },
		];
		const unevenProjection = tournamentCacheTestables.selectCurrentOfficialH2HProjection(
			2,
			unevenGroupsWithEqualCoverage,
			currentOnlyRows,
			currentOnlyRows,
			2,
			2,
			new Set([1])
		);
		expect(unevenProjection).toMatchObject({ storedPlayed: 2, derivedPlayed: 2 });
		expect(unevenProjection.standings).toBeNull();

		const moreCompleteGroups = caughtUpGroups.map((group) => ({ ...group, played: 3 }));
		expect(
			tournamentCacheTestables.selectCurrentOfficialH2HProjection(
				2,
				moreCompleteGroups,
				history.filter((row) => row.event_id === 2),
				history,
				2,
				2,
				new Set([1])
			).standings
		).toBeNull();
	});

	it("keeps an incomplete or all-zero current round out of the read-side projection", () => {
		const groups = [101, 102].map((entryId) => ({
			tournament_id: 9,
			entry_id: entryId,
			group_points: 0,
			group_rank: 1,
			played: 0,
			won: 0,
			drawn: 0,
			lost: 0,
			total_net_points: 0,
		}));
		const allZero: DbTournamentBattleGroupResultRow[] = [
			{
				id: 11,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 0,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 0,
				away_rank: null,
				away_match_points: null,
				source_checked_at: "2026-08-23T01:00:00.000Z",
			},
		];

		for (const currentRows of [allZero, [{ ...allZero[0]!, away_net_points: null }]]) {
			const selected = tournamentCacheTestables.selectCurrentOfficialH2HProjection(
				2,
				groups,
				currentRows,
				currentRows,
				1,
				1,
				new Set()
			);
			expect(selected.standings).toBeNull();
			expect(selected.options.provisionalEventIds?.size).toBe(0);
			expect(selected.options.suppressedEventIds).toEqual(new Set([1]));
		}
	});

	it("rejects mixed batch markers for a finalized current round", () => {
		const groups = [101, 102, 103, 104].map((entryId) => ({
			tournament_id: 9,
			entry_id: entryId,
			group_points: 0,
			group_rank: 1,
			played: 0,
			won: 0,
			drawn: 0,
			lost: 0,
			total_net_points: 0,
		}));
		const mixedBatch: DbTournamentBattleGroupResultRow[] = [
			{
				id: 12,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 20,
				home_rank: null,
				home_match_points: 3,
				away_entry_id: 102,
				away_net_points: 50,
				away_rank: null,
				away_match_points: 0,
				source_checked_at: "2026-08-23T01:00:00.000Z",
			},
			{
				id: 13,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 103,
				home_net_points: 40,
				home_rank: null,
				home_match_points: 0,
				away_entry_id: 104,
				away_net_points: 30,
				away_rank: null,
				away_match_points: 3,
				source_checked_at: "2026-08-23T01:01:00.000Z",
			},
		];

		const rejected = tournamentCacheTestables.selectCurrentOfficialH2HProjection(
			4,
			groups,
			mixedBatch,
			mixedBatch,
			1,
			1,
			new Set([1])
		);
		expect(rejected.standings).toBeNull();
		expect(rejected.options.finalizedEventIds?.has(1)).toBe(false);
		expect(rejected.options.suppressedEventIds).toEqual(new Set([1]));
		expect(
			projectHistoricalOfficialH2HStandings([101, 102, 103, 104], mixedBatch, rejected.options)
		).toEqual([
			expect.objectContaining({ entryId: 101, played: 0, matchPoints: 0 }),
			expect.objectContaining({ entryId: 102, played: 0, matchPoints: 0 }),
			expect.objectContaining({ entryId: 103, played: 0, matchPoints: 0 }),
			expect.objectContaining({ entryId: 104, played: 0, matchPoints: 0 }),
		]);

		const atomicBatch = mixedBatch.map((row) => ({
			...row,
			source_checked_at: "2026-08-23T01:00:00.000Z",
		}));
		const accepted = tournamentCacheTestables.selectCurrentOfficialH2HProjection(
			4,
			groups,
			atomicBatch,
			atomicBatch,
			1,
			1,
			new Set([1])
		);
		expect(accepted.standings).toEqual([
			expect.objectContaining({ entryId: 102, rank: 1, matchPoints: 3, pointsFor: 50 }),
			expect.objectContaining({ entryId: 103, rank: 2, matchPoints: 3, pointsFor: 40 }),
			expect.objectContaining({ entryId: 104, rank: 3, matchPoints: 0, pointsFor: 30 }),
			expect.objectContaining({ entryId: 101, rank: 4, matchPoints: 0, pointsFor: 20 }),
		]);

		const liveBatch = atomicBatch.map((row, index) => ({
			...row,
			id: 20 + index,
			event_id: 2,
			home_match_points: null,
			away_match_points: null,
			source_checked_at: "2026-08-23T02:00:00.000Z",
		}));
		const liveWithRejectedHistory = tournamentCacheTestables.selectCurrentOfficialH2HProjection(
			4,
			groups,
			liveBatch,
			[...mixedBatch, ...liveBatch],
			2,
			2,
			new Set([1])
		);
		expect(liveWithRejectedHistory.options.finalizedEventIds?.has(1)).toBe(false);
		expect(liveWithRejectedHistory.options.suppressedEventIds?.has(1)).toBe(true);
		expect(liveWithRejectedHistory.standings).toEqual([
			expect.objectContaining({ entryId: 102, matchPoints: 3, played: 1, pointsFor: 50 }),
			expect.objectContaining({ entryId: 103, matchPoints: 3, played: 1, pointsFor: 40 }),
			expect.objectContaining({ entryId: 104, matchPoints: 0, played: 1, pointsFor: 30 }),
			expect.objectContaining({ entryId: 101, matchPoints: 0, played: 1, pointsFor: 20 }),
		]);
	});
});

describe("resolveOfficialH2HReferenceEventId", () => {
	it("uses current, then next, and treats every GW as historical after the season", () => {
		expect(
			resolveOfficialH2HReferenceEventId([
				{ id: 4, finished: false, data_checked: false, is_current: true, is_next: false },
				{ id: 5, finished: false, data_checked: false, is_current: false, is_next: true },
			])
		).toBe(4);
		expect(
			resolveOfficialH2HReferenceEventId([
				{ id: 1, finished: false, data_checked: false, is_current: false, is_next: true },
			])
		).toBe(1);
		expect(resolveOfficialH2HReferenceEventId([])).toBe(39);
	});
});

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

const validCachedTournamentInfo = {
	id: 1,
	name: "Tournament",
	creator: "creator",
	adminEntryId: 10,
	leagueId: 20,
	leagueType: LeagueType.CLASSIC,
	sourceLeagueName: null,
	rosterMode: TournamentRosterMode.SNAPSHOT,
	rosterSyncStatus: null,
	rosterLastSyncedAt: null,
	officialScheduleHash: null,
	officialScheduleSyncedAt: null,
	officialScheduleLockedAt: null,
	totalTeamNum: 2,
	tournamentMode: TournamentMode.NORMAL,
	groupMode: GroupMode.POINTS_RACES,
	groupTeamNum: 2,
	groupNum: 1,
	groupStartedEventId: 1,
	groupEndedEventId: 38,
	groupAutoAverages: false,
	groupRounds: null,
	groupPlayAgainstNum: null,
	groupQualifyNum: null,
	knockoutMode: null,
	knockoutTeamNum: null,
	knockoutRounds: null,
	knockoutEventNum: null,
	knockoutStartedEventId: null,
	knockoutEndedEventId: null,
	knockoutPlayAgainstNum: null,
	state: TournamentState.ACTIVE,
	setupStatus: TournamentSetupStatus.READY,
	setupPhase: TournamentSetupPhase.READY,
	setupCompletedUnits: 2,
	setupTotalUnits: 2,
	setupProgressUpdatedAt: null,
	setupProgressMode: TournamentSetupProgressMode.DETERMINATE,
	setupAttempt: 0,
	setupMaxAttempts: 3,
	nextRetryAt: null,
	standingsReadyAt: "2026-04-21T00:00:00.000Z",
	profilesReadyAt: null,
	insightsReadyAt: "2026-04-21T00:00:00.000Z",
	setupHasWarnings: false,
	warningSummaries: [],
	setupStartedAt: null,
	setupFinishedAt: "2026-04-21T00:00:00.000Z",
	createdAt: "2026-04-21T00:00:00.000Z",
	updatedAt: "2026-04-21T00:00:00.000Z",
};

describe("tournament cache wire contracts", () => {
	it("accepts complete cache objects and rejects missing or mistyped required fields", () => {
		const validResult = {
			tournament: validCachedTournamentInfo,
			eventId: 3,
			groupId: 1,
			entryId: 10,
			entryName: "Entry",
			playerName: "Player",
			eventGroupRank: 1,
			eventPoints: 70,
			eventCost: 0,
			eventNetPoints: 70,
			eventRank: 1,
			overallPoints: 100,
			overallRank: 1,
			eventChip: null,
			captainId: 7,
			captainPoints: 14,
			teamValue: 1000,
			bank: 0,
		};

		expect(tournamentCacheTestables.isTournamentInfoCache(validCachedTournamentInfo)).toBe(true);
		expect(tournamentCacheTestables.isTournamentEventResultCache(validResult)).toBe(true);
		expect(
			tournamentCacheTestables.isTournamentEventResultCache({
				...validResult,
				groupId: undefined,
			})
		).toBe(false);
		expect(
			tournamentCacheTestables.isTournamentEventResultCache({
				...validResult,
				entryId: "10",
			})
		).toBe(false);
		expect(
			tournamentCacheTestables.isTournamentEventResultCache({
				...validResult,
				teamValue: 1000.5,
			})
		).toBe(false);
		expect(
			tournamentCacheTestables.isTournamentEventResultCache({
				...validResult,
				entryId: 2_147_483_648,
			})
		).toBe(false);
		expect(
			tournamentCacheTestables.isTournamentInfoCache({
				...validCachedTournamentInfo,
				setupStatus: "bogus",
			})
		).toBe(false);
		expect(
			tournamentCacheTestables.isTournamentInfoCache({
				...validCachedTournamentInfo,
				createdAt: "2026-02-30T00:00:00.000Z",
			})
		).toBe(false);
		expect(
			tournamentCacheTestables.isTournamentSetupWarningSummaryCache({
				category: "insights",
				affectedCount: 1,
				repairExhausted: true,
			})
		).toBe(true);
		expect(
			tournamentCacheTestables.isTournamentSetupWarningSummaryCache({
				category: "insights",
				affectedCount: 1,
			})
		).toBe(false);
	});

	it("requires all persisted ranking, season, battle and H2H fields", () => {
		const summary = {
			eventId: 3,
			entryId: 10,
			overallRank: null,
			tournamentOverallRank: null,
			teamValue: null,
			tournamentTeamValueRank: null,
			transfersNum: 0,
			tournamentTransfersRank: null,
			totalCosts: 0,
			tournamentCostsRank: null,
			totalBenchPoints: 0,
			tournamentBenchPointsRank: null,
			autoSubPoints: 0,
			tournamentAutoSubRank: null,
			overallPoints: null,
			leaderOverallPoints: null,
			gapToLeader: null,
			pointsBehindNext: null,
			pointsAheadOfPrev: null,
		};
		expect(tournamentCacheTestables.isRankingSummaryCache(summary)).toBe(true);
		expect(tournamentCacheTestables.isRankingSummaryCache({ ...summary, totalCosts: "0" })).toBe(
			false
		);
		expect(tournamentCacheTestables.isRankingSummaryCache({ ...summary, teamValue: 1000.5 })).toBe(
			false
		);

		const battle = {
			tournament: validCachedTournamentInfo,
			matchId: 1,
			groupId: 1,
			eventId: 3,
			homeEntryId: 10,
			homeEntryName: null,
			homePlayerName: null,
			homeNetPoints: 10,
			homeRank: 1,
			homeMatchPoints: 3,
			awayEntryId: 11,
			awayEntryName: null,
			awayPlayerName: null,
			awayNetPoints: 5,
			awayRank: 2,
			awayMatchPoints: 0,
		};
		expect(tournamentCacheTestables.isBattleResultCache(battle)).toBe(true);
		expect(tournamentCacheTestables.isBattleResultCache({ ...battle, groupId: undefined })).toBe(
			false
		);

		const h2h = {
			tournament: validCachedTournamentInfo,
			matchId: 1,
			groupId: 1,
			eventId: 3,
			entryId: 10,
			entryName: null,
			playerName: null,
			entryNetPoints: 10,
			entryRank: 1,
			entryMatchPoints: 3,
			entryEventPoints: 70,
			entryTransferCost: 0,
			entryOverallRank: 1,
			entryChip: null,
			opponentEntryId: 11,
			opponentEntryName: null,
			opponentPlayerName: null,
			opponentNetPoints: 5,
			opponentRank: 2,
			opponentMatchPoints: 0,
			opponentEventPoints: 65,
			opponentTransferCost: 4,
			opponentOverallRank: 2,
			opponentChip: null,
		};
		expect(tournamentCacheTestables.isH2HResultCache(h2h)).toBe(true);
		expect(tournamentCacheTestables.isH2HResultCache({ ...h2h, opponentEntryId: "11" })).toBe(
			false
		);
		expect(tournamentCacheTestables.isH2HResultCache({ ...h2h, entryChip: "bogus" })).toBe(false);

		const season = {
			asOfEventId: 3,
			entryCount: 1,
			leaderOverallPoints: 100,
			secondOverallPoints: null,
			gapFirstSecond: null,
			averageOverallPoints: 100,
			metrics: [
				{
					key: "OVERALL_POINTS",
					leaderValue: 100,
					leaderEntryId: 10,
					leaderEntryName: "Entry",
					leaderPlayerName: "Player",
					averageValue: 100,
					higherIsBetter: true,
				},
			],
			standings: [
				{
					entryId: 10,
					rank: 1,
					entryName: "Entry",
					playerName: "Player",
					overallPoints: 100,
					overallRank: 1,
					teamValue: 1000,
				},
			],
		};
		expect(tournamentCacheTestables.isSeasonSnapshotCache(season)).toBe(true);
		expect(
			tournamentCacheTestables.isSeasonSnapshotCache({
				...season,
				metrics: [{ ...season.metrics[0], key: "unknown" }],
			})
		).toBe(false);
	});

	it("uses the versioned tournament cache namespace", () => {
		const context = {
			currentSeason: { seasonId: 2025, seasonCode: "2526" },
			dataRevision: "r1",
		} as GraphQLContext;
		expect(tournamentCacheTestables.tournamentCacheKey(context, "event-results:page")).toBe(
			gqlCacheKey(context, "tournaments:v2:event-results:page")
		);
	});
});

describe("mapTournamentInfo", () => {
	it("normalizes database Date values to GraphQL-safe ISO strings", () => {
		const updatedAt = new Date("2026-04-21T00:00:00.000Z");
		const row: DbTournamentInfoRow = {
			id: 11,
			name: "Date-backed League",
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
			setup_status: "ready",
			setup_phase: "ready",
			standings_ready_at: updatedAt,
			created_at: updatedAt,
			updated_at: updatedAt,
		} as DbTournamentInfoRow;

		const result = mapTournamentInfo(row);
		expect(result.standingsReadyAt).toBe("2026-04-21T00:00:00.000Z");
		expect(result.createdAt).toBe("2026-04-21T00:00:00.000Z");
		expect(result.updatedAt).toBe("2026-04-21T00:00:00.000Z");
	});

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
			setup_status: "ready",
			setup_phase: "ready",
			standings_ready_at: "2026-04-21T00:00:00.000Z",
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
			officialScheduleHash: null,
			officialScheduleSyncedAt: null,
			officialScheduleLockedAt: null,
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
			setupProgressMode: TournamentSetupProgressMode.DETERMINATE,
			setupAttempt: 0,
			setupMaxAttempts: 3,
			nextRetryAt: null,
			standingsReadyAt: "2026-04-21T00:00:00.000Z",
			profilesReadyAt: null,
			insightsReadyAt: null,
			setupHasWarnings: false,
			setupStartedAt: null,
			setupFinishedAt: null,
			createdAt: "2026-04-21T00:00:00.000Z",
			updatedAt: "2026-04-21T00:00:00.000Z",
		});
	});

	it("rejects a missing setup status", () => {
		const updatedAt = "2026-04-21T00:00:00.000Z";
		const row: DbTournamentInfoRow = {
			id: 12,
			name: "Published League",
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

		expect(() => mapTournamentInfo(row)).toThrow("Unknown tournament setup status");
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
			setup_status: "ready",
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
			eventChip: "FREE_HIT",
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
			setup_status: "ready",
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
		const deletedKeys: string[] = [];

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
					const range = actions.find((action) => action.type === "range");
					const resultData = options.resultData ?? [];
					return {
						data: range
							? resultData.slice(Number(range.args[0]), Number(range.args[1]) + 1)
							: resultData,
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
				is(...args: unknown[]) {
					actions.push({ type: "is", args });
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
				range(...args: unknown[]) {
					actions.push({ type: "range", args });
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
				async del(key: string) {
					deletedKeys.push(key);
					redisState.delete(key);
					return 1;
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
			__deletedKeys: deletedKeys,
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
		setup_status: "ready",
		created_at: "2026-04-21T00:00:00.000Z",
		updated_at: "2026-04-21T00:00:00.000Z",
	};

	it("normalizes Date-backed managed status timestamps", async () => {
		const updatedAt = new Date("2026-04-21T00:00:00.000Z");
		const result = await tournamentsRepository.getManagedTournamentStatus(
			buildContext({
				tournamentData: [
					{
						id: 1,
						admin_entry_id: 15702,
						state: "active",
						setup_status: "ready",
						setup_phase: "ready",
						roster_sync_status: null,
						setup_completed_units: 1,
						setup_total_units: 1,
						standings_ready_at: updatedAt,
						setup_warning_count: 0,
						updated_at: updatedAt,
					},
				],
			}),
			1,
			15702
		);

		expect(result).toMatchObject({
			revision: "2026-04-21T00:00:00.000Z",
			standingsReadyAt: "2026-04-21T00:00:00.000Z",
			updatedAt: "2026-04-21T00:00:00.000Z",
		});
	});

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
				eventChip: "BENCH_BOOST",
				captainId: 430,
				captainPoints: 12,
				teamValue: 1030,
				bank: 25,
			},
		];
		const context = buildContext({ cacheSeed: JSON.stringify(cached) });

		const result = await tournamentsRepository.getTournamentEventResults(
			context,
			1,
			33,
			null,
			null
		);
		expect(result).toEqual(cached);
	});

	it("returns empty array when the tournament has no results", async () => {
		const context = buildContext({ resultData: [] });
		const result = await tournamentsRepository.getTournamentEventResults(
			context,
			1,
			33,
			null,
			null
		);
		expect(result).toEqual([]);
	});

	it("pushes bounded pages into the read model and caches the page key", async () => {
		const context = buildContext({ resultData: [] }) as GraphQLContext & {
			__queryLog: Array<{
				table: string;
				actions: Array<{ type: string; args: unknown[] }>;
			}>;
			__redisState: Map<string, string>;
		};
		const result = await tournamentsRepository.getTournamentEventResults(context, 1, 33, 2, 4);
		expect(result).toEqual([]);
		const resultQuery = context.__queryLog.find(
			(entry) => entry.table === "reporting.tournament_event_results"
		);
		expect(resultQuery?.actions.find((action) => action.type === "range")?.args).toEqual([4, 5]);
		expect([...context.__redisState.keys()]).toHaveLength(1);
		const queryCount = context.__queryLog.length;
		await tournamentsRepository.getTournamentEventResults(context, 1, 33, 2, 4);
		expect(context.__queryLog.length).toBe(queryCount);
		await tournamentsRepository.getTournamentEventResults(context, 1, 33, 2, 6);
		expect([...context.__redisState.keys()]).toHaveLength(2);
	});

	it("evicts malformed tournament event-result cache JSON before querying", async () => {
		const context = buildContext({ cacheSeed: "{not-json", resultData: [] }) as GraphQLContext & {
			__deletedKeys: string[];
		};
		await tournamentsRepository.getTournamentEventResults(context, 1, 33, null, null);
		expect(context.__deletedKeys).toHaveLength(1);
	});

	it("evicts schema-invalid tournament event-result JSON before querying", async () => {
		const context = buildContext({
			cacheSeed: JSON.stringify([
				{
					tournament: validCachedTournamentInfo,
					eventId: 33,
					entryId: 7,
				},
			]),
			resultData: [],
		}) as GraphQLContext & { __deletedKeys: string[] };

		await tournamentsRepository.getTournamentEventResults(context, 1, 33, null, null);

		expect(context.__deletedKeys).toHaveLength(1);
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
		const result = await tournamentsRepository.getTournamentEventResults(
			context,
			1,
			33,
			null,
			null
		);
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

		const result = await tournamentsRepository.getTournamentEventResults(
			context,
			1,
			33,
			null,
			null
		);

		expect(result).toHaveLength(2);
		expect(result[0].groupId).toBe(1);
		expect(result[0].entryId).toBe(100);
		expect(result[0].entryName).toBe("League Entry 100");
		expect(result[1].groupId).toBe(2);
		expect(result[1].entryId).toBe(300);
		expect(result[1].entryName).toBe("Fallback Entry 300");
		expect(result[1].eventChip).toBe("FREE_HIT");

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
		eventResultsError?: unknown;
		cacheSeed?: string | null;
		eventResults?: TournamentEventResult[];
	}): GraphQLContext => {
		const redisState = new Map<string, string>();
		if (options.cacheSeed) {
			redisState.set(
				testCacheKey(`tournaments:ranking-summary:{"entryId":15702,"eventId":3,"tournamentId":1}`),
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
				if (table === "reporting.tournament_event_results") {
					return {
						data: [],
						error: options.eventResultsError ?? null,
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
		setup_status: "ready",
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

	it("returns empty summary for non-points-race tournaments from the canonical model", async () => {
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

	it("normalizes PostgreSQL bigint window ranks before caching the summary", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			snapshotData: [
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 15702,
					tournament_overall_rank: "2",
					overall_rank: "1000",
					team_value: "1020",
					cum_transfers_num: "3",
					cum_total_costs: "4",
					cum_total_bench_points: "11",
					cum_auto_sub_points: "7",
					tournament_team_value_rank: "1",
					tournament_transfers_rank: "2",
					tournament_costs_rank: "2",
					tournament_bench_points_rank: "1",
					tournament_auto_sub_rank: "1",
				},
			],
		});

		const first = await tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			1,
			3,
			15702
		);
		const second = await tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			1,
			3,
			15702
		);

		expect(first.tournamentOverallRank).toBe(2);
		expect(first.tournamentTransfersRank).toBe(2);
		expect(second).toEqual(first);
	});

	it("preserves the ranking summary when the optional field gap lookup fails", async () => {
		const context = buildContext({
			tournamentData: [tournamentRow],
			eventResultsError: new Error("event results unavailable"),
			snapshotData: [
				{
					tournament_id: 1,
					event_id: 3,
					entry_id: 15702,
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
		expect(result.transfersNum).toBe(3);
		expect(result.gapToLeader).toBeNull();
		expect(result.pointsBehindNext).toBeNull();
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

	it("builds one tournament season snapshot from reporting rows", async () => {
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
					cum_transfers_num: null,
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
			averageValue: 2.5,
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
		setup_status: "ready",
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

describe("tournamentsRepository.getTournamentForMember", () => {
	it("accepts current official-league membership when the tournament roster is a stale snapshot", async () => {
		const tournamentRow = {
			id: 3,
			name: "Tracked Classic",
			creator: "admin",
			admin_entry_id: 6_953,
			league_id: 8_863,
			league_type: "classic",
			total_team_num: 98,
			tournament_mode: "normal",
			group_mode: "points_races",
			group_team_num: 98,
			group_num: 1,
			group_started_event_id: 1,
			group_ended_event_id: 38,
			group_auto_averages: false,
			group_rounds: 38,
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
			setup_status: "ready",
			setup_phase: "ready",
			created_at: "2026-08-20T14:33:31.925Z",
			updated_at: "2026-08-21T20:35:08.237Z",
		} as DbTournamentInfoRow;
		const rosterQuery = {
			select() {
				return rosterQuery;
			},
			eq() {
				return rosterQuery;
			},
			async limit() {
				return { data: [], error: null };
			},
		};
		const officialLeagueQuery = {
			select() {
				return officialLeagueQuery;
			},
			eq() {
				return officialLeagueQuery;
			},
			async limit() {
				return { data: [{ tournament_id: 3 }], error: null };
			},
		};
		const tournamentQuery = {
			select() {
				return tournamentQuery;
			},
			eq() {
				return tournamentQuery;
			},
			async limit() {
				return { data: [tournamentRow], error: null };
			},
		};
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			data: {
				read(table: string) {
					if (table === "competition.tournament_entries") return rosterQuery;
					if (table === "competition.entry_leagues_with_tournament") {
						return officialLeagueQuery;
					}
					return tournamentQuery;
				},
			},
			logger: {
				error() {
					return undefined;
				},
			},
		} as unknown as GraphQLContext;

		const tournament = await tournamentsRepository.getTournamentForMember(context, 3, 8_743_559);

		expect(tournament?.id).toBe(3);
		expect(tournament?.leagueId).toBe(8_863);
	});
});

describe("tournamentsRepository.getEntryTournaments", () => {
	it("includes a tracked official league before its frozen tournament roster catches up", async () => {
		let requestedTournamentIds: unknown = null;
		const rosterQuery = {
			select() {
				return rosterQuery;
			},
			async eq() {
				return { data: [], error: null };
			},
		};
		const officialLeagueQuery = {
			select() {
				return officialLeagueQuery;
			},
			async eq() {
				return { data: [{ tournament_id: 3 }], error: null };
			},
		};
		const infoQuery = {
			select() {
				return infoQuery;
			},
			in(_column: string, values: unknown[]) {
				requestedTournamentIds = values;
				return infoQuery;
			},
			async order() {
				return { data: [], error: null };
			},
		};
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: undefined,
			data: {
				read(table: string) {
					if (table === "competition.tournament_entries") return rosterQuery;
					if (table === "competition.entry_leagues_with_tournament") {
						return officialLeagueQuery;
					}
					return infoQuery;
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

		expect(await tournamentsRepository.getEntryTournaments(context, 8_743_559)).toEqual([]);
		expect(requestedTournamentIds).toEqual([3]);
	});

	it("lists all tournaments for a verified platform administrator without a membership filter", async () => {
		const readTables: string[] = [];
		let idFilterCalls = 0;
		const infoQuery = {
			select() {
				return infoQuery;
			},
			in() {
				idFilterCalls += 1;
				return infoQuery;
			},
			async order() {
				return { data: [], error: null };
			},
		};
		const context = {
			dataRevision: undefined,
			data: {
				read(table: string) {
					readTables.push(table);
					return infoQuery;
				},
			},
			principal: {
				userId: "platform-admin",
				source: "website",
				fplEntryId: 6953,
				fplEntryVerifiedAt: "2026-08-21T00:00:00.000Z",
				platformAdmin: true,
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

		expect(await tournamentsRepository.getEntryTournaments(context, 6953)).toEqual([]);
		expect(readTables).toEqual(["competition.tournaments"]);
		expect(idFilterCalls).toBe(0);
	});

	it("does not add the tournament owner predicate for a verified platform administrator", async () => {
		const filters: Array<[string, unknown]> = [];
		const query = {
			select() {
				return query;
			},
			eq(column: string, value: unknown) {
				filters.push([column, value]);
				return query;
			},
			async limit() {
				return { data: [], error: null };
			},
		};
		const context = {
			data: { read: () => query },
			principal: {
				userId: "platform-admin",
				source: "website",
				fplEntryId: 6953,
				fplEntryVerifiedAt: "2026-08-21T00:00:00.000Z",
				platformAdmin: true,
			},
			logger: {
				error() {
					return undefined;
				},
			},
		} as unknown as GraphQLContext;

		expect(await tournamentsRepository.getManagedTournament(context, 9, 6953)).toBeNull();
		expect(filters).toEqual([["id", 9]]);
	});

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
		let issueResult: { data: unknown[] | null; error: unknown } = { data: [], error: null };
		const issueQuery = {
			select() {
				return issueQuery;
			},
			in() {
				return issueQuery;
			},
			is() {
				return issueQuery;
			},
			async order() {
				return issueResult;
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
					if (table === "competition.tournaments") return infoQuery;
					if (table === "competition.tournament_setup_issues") return issueQuery;
					return membershipQuery;
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
		expect(cache.has(testCacheKey("tournaments:entry:visible-v2:55"))).toBe(true);

		const cachedResult = await tournamentsRepository.getEntryTournaments(context, 55);
		expect(cachedResult).toHaveLength(1);
		expect(cacheWrites).toBe(1);

		cache.delete(testCacheKey("tournaments:entry:visible-v2:55"));
		issueResult = { data: null, error: new Error("database unavailable") };
		await expect(tournamentsRepository.getEntryTournaments(context, 55)).rejects.toThrow(
			"Failed to load tournament setup warning summaries"
		);
		expect(cacheWrites).toBe(1);
		expect(cache.has(testCacheKey("tournaments:entry:visible-v2:55"))).toBe(false);
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
		setup_status: "ready",
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
			testCacheKey(`tournaments:entry-h2h:100:${JSON.stringify(tournamentIds)}`);

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

describe("official H2H active score authority", () => {
	it("does not expose the separately refreshed H2H score when event-live calculation is unavailable", async () => {
		const tournament: DbTournamentInfoRow = {
			id: 9,
			name: "Official H2H",
			creator: "owner",
			admin_entry_id: 101,
			league_id: 34879,
			league_type: "h2h",
			source_league_name: "Official H2H",
			roster_mode: "official_sync",
			roster_sync_status: "ready",
			official_schedule_locked_at: "2026-08-20T00:00:00.000Z",
			total_team_num: 2,
			tournament_mode: "normal",
			group_mode: "battle_races",
			group_team_num: 2,
			group_num: 1,
			group_started_event_id: 1,
			group_ended_event_id: 35,
			group_auto_averages: false,
			group_rounds: 1,
			group_play_against_num: 1,
			group_qualify_num: null,
			knockout_mode: "no_knockout",
			knockout_team_num: null,
			knockout_rounds: null,
			knockout_event_num: null,
			knockout_started_event_id: null,
			knockout_ended_event_id: null,
			knockout_play_against_num: null,
			state: "active",
			setup_status: "ready",
			setup_phase: "ready",
			created_at: "2026-08-20T00:00:00.000Z",
			updated_at: "2026-08-23T00:00:00.000Z",
		};
		const groups = [101, 102].map((entryId) => ({
			tournament_id: 9,
			entry_id: entryId,
			group_points: 0,
			group_rank: 1,
			played: 0,
			won: 0,
			drawn: 0,
			lost: 0,
			total_net_points: 0,
		}));
		const battles: DbTournamentBattleGroupResultRow[] = [
			{
				id: 90,
				tournament_id: 9,
				group_id: 1,
				event_id: 1,
				home_entry_id: 101,
				home_net_points: 49,
				home_rank: null,
				home_match_points: null,
				away_entry_id: 102,
				away_net_points: 23,
				away_rank: null,
				away_match_points: null,
				official_match_id: 2071743,
				source_order: 0,
				home_is_average: false,
				away_is_average: false,
				is_bye: false,
				source_checked_at: new Date("2026-08-23T01:00:00.000Z"),
			},
		];
		const historyBattles: DbTournamentBattleGroupResultRow[] | null = null;
		const memberships = [{ tournament_id: 9, entry_id: 102 }];
		const canonicalMemberships = [{ tournament_id: 9, entry_id: 101 }];
		const entries = [
			{ id: 101, entry_name: "WhoAMI Agent", player_name: "WhoAMI's Team" },
			{ id: 102, entry_name: "Average Killers", player_name: "Manager Two" },
		];
		const events = [
			{ id: 1, finished: false, data_checked: false, is_current: true, is_next: false },
		];
		let currentEventBattleReads = 0;

		const makeBuilder = (table: string) => {
			const actions: QueryAction[] = [];
			const resolveResult = () => {
				if (
					table === "competition.tournament_battle_group_results" &&
					actions.some((action) => action.type === "eq" && action.args[0] === "event_id")
				) {
					currentEventBattleReads += 1;
				}
				const source =
					table === "competition.tournaments"
						? [tournament]
						: table === "competition.tournament_groups"
							? groups
							: table === "competition.tournament_battle_group_results"
								? actions.some((action) => action.type === "lte") && historyBattles !== null
									? historyBattles
									: battles
								: table === "competition.tournament_knockout_results"
									? []
									: table === "competition.tournament_entries"
										? memberships
										: table === "competition.entry_leagues_with_tournament"
											? canonicalMemberships
											: table === "competition.entries"
												? entries
												: table === "fpl.events"
													? events
													: [];
				return { data: filterRowsByActions(source, actions), error: null };
			};
			const builder = {
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
				lte(...args: unknown[]) {
					actions.push({ type: "lte", args });
					return builder;
				},
				not(...args: unknown[]) {
					actions.push({ type: "not", args });
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
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-live-h2h",
			data: { read: (table: string) => makeBuilder(table) },
			logger: {
				error() {
					return undefined;
				},
				warn() {
					return undefined;
				},
			},
		} as unknown as GraphQLContext;

		const snapshot = await tournamentsRepository.getTournamentOfficialH2H(context, 9, 1);
		const desk = await tournamentsRepository.getEntryOfficialH2HDesk(context, 101);
		expect(currentEventBattleReads).toBe(0);
		expect(snapshot.scoreSource).toBe("UNAVAILABLE");
		expect(snapshot.scoreRevision).toBeNull();
		expect(snapshot.standings.every((standing) => standing.played === 0)).toBe(true);
		expect(snapshot.matches[0]).toMatchObject({
			home: { entryId: 101, points: null, matchPoints: null },
			away: { entryId: 102, points: null, matchPoints: null },
			winnerEntryId: null,
			sourceCheckedAt: null,
		});
		expect(desk).toHaveLength(1);
		expect(desk[0]).toMatchObject({
			tournamentId: 9,
			scoreSource: "UNAVAILABLE",
			rank: 1,
			lastRank: null,
			matchPoints: 0,
			standingsPublished: false,
			standingsCurrentEventComplete: false,
			match: {
				home: { entryId: 101, points: null, matchPoints: null },
				away: { entryId: 102, points: null, matchPoints: null },
				winnerEntryId: null,
			},
		});

		// Changing only the official H2H feed must never change the public active score.
		battles[0]!.home_net_points = 20;
		battles[0]!.away_net_points = 50;
		const updatedSnapshot = await tournamentsRepository.getTournamentOfficialH2H(context, 9, 1);
		expect(updatedSnapshot).toMatchObject({
			scoreSource: "UNAVAILABLE",
			matches: [
				{
					home: { entryId: 101, points: null, matchPoints: null },
					away: { entryId: 102, points: null, matchPoints: null },
					winnerEntryId: null,
				},
			],
		});
	});
});
