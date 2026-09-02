import { describe, expect, it } from "bun:test";
import type { Event } from "../../../src/domains/events/repository";
import { eventsService } from "../../../src/domains/events/service";
import { LeagueType } from "../../../src/domains/leagues/repository";
import { Position } from "../../../src/domains/players/repository";
import { playersService } from "../../../src/domains/players/service";
import {
	GroupMode,
	KnockoutMode,
	type TournamentBattleGroupResult,
	type TournamentEventResult,
	type TournamentSeasonSnapshot,
	TournamentMode,
	TournamentSetupStatus,
	TournamentState,
	tournamentsRepository,
} from "../../../src/domains/tournaments/repository";
import {
	groupModeToEnum,
	h2hMatchRevisionVectorV2,
	knockoutModeToEnum,
	leagueTypeToEnum,
	officialH2HStandingsStateV2,
	tournamentResultChipToEnum,
	tournamentStateToEnum,
	tournamentsResolvers,
} from "../../../src/domains/tournaments/resolvers";
import { tournamentsService } from "../../../src/domains/tournaments/service";
import type { GraphQLContext } from "../../../src/graphql/context";

describe("tournaments resolver enum mappers", () => {
	it("maps league type to GraphQL enum", () => {
		expect(leagueTypeToEnum(LeagueType.CLASSIC)).toBe("CLASSIC");
		expect(leagueTypeToEnum(LeagueType.H2H)).toBe("H2H");
	});

	it("maps group mode including null", () => {
		expect(groupModeToEnum(null)).toBeNull();
		expect(groupModeToEnum(GroupMode.NO_GROUP)).toBe("NO_GROUP");
		expect(groupModeToEnum(GroupMode.POINTS_RACES)).toBe("POINTS_RACES");
		expect(groupModeToEnum(GroupMode.BATTLE_RACES)).toBe("BATTLE_RACES");
	});

	it("maps knockout mode including null", () => {
		expect(knockoutModeToEnum(null)).toBeNull();
		expect(knockoutModeToEnum(KnockoutMode.NO_KNOCKOUT)).toBe("NO_KNOCKOUT");
		expect(knockoutModeToEnum(KnockoutMode.SINGLE_ELIMINATION)).toBe("SINGLE_ELIMINATION");
		expect(knockoutModeToEnum(KnockoutMode.DOUBLE_ELIMINATION)).toBe("DOUBLE_ELIMINATION");
		expect(knockoutModeToEnum(KnockoutMode.HEAD_TO_HEAD)).toBe("HEAD_TO_HEAD");
	});

	it("maps tournament state to GraphQL enum", () => {
		expect(tournamentStateToEnum(TournamentState.ACTIVE)).toBe("ACTIVE");
		expect(tournamentStateToEnum(TournamentState.INACTIVE)).toBe("INACTIVE");
		expect(tournamentStateToEnum(TournamentState.FINISHED)).toBe("FINISHED");
	});

	it("maps tournament result chip strings to GraphQL enum", () => {
		expect(tournamentResultChipToEnum("bboost")).toBe("BENCH_BOOST");
		expect(tournamentResultChipToEnum("freehit")).toBe("FREE_HIT");
		expect(tournamentResultChipToEnum("wc")).toBe("WILDCARD");
		expect(tournamentResultChipToEnum("unknown")).toBeNull();
		expect(tournamentResultChipToEnum(null)).toBeNull();
	});
});

describe("official H2H standings overlay state", () => {
	const read = (overrides: Record<string, unknown> = {}) =>
		({
			publication: { state: "FINALIZED" },
			payload: {
				standings: {
					state: "READY",
					throughEventId: 4,
				},
			},
			servedFrom: "REDIS_CURRENT",
			...overrides,
		}) as never;

	it("uses only the independent standings publication state", () => {
		expect(officialH2HStandingsStateV2(read())).toBe("READY");
		expect(officialH2HStandingsStateV2(read(), false)).toBe("UPDATING");
		expect(officialH2HStandingsStateV2(read({ servedFrom: "REDIS_PREVIOUS" }))).toBe("STALE");
		expect(officialH2HStandingsStateV2(read({ publication: { state: "LIVE_ACTIVE" } }))).toBe(
			"UPDATING"
		);
		expect(
			officialH2HStandingsStateV2(
				read({
					payload: { standings: { state: "UPDATING", throughEventId: 4 } },
				})
			)
		).toBe("UPDATING");
		expect(officialH2HStandingsStateV2(null)).toBe("UNAVAILABLE");
	});
});

