import { describe, expect, it } from "bun:test";
import { LeagueType } from "../../../src/domains/leagues/repository";
import {
	type TournamentBattleGroupResult,
	type EntryH2HMatchResult,
	type TournamentEntryRankingSummary,
	type TournamentEventResult,
	type TournamentSeasonSnapshot,
	TournamentMode,
	TournamentSetupStatus,
	TournamentState,
	tournamentsRepository,
} from "../../../src/domains/tournaments/repository";
import {
	assertTournamentInsightsReady,
	assertTournamentStandingsReady,
	tournamentsService,
} from "../../../src/domains/tournaments/service";
import type { GraphQLContext } from "../../../src/graphql/context";

describe("tournamentsService.getEntryTournaments", () => {
	it("delegates to tournamentsRepository with the same args", async () => {
		const original = tournamentsRepository.getEntryTournaments;
		const context = {} as unknown as GraphQLContext;
		const expected = [
			{
				id: 1,
				name: "T1",
				creator: "alice",
				adminEntryId: 10,
				leagueId: 20,
				leagueType: LeagueType.CLASSIC,
				totalTeamNum: 8,
				tournamentMode: TournamentMode.NORMAL,
				groupMode: null,
				groupTeamNum: null,
				groupNum: null,
				groupStartedEventId: null,
				groupEndedEventId: null,
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
				createdAt: "2026-04-21T00:00:00.000Z",
				updatedAt: "2026-04-21T00:00:00.000Z",
			},
		];

		let capturedEntryId = -1;
		tournamentsRepository.getEntryTournaments = async (
			inputContext: GraphQLContext,
			entryId: number
		): Promise<typeof expected> => {
			expect(inputContext).toBe(context);
			capturedEntryId = entryId;
			return expected;
		};

		try {
			const result = await tournamentsService.getEntryTournaments(context, 12345);
			expect(capturedEntryId).toBe(12345);
			expect(result).toEqual(expected);
		} finally {
			tournamentsRepository.getEntryTournaments = original;
		}
	});
});

describe("tournament readiness", () => {
	it("rejects standings before core publication", async () => {
		const original = tournamentsRepository.getTournamentInfoUncached;
		tournamentsRepository.getTournamentInfoUncached = async () =>
			({ id: 7, standingsReadyAt: null }) as never;
		try {
			await expect(assertTournamentStandingsReady({} as GraphQLContext, 7)).rejects.toMatchObject({
				extensions: { code: "TOURNAMENT_STANDINGS_NOT_READY" },
			});
		} finally {
			tournamentsRepository.getTournamentInfoUncached = original;
		}
	});

	it("keeps insights gated while enrichment is incomplete", async () => {
		const original = tournamentsRepository.getTournamentInfoUncached;
		tournamentsRepository.getTournamentInfoUncached = async () =>
			({
				id: 7,
				standingsReadyAt: "2026-08-04T00:00:00.000Z",
				setupStatus: "processing",
				setupPhase: "enriching_history",
				setupHasWarnings: false,
			}) as never;
		try {
			await expect(assertTournamentInsightsReady({} as GraphQLContext, 7)).rejects.toMatchObject({
				extensions: { code: "TOURNAMENT_INSIGHTS_NOT_READY" },
			});
		} finally {
			tournamentsRepository.getTournamentInfoUncached = original;
		}
	});

	it("does not expose insights until the capability timestamp is published", async () => {
		const original = tournamentsRepository.getTournamentInfoUncached;
		tournamentsRepository.getTournamentInfoUncached = async () =>
			({
				id: 7,
				standingsReadyAt: "2026-08-04T00:00:00.000Z",
				setupStatus: "ready",
				setupPhase: "ready",
				insightsReadyAt: null,
			}) as never;
		try {
			await expect(assertTournamentInsightsReady({} as GraphQLContext, 7)).rejects.toMatchObject({
				extensions: { code: "TOURNAMENT_INSIGHTS_NOT_READY" },
			});
		} finally {
			tournamentsRepository.getTournamentInfoUncached = original;
		}
	});

	it("delegates entry H2H reads to the repository readiness barrier", async () => {
		const originalResults = tournamentsRepository.getEntryH2HMatchResults;
		const context = {} as GraphQLContext;
		const results = [{ tournament: { id: 7 } }, { tournament: { id: 7 } }] as EntryH2HMatchResult[];

		tournamentsRepository.getEntryH2HMatchResults = async (inputContext, entryId) => {
			expect(inputContext).toBe(context);
			expect(entryId).toBe(123);
			return results;
		};

		try {
			expect(await tournamentsService.getEntryH2HMatchResults(context, 123)).toEqual(results);
		} finally {
			tournamentsRepository.getEntryH2HMatchResults = originalResults;
		}
	});
});

