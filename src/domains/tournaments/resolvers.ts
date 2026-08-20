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
	EntryOfficialH2HDeskItem,
	TournamentBattleGroupResult,
	TournamentEntryRankingSummary,
	TournamentEventResult,
	TournamentInfo,
	TournamentOfficialH2H,
	TournamentMode,
	TournamentParticipant,
	TournamentSeasonSnapshot,
	TournamentSetupStatus,
	TournamentDetailDesk,
	ManagedTournamentStatus,
	TournamentSetupIssueDiagnostic,
	TournamentSetupWarningSummary,
	TournamentSetupWarningCategory,
	TournamentSetupIssueSeverity,
} from "./repository";
import {
	GroupMode,
	KnockoutMode,
	TournamentRosterMode,
	TournamentSetupPhase,
	TournamentState,
	TournamentSetupProgressMode,
} from "./repository";
import {
	assertTournamentInsightsReady,
	assertTournamentStandingsReady,
	tournamentsService,
} from "./service";
import { normalizeTournamentEventResultsPagination } from "./repository";
import { getTournamentSetupWarningSummaries } from "./repository";

const warningSummaryMemo = new WeakMap<
	GraphQLContext,
	Map<number, Promise<TournamentSetupWarningSummary[]>>
>();

const getTournamentSetupWarningSummariesMemoized = (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentSetupWarningSummary[]> => {
	let memo = warningSummaryMemo.get(context);
	if (!memo) {
		memo = new Map();
		warningSummaryMemo.set(context, memo);
	}
	const cached = memo.get(tournamentId);
	if (cached) return cached;
	const request = getTournamentSetupWarningSummaries(context, tournamentId);
	memo.set(tournamentId, request);
	return request;
};

type EntryTournamentsArgs = {
	entryId: number;
};

type TournamentEntryIdsArgs = {
	tournamentId: number;
};

type TournamentMetadataArgs = {
	tournamentId: number;
	entryId: number;
};

type TournamentEventResultsArgs = {
	tournamentId: number;
	eventId: number;
	limit?: number | null;
	offset?: number | null;
};

type TournamentEntryRankingSummaryArgs = {
	tournamentId: number;
	eventId: number;
	entryId: number;
};

type TournamentSeasonSnapshotArgs = {
	tournamentId: number;
	eventId: number;
};

type TournamentBattleGroupResultsArgs = {
	tournamentId: number;
	eventId: number;
};

type EntryH2HMatchResultsArgs = {
	entryId: number;
};

type TournamentOfficialH2HArgs = {
	tournamentId: number;
	eventId: number;
};

type EntryOfficialH2HDeskArgs = {
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

export const tournamentSetupStatusToEnum = (status: TournamentSetupStatus): string =>
	status.toUpperCase();

export const tournamentSetupPhaseToEnum = (phase: TournamentSetupPhase): string =>
	phase.toUpperCase();

export const tournamentSetupProgressModeToEnum = (mode: TournamentSetupProgressMode): string =>
	mode.toUpperCase();

export const tournamentSetupWarningCategoryToEnum = (
	category: TournamentSetupWarningCategory
): string => category.toUpperCase();

export const tournamentSetupIssueSeverityToEnum = (
	severity: TournamentSetupIssueSeverity
): string => severity.toUpperCase();

export const tournamentRosterModeToEnum = (mode: TournamentRosterMode): string =>
	mode.toUpperCase();

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

		tournament: async (
			_parent: unknown,
			args: TournamentMetadataArgs,
			context: GraphQLContext
		): Promise<TournamentInfo | null> =>
			tournamentsService.getTournamentForMember(context, args.tournamentId, args.entryId),

		managedTournament: async (
			_parent: unknown,
			args: TournamentMetadataArgs,
			context: GraphQLContext
		): Promise<TournamentInfo | null> =>
			tournamentsService.getManagedTournament(context, args.tournamentId, args.entryId),

		tournamentParticipants: async (
			_parent: unknown,
			args: TournamentEntryIdsArgs,
			context: GraphQLContext
		): Promise<TournamentParticipant[]> =>
			tournamentsService.getTournamentParticipants(context, args.tournamentId),

		tournamentEntryIds: async (
			_parent: unknown,
			args: TournamentEntryIdsArgs,
			context: GraphQLContext
		): Promise<number[]> => tournamentsService.getTournamentEntryIds(context, args.tournamentId),

		tournamentEventResults: async (
			_parent: unknown,
			args: TournamentEventResultsArgs,
			context: GraphQLContext
		): Promise<TournamentEventResult[]> => {
			const pagination = normalizeTournamentEventResultsPagination(
				args.limit ?? null,
				args.offset ?? null
			);
			await assertTournamentStandingsReady(context, args.tournamentId);
			return tournamentsService.getTournamentEventResults(
				context,
				args.tournamentId,
				args.eventId,
				pagination.limit,
				pagination.offset === 0 && (args.offset === null || args.offset === undefined)
					? null
					: pagination.offset
			);
		},

		tournamentEntryRankingSummary: async (
			_parent: unknown,
			args: TournamentEntryRankingSummaryArgs,
			context: GraphQLContext
		): Promise<TournamentEntryRankingSummary> => {
			await assertTournamentInsightsReady(context, args.tournamentId);
			return tournamentsService.getTournamentEntryRankingSummary(
				context,
				args.tournamentId,
				args.eventId,
				args.entryId
			);
		},

		tournamentSeasonSnapshot: async (
			_parent: unknown,
			args: TournamentSeasonSnapshotArgs,
			context: GraphQLContext
		): Promise<TournamentSeasonSnapshot> => {
			await assertTournamentInsightsReady(context, args.tournamentId);
			return tournamentsService.getTournamentSeasonSnapshot(
				context,
				args.tournamentId,
				args.eventId
			);
		},

		tournamentBattleGroupResults: async (
			_parent: unknown,
			args: TournamentBattleGroupResultsArgs,
			context: GraphQLContext
		): Promise<TournamentBattleGroupResult[]> => {
			await assertTournamentStandingsReady(context, args.tournamentId);
			return tournamentsService.getTournamentBattleGroupResults(
				context,
				args.tournamentId,
				args.eventId
			);
		},

		entryH2HMatchResults: async (
			_parent: unknown,
			args: EntryH2HMatchResultsArgs,
			context: GraphQLContext
		): Promise<EntryH2HMatchResult[]> =>
			tournamentsService.getEntryH2HMatchResults(context, args.entryId),

		tournamentOfficialH2H: async (
			_parent: unknown,
			args: TournamentOfficialH2HArgs,
			context: GraphQLContext
		): Promise<TournamentOfficialH2H> => {
			await assertTournamentStandingsReady(context, args.tournamentId);
			return tournamentsService.getTournamentOfficialH2H(context, args.tournamentId, args.eventId);
		},

		entryOfficialH2HDesk: async (
			_parent: unknown,
			args: EntryOfficialH2HDeskArgs,
			context: GraphQLContext
		): Promise<EntryOfficialH2HDeskItem[]> =>
			tournamentsService.getEntryOfficialH2HDesk(context, args.entryId),

		tournamentDetailDesk: async (
			_parent: unknown,
			args: { tournamentId: number; entryId: number; eventId?: number | null },
			context: GraphQLContext
		): Promise<TournamentDetailDesk | null> =>
			tournamentsService.getTournamentDetailDesk(
				context,
				args.tournamentId,
				args.entryId,
				args.eventId
			),

		managedTournamentStatus: async (
			_parent: unknown,
			args: { tournamentId: number; entryId: number },
			context: GraphQLContext
		): Promise<ManagedTournamentStatus | null> =>
			tournamentsService.getManagedTournamentStatus(context, args.tournamentId, args.entryId),
	},
	TournamentInfo: {
		leagueType: (parent: TournamentInfo): string => leagueTypeToEnum(parent.leagueType),
		tournamentMode: (parent: TournamentInfo): string => tournamentModeToEnum(parent.tournamentMode),
		groupMode: (parent: TournamentInfo): string | null => groupModeToEnum(parent.groupMode),
		knockoutMode: (parent: TournamentInfo): string | null =>
			knockoutModeToEnum(parent.knockoutMode),
		state: (parent: TournamentInfo): string => tournamentStateToEnum(parent.state),
		setupStatus: (parent: TournamentInfo): string => {
			if (!parent.setupStatus) throw new Error("Tournament setup status is unavailable");
			return tournamentSetupStatusToEnum(parent.setupStatus);
		},
		setupPhase: (parent: TournamentInfo): string =>
			tournamentSetupPhaseToEnum(parent.setupPhase ?? TournamentSetupPhase.READY),
		setupProgressMode: (parent: TournamentInfo): string =>
			tournamentSetupProgressModeToEnum(
				parent.setupProgressMode ?? TournamentSetupProgressMode.DETERMINATE
			),
		rosterMode: (parent: TournamentInfo): string =>
			tournamentRosterModeToEnum(parent.rosterMode ?? TournamentRosterMode.SNAPSHOT),
		rosterSyncStatus: (parent: TournamentInfo): string | null =>
			parent.rosterSyncStatus ? tournamentSetupStatusToEnum(parent.rosterSyncStatus) : null,
		warningSummaries: async (
			parent: TournamentInfo,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<TournamentSetupWarningSummary[]> =>
			parent.warningSummaries ?? getTournamentSetupWarningSummariesMemoized(context, parent.id),
	},
	TournamentSetupWarningSummary: {
		category: (parent: TournamentSetupWarningSummary): string =>
			tournamentSetupWarningCategoryToEnum(parent.category),
	},
	TournamentSetupIssueDiagnostic: {
		category: (parent: TournamentSetupIssueDiagnostic): string =>
			tournamentSetupWarningCategoryToEnum(parent.category),
		severity: (parent: TournamentSetupIssueDiagnostic): string =>
			tournamentSetupIssueSeverityToEnum(parent.severity),
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
	TournamentDetailDesk: {
		kind: (parent: TournamentDetailDesk): string => parent.kind.toUpperCase(),
	},
	TournamentSetupDesk: {
		status: (parent: NonNullable<TournamentDetailDesk["setup"]>): string =>
			tournamentSetupStatusToEnum(parent.status),
		phase: (parent: NonNullable<TournamentDetailDesk["setup"]>): string =>
			tournamentSetupPhaseToEnum(parent.phase),
		progressMode: (parent: NonNullable<TournamentDetailDesk["setup"]>): string =>
			tournamentSetupProgressModeToEnum(parent.progressMode),
		warningSummaries: async (
			parent: NonNullable<TournamentDetailDesk["setup"]>,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<TournamentSetupWarningSummary[]> =>
			parent.warningSummaries.length > 0 || !parent.__tournamentId
				? parent.warningSummaries
				: getTournamentSetupWarningSummariesMemoized(context, parent.__tournamentId),
	},
	ManagedTournamentStatus: {
		state: (parent: ManagedTournamentStatus): string => tournamentStateToEnum(parent.state),
		setupStatus: (parent: ManagedTournamentStatus): string =>
			tournamentSetupStatusToEnum(parent.setupStatus),
		setupPhase: (parent: ManagedTournamentStatus): string =>
			tournamentSetupPhaseToEnum(parent.setupPhase),
		rosterSyncStatus: (parent: ManagedTournamentStatus): string | null =>
			parent.rosterSyncStatus ? tournamentSetupStatusToEnum(parent.rosterSyncStatus) : null,
		setupProgressMode: (parent: ManagedTournamentStatus): string =>
			tournamentSetupProgressModeToEnum(parent.setupProgressMode),
		warningSummaries: (parent: ManagedTournamentStatus): TournamentSetupWarningSummary[] =>
			parent.warningSummaries,
	},
};
