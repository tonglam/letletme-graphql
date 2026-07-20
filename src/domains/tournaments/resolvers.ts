import type { GraphQLContext } from "../../graphql/context";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import { LeagueType } from "../leagues/repository";
import type { Player } from "../players/repository";
import { playersService } from "../players/service";

/**
 * Per-request memoization for event lookups to avoid N+1 Redis round-trips
 * when resolving the `event` field on multiple TournamentEventResult rows.
 */
const eventMemo = new WeakMap<GraphQLContext, Map<number, Event | null>>();

const getEventByIdMemoized = async (
	context: GraphQLContext,
	eventId: number
): Promise<Event | null> => {
	let memo = eventMemo.get(context);
	if (!memo) {
		memo = new Map();
		eventMemo.set(context, memo);
	}
	const cached = memo.get(eventId);
	if (cached !== undefined) {
		return cached;
	}
	const event = await eventsService.getEventById(context, eventId);
	memo.set(eventId, event);
	return event;
};

const captainMemo = new WeakMap<GraphQLContext, Map<number, Player | null>>();

const getCaptainByIdMemoized = async (
	context: GraphQLContext,
	playerId: number
): Promise<Player | null> => {
	let memo = captainMemo.get(context);
	if (!memo) {
		memo = new Map();
		captainMemo.set(context, memo);
	}
	const cached = memo.get(playerId);
	if (cached !== undefined) {
		return cached;
	}
	const player = await playersService.getPlayerById(context, playerId);
	memo.set(playerId, player);
	return player;
};

import type {
	EntryH2HMatchResult,
	TournamentBattleGroupResult,
	TournamentEntryRankingSummary,
	TournamentEventResult,
	TournamentInfo,
	TournamentMode,
} from "./repository";
import { GroupMode, KnockoutMode, TournamentState } from "./repository";
import { tournamentsService } from "./service";

type EntryTournamentsArgs = {
	entryId: number;
};

type TournamentEntryIdsArgs = {
	tournamentId: number;
};

type TournamentEventResultsArgs = {
	tournamentId: number;
	eventId: number;
};

type TournamentEntryRankingSummaryArgs = {
	tournamentId: number;
	eventId: number;
	entryId: number;
};

type TournamentBattleGroupResultsArgs = {
	tournamentId: number;
	eventId: number;
};

type EntryH2HMatchResultsArgs = {
	entryId: number;
};

export const leagueTypeToEnum = (type: LeagueType): string => {
	return type === LeagueType.H2H ? "H2H" : "CLASSIC";
};

export const tournamentModeToEnum = (_mode: TournamentMode): string => {
	return "NORMAL";
};

export const groupModeToEnum = (mode: GroupMode | null): string | null => {
	if (mode === null) {
		return null;
	}
	if (mode === GroupMode.POINTS_RACES) {
		return "POINTS_RACES";
	}
	if (mode === GroupMode.BATTLE_RACES) {
		return "BATTLE_RACES";
	}
	return "NO_GROUP";
};

export const knockoutModeToEnum = (mode: KnockoutMode | null): string | null => {
	if (mode === null) {
		return null;
	}
	if (mode === KnockoutMode.SINGLE_ELIMINATION) {
		return "SINGLE_ELIMINATION";
	}
	if (mode === KnockoutMode.DOUBLE_ELIMINATION) {
		return "DOUBLE_ELIMINATION";
	}
	if (mode === KnockoutMode.HEAD_TO_HEAD) {
		return "HEAD_TO_HEAD";
	}
	return "NO_KNOCKOUT";
};

export const tournamentStateToEnum = (state: TournamentState): string => {
	if (state === TournamentState.INACTIVE) {
		return "INACTIVE";
	}
	if (state === TournamentState.FINISHED) {
		return "FINISHED";
	}
	return "ACTIVE";
};