describe("tournamentsService.getTournamentEntryIdsUncached", () => {
	it("delegates to the uncached repository read", async () => {
		const original = tournamentsRepository.getTournamentEntryIdsUncached;
		const context = {} as GraphQLContext;
		tournamentsRepository.getTournamentEntryIdsUncached = async (inputContext, tournamentId) => {
			expect(inputContext).toBe(context);
			expect(tournamentId).toBe(7);
			return [101, 202];
		};

		try {
			expect(await tournamentsService.getTournamentEntryIdsUncached(context, 7)).toEqual([
				101, 202,
			]);
		} finally {
			tournamentsRepository.getTournamentEntryIdsUncached = original;
		}
	});
});

describe("tournamentsService.getTournamentEventResults", () => {
	it("delegates to tournamentsRepository with the same args", async () => {
		const original = tournamentsRepository.getTournamentEventResults;
		const context = {} as unknown as GraphQLContext;
		const tournament = {
			id: 1,
			name: "T1",
			creator: "alice",
			adminEntryId: 10,
			leagueId: 20,
			leagueType: LeagueType.CLASSIC,
			totalTeamNum: 8,
			tournamentMode: TournamentMode.NORMAL,
			groupMode: null,
			groupTeamNum: null,
			groupNum: null,
			groupStartedEventId: null,
			groupEndedEventId: null,
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
			createdAt: "2026-04-21T00:00:00.000Z",
			updatedAt: "2026-04-21T00:00:00.000Z",
		};
		const expected: TournamentEventResult[] = [
			{
				tournament,
				eventId: 33,
				groupId: 1,
				entryId: 123,
				entryName: "Entry",
				playerName: "Player",
				eventGroupRank: 1,
				eventPoints: 90,
				eventCost: 0,
				eventNetPoints: 90,
				eventRank: 10,
				overallPoints: 1900,
				overallRank: 100,
				eventChip: "bboost",
				captainId: 430,
				captainPoints: 12,
				teamValue: 1030,
				bank: 25,
			},
		];

		let capturedTournamentId = -1;
		let capturedEventId = -1;
		tournamentsRepository.getTournamentEventResults = async (
			inputContext: GraphQLContext,
			tournamentId: number,
			eventId: number
		): Promise<TournamentEventResult[]> => {
			expect(inputContext).toBe(context);
			capturedTournamentId = tournamentId;
			capturedEventId = eventId;
			return expected;
		};

		try {
			const result = await tournamentsService.getTournamentEventResults(context, 1, 33, null, null);
			expect(capturedTournamentId).toBe(1);
			expect(capturedEventId).toBe(33);
			expect(result).toEqual(expected);
		} finally {
			tournamentsRepository.getTournamentEventResults = original;
		}
	});
});

