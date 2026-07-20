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
	TournamentMode,
	TournamentState,
} from "../../../src/domains/tournaments/repository";
import {
	groupModeToEnum,
	knockoutModeToEnum,
	leagueTypeToEnum,
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