describe("official H2H match revision vectors", () => {
	const global = {
		publication: {
			publicationId: "00000000-0000-4000-8000-000000000001",
			generation: 4,
			revisions: {
				scoreCore: { revision: "1".repeat(64) },
				fixtureIdentity: { revision: "2".repeat(64) },
				rules: { revision: "3".repeat(64) },
				algorithm: { revision: "4".repeat(64) },
			},
		},
	} as unknown as Parameters<typeof h2hMatchRevisionVectorV2>[2];
	const publication = {
		publicationId: "00000000-0000-4000-8000-000000000010",
		generation: 8,
		revisions: {},
	} as unknown as Parameters<typeof h2hMatchRevisionVectorV2>[0];
	const match = {
		contractVersion: "live-points-v2",
		season: "2627",
		eventId: 1,
		tournamentId: 7,
		officialMatchId: 99,
		groupId: 1,
		sourceOrder: 0,
		phase: "REGULAR",
		knockoutName: null,
		tiebreak: null,
		isBye: false,
		state: "READY",
		sourceCheckedAt: "2026-09-02T00:00:00.000Z",
		globalRef: {
			publicationId: "00000000-0000-4000-8000-000000000001",
			generation: 4,
		},
		home: {
			entryId: 101,
			entryName: "Home",
			playerName: "Home manager",
			isAverage: false,
			officialNetPoints: null,
			inputPublicationId: "00000000-0000-4000-8000-000000000011",
			inputGeneration: 1,
			inputRevision: "5".repeat(64),
			inputContentUpdatedAt: "2026-09-02T00:00:00.000Z",
			input: {},
		},
		away: {
			entryId: null,
			entryName: "Average",
			playerName: null,
			isAverage: true,
			officialNetPoints: 65,
			inputPublicationId: null,
			inputGeneration: null,
			inputRevision: null,
			inputContentUpdatedAt: null,
			input: null,
		},
	} as unknown as Parameters<typeof h2hMatchRevisionVectorV2>[1];

	it("does not copy unrelated head revisions into a retained match", () => {
		const first = h2hMatchRevisionVectorV2(publication, match, global);
		const changedHead = h2hMatchRevisionVectorV2({ ...publication, generation: 9 }, match, global);
		expect(changedHead).toEqual(first);
		expect(first.publicationId).toBe(match.globalRef.publicationId);
		expect(first.generation).toBe(match.globalRef.generation);
		expect(first.averageSide).not.toBeNull();

		const changedScore = h2hMatchRevisionVectorV2(
			publication,
			{ ...match, away: { ...match.away, officialNetPoints: 66 } },
			global
		);
		expect(changedScore.content).not.toBe(first.content);
		expect(changedScore.averageSide).not.toBe(first.averageSide);
		expect(changedScore.scoreCore).toBe(first.scoreCore);
	});
});