export const tournamentResultChipToEnum = (raw: string | null): string | null => {
	if (raw === null) {
		return null;
	}

	const value = raw.toUpperCase().trim();
	const compactValue = value.replace(/[^A-Z0-9]/g, "");
	if (
		value === "BENCH_BOOST" ||
		compactValue === "BENCHBOOST" ||
		compactValue === "BBOOST" ||
		compactValue === "BB"
	) {
		return "BENCH_BOOST";
	}
	if (
		value === "TRIPLE_CAPTAIN" ||
		compactValue === "TRIPLECAPTAIN" ||
		compactValue === "3XC" ||
		compactValue === "TC"
	) {
		return "TRIPLE_CAPTAIN";
	}
	if (value === "FREE_HIT" || compactValue === "FREEHIT" || compactValue === "FH") {
		return "FREE_HIT";
	}
	if (value === "WILDCARD" || compactValue === "WILDCARD" || compactValue === "WC") {
		return "WILDCARD";
	}

	return null;
};

export const tournamentsResolvers = {
	Query: {
		entryTournaments: async (
			_parent: unknown,
			args: EntryTournamentsArgs,
			context: GraphQLContext
		): Promise<TournamentInfo[]> => tournamentsService.getEntryTournaments(context, args.entryId),

		tournamentEntryIds: async (
			_parent: unknown,
			args: TournamentEntryIdsArgs,
			context: GraphQLContext
		): Promise<number[]> => tournamentsService.getTournamentEntryIds(context, args.tournamentId),

		tournamentEventResults: async (
			_parent: unknown,
			args: TournamentEventResultsArgs,
			context: GraphQLContext
		): Promise<TournamentEventResult[]> =>
			tournamentsService.getTournamentEventResults(context, args.tournamentId, args.eventId),

		tournamentEntryRankingSummary: async (
			_parent: unknown,
			args: TournamentEntryRankingSummaryArgs,
			context: GraphQLContext
		): Promise<TournamentEntryRankingSummary> =>
			tournamentsService.getTournamentEntryRankingSummary(
				context,
				args.tournamentId,
				args.eventId,
				args.entryId
			),

		tournamentBattleGroupResults: async (
			_parent: unknown,
			args: TournamentBattleGroupResultsArgs,
			context: GraphQLContext
		): Promise<TournamentBattleGroupResult[]> =>
			tournamentsService.getTournamentBattleGroupResults(context, args.tournamentId, args.eventId),

		entryH2HMatchResults: async (
			_parent: unknown,
			args: EntryH2HMatchResultsArgs,
			context: GraphQLContext
		): Promise<EntryH2HMatchResult[]> =>
			tournamentsService.getEntryH2HMatchResults(context, args.entryId),
	},
	TournamentInfo: {
		leagueType: (parent: TournamentInfo): string => leagueTypeToEnum(parent.leagueType),
		tournamentMode: (parent: TournamentInfo): string => tournamentModeToEnum(parent.tournamentMode),
		groupMode: (parent: TournamentInfo): string | null => groupModeToEnum(parent.groupMode),
		knockoutMode: (parent: TournamentInfo): string | null =>
			knockoutModeToEnum(parent.knockoutMode),
		state: (parent: TournamentInfo): string => tournamentStateToEnum(parent.state),
	},
	TournamentEventResult: {
		tournament: (parent: TournamentEventResult): TournamentInfo => parent.tournament,
		event: async (
			parent: TournamentEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		captain: async (
			parent: TournamentEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Player | null> => {
			if (parent.captainId === null || parent.captainId <= 0) {
				return null;
			}
			return getCaptainByIdMemoized(context, parent.captainId);
		},
		eventChip: (parent: TournamentEventResult): string | null =>
			tournamentResultChipToEnum(parent.eventChip),
	},
	TournamentBattleGroupResult: {
		tournament: (parent: TournamentBattleGroupResult): TournamentInfo => parent.tournament,
		event: async (
			parent: TournamentBattleGroupResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
	},
};