describe("tournamentsService.getTournamentEntryRankingSummary", () => {
	it("delegates to tournamentsRepository with the same args", async () => {
		const original = tournamentsRepository.getTournamentEntryRankingSummary;
		const context = {} as unknown as GraphQLContext;
		const expected: TournamentEntryRankingSummary = {
			eventId: 33,
			entryId: 123,
			overallRank: 100,
			tournamentOverallRank: 1,
			teamValue: 1030,
			tournamentTeamValueRank: 2,
			transfersNum: 4,
			tournamentTransfersRank: 3,
			totalCosts: 8,
			tournamentCostsRank: 4,
			totalBenchPoints: 22,
			tournamentBenchPointsRank: 1,
			autoSubPoints: 10,
			tournamentAutoSubRank: 2,
			overallPoints: 1100,
			leaderOverallPoints: 1180,
			gapToLeader: 80,
			pointsBehindNext: 40,
			pointsAheadOfPrev: 15,
		};

		let capturedTournamentId = -1;
		let capturedEventId = -1;
		let capturedEntryId = -1;
		tournamentsRepository.getTournamentEntryRankingSummary = async (
			inputContext: GraphQLContext,
			tournamentId: number,
			eventId: number,
			entryId: number
		): Promise<TournamentEntryRankingSummary> => {
			expect(inputContext).toBe(context);
			capturedTournamentId = tournamentId;
			capturedEventId = eventId;
			capturedEntryId = entryId;
			return expected;
		};

		try {
			const result = await tournamentsService.getTournamentEntryRankingSummary(context, 1, 33, 123);
			expect(capturedTournamentId).toBe(1);
			expect(capturedEventId).toBe(33);
			expect(capturedEntryId).toBe(123);
			expect(result).toEqual(expected);
		} finally {
			tournamentsRepository.getTournamentEntryRankingSummary = original;
		}
	});
});

describe("tournamentsService.getTournamentSeasonSnapshot", () => {
	it("delegates to tournamentsRepository with the same args", async () => {
		const original = tournamentsRepository.getTournamentSeasonSnapshot;
		const context = {} as unknown as GraphQLContext;
		const expected: TournamentSeasonSnapshot = {
			asOfEventId: 33,
			entryCount: 0,
			leaderOverallPoints: null,
			secondOverallPoints: null,
			gapFirstSecond: null,
			averageOverallPoints: null,
			metrics: [],
			standings: [],
		};

		tournamentsRepository.getTournamentSeasonSnapshot = async (
			inputContext,
			tournamentId,
			eventId
		) => {
			expect(inputContext).toBe(context);
			expect(tournamentId).toBe(7);
			expect(eventId).toBe(33);
			return expected;
		};

		try {
			expect(await tournamentsService.getTournamentSeasonSnapshot(context, 7, 33)).toBe(expected);
		} finally {
			tournamentsRepository.getTournamentSeasonSnapshot = original;
		}
	});
});

describe("tournamentsService.getTournamentBattleGroupResults", () => {
	it("delegates to tournamentsRepository with the same args", async () => {
		const original = tournamentsRepository.getTournamentBattleGroupResults;
		const context = {} as unknown as GraphQLContext;
		const expected: TournamentBattleGroupResult[] = [
			{
				tournament: {
					id: 7,
					name: "H2H League",
					creator: "tong",
					adminEntryId: 100,
					leagueId: 24221,
					leagueType: LeagueType.H2H,
					totalTeamNum: 16,
					tournamentMode: TournamentMode.NORMAL,
					groupMode: null,
					groupTeamNum: null,
					groupNum: null,
					groupStartedEventId: null,
					groupEndedEventId: null,
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
					createdAt: "2026-04-21T00:00:00.000Z",
					updatedAt: "2026-04-21T00:00:00.000Z",
				},
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
			},
		];

		let capturedTournamentId = -1;
		let capturedEventId = -1;
		tournamentsRepository.getTournamentBattleGroupResults = async (
			inputContext: GraphQLContext,
			tournamentId: number,
			eventId: number
		): Promise<TournamentBattleGroupResult[]> => {
			expect(inputContext).toBe(context);
			capturedTournamentId = tournamentId;
			capturedEventId = eventId;
			return expected;
		};

		try {
			const result = await tournamentsService.getTournamentBattleGroupResults(context, 7, 15);
			expect(capturedTournamentId).toBe(7);
			expect(capturedEventId).toBe(15);
			expect(result).toEqual(expected);
		} finally {
			tournamentsRepository.getTournamentBattleGroupResults = original;
		}
	});
});