describe("TournamentEventResult resolvers", () => {
	it("returns the embedded tournament and normalizes event chip", () => {
		const parent: TournamentEventResult = {
			tournament: {
				id: 1,
				name: "T1",
				creator: "alice",
				adminEntryId: 10,
				leagueId: 20,
				leagueType: LeagueType.CLASSIC,
				totalTeamNum: 8,
				tournamentMode: TournamentMode.NORMAL,
				groupMode: GroupMode.POINTS_RACES,
				groupTeamNum: 4,
				groupNum: 2,
				groupStartedEventId: 1,
				groupEndedEventId: 2,
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
		};

		expect(tournamentsResolvers.TournamentEventResult.tournament(parent)).toBe(parent.tournament);
		expect(tournamentsResolvers.TournamentEventResult.eventChip(parent)).toBe("BENCH_BOOST");
	});

	it("resolves the event through eventsService", async () => {
		const original = eventsService.getEventById;
		const context = {} as unknown as GraphQLContext;
		const event = { id: 33, name: "GW 33" } as Event;

		eventsService.getEventById = async (
			inputContext: GraphQLContext,
			eventId: number
		): Promise<Event | null> => {
			expect(inputContext).toBe(context);
			expect(eventId).toBe(33);
			return event;
		};

		try {
			const result = await tournamentsResolvers.TournamentEventResult.event(
				{
					tournament: {} as never,
					eventId: 33,
				} as unknown as TournamentEventResult,
				{},
				context
			);
			expect(result).toBe(event);
		} finally {
			eventsService.getEventById = original;
		}
	});

	it("resolves event through eventsService for TournamentBattleGroupResult", async () => {
		const original = eventsService.getEventById;
		const context = {} as unknown as GraphQLContext;
		const event = { id: 15, name: "GW 15" } as Event;

		eventsService.getEventById = async (
			inputContext: GraphQLContext,
			eventId: number
		): Promise<Event | null> => {
			expect(inputContext).toBe(context);
			expect(eventId).toBe(15);
			return event;
		};

		try {
			const result = await tournamentsResolvers.TournamentBattleGroupResult.event(
				{ tournament: {} as never, eventId: 15 } as unknown as TournamentBattleGroupResult,
				{},
				context
			);
			expect(result).toBe(event);
		} finally {
			eventsService.getEventById = original;
		}
	});

	it("resolves captain through playersService", async () => {
		const original = playersService.getPlayerById;
		const context = {} as unknown as GraphQLContext;
		const captain = {
			id: 430,
			code: 1,
			webName: "Salah",
			firstName: "Mo",
			secondName: "Salah",
			teamId: 12,
			position: Position.MIDFIELDER,
			price: 130,
			startPrice: 125,
			totalPoints: 200,
			selectedByPercent: 40.1,
		};

		playersService.getPlayerById = async (inputContext: GraphQLContext, playerId: number) => {
			expect(inputContext).toBe(context);
			expect(playerId).toBe(430);
			return captain;
		};

		try {
			const result = await tournamentsResolvers.TournamentEventResult.captain(
				{
					tournament: {} as never,
					eventId: 33,
					captainId: 430,
				} as unknown as TournamentEventResult,
				{},
				context
			);
			expect(result).toEqual(captain);
		} finally {
			playersService.getPlayerById = original;
		}
	});
});

describe("tournamentBattleGroupResults query resolver", () => {
	it("delegates to tournamentsService with correct args", async () => {
		const original = tournamentsService.getTournamentBattleGroupResults;
		const originalReadiness = tournamentsRepository.getTournamentInfoUncached;
		const context = {} as unknown as GraphQLContext;
		const expected: TournamentBattleGroupResult[] = [];

		let capturedTournamentId = -1;
		let capturedEventId = -1;
		tournamentsService.getTournamentBattleGroupResults = async (
			inputContext: GraphQLContext,
			tournamentId: number,
			eventId: number
		) => {
			expect(inputContext).toBe(context);
			capturedTournamentId = tournamentId;
			capturedEventId = eventId;
			return expected;
		};
		tournamentsRepository.getTournamentInfoUncached = async () =>
			({ standingsReadyAt: "2026-08-04T00:00:00.000Z" }) as never;

		try {
			const result = await tournamentsResolvers.Query.tournamentBattleGroupResults(
				undefined,
				{ tournamentId: 7, eventId: 15 },
				context
			);
			expect(capturedTournamentId).toBe(7);
			expect(capturedEventId).toBe(15);
			expect(result).toBe(expected);
		} finally {
			tournamentsService.getTournamentBattleGroupResults = original;
			tournamentsRepository.getTournamentInfoUncached = originalReadiness;
		}
	});

	it("returns tournament pass-through from TournamentBattleGroupResult resolver", () => {
		const tournamentStub = { id: 7 } as never;
		const parent = {
			tournament: tournamentStub,
			eventId: 15,
		} as unknown as TournamentBattleGroupResult;
		expect(tournamentsResolvers.TournamentBattleGroupResult.tournament(parent)).toBe(
			tournamentStub
		);
	});
});

describe("tournamentSeasonSnapshot query resolver", () => {
	it("checks insights readiness and delegates to tournamentsService", async () => {
		const original = tournamentsService.getTournamentSeasonSnapshot;
		const originalReadiness = tournamentsRepository.getTournamentInfoUncached;
		const context = {} as unknown as GraphQLContext;
		const expected: TournamentSeasonSnapshot = {
			asOfEventId: 15,
			entryCount: 0,
			leaderOverallPoints: null,
			secondOverallPoints: null,
			gapFirstSecond: null,
			averageOverallPoints: null,
			metrics: [],
			standings: [],
		};

		tournamentsRepository.getTournamentInfoUncached = async (inputContext, tournamentId) => {
			expect(inputContext).toBe(context);
			expect(tournamentId).toBe(7);
			return {
				id: 7,
				standingsReadyAt: "2026-08-04T00:00:00.000Z",
				setupStatus: "ready",
				setupPhase: "ready",
				insightsReadyAt: "2026-08-04T00:00:00.000Z",
				setupHasWarnings: false,
			} as never;
		};
		tournamentsService.getTournamentSeasonSnapshot = async (
			inputContext,
			tournamentId,
			eventId
		) => {
			expect(inputContext).toBe(context);
			expect(tournamentId).toBe(7);
			expect(eventId).toBe(15);
			return expected;
		};

		try {
			expect(
				await tournamentsResolvers.Query.tournamentSeasonSnapshot(
					undefined,
					{ tournamentId: 7, eventId: 15 },
					context
				)
			).toBe(expected);
		} finally {
			tournamentsService.getTournamentSeasonSnapshot = original;
			tournamentsRepository.getTournamentInfoUncached = originalReadiness;
		}
	});
});
