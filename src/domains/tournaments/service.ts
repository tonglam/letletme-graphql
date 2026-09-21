import type { GraphQLContext } from "../../graphql/context";
import { GraphQLError } from "graphql";
import { MAX_TOURNAMENT_DESK_ENTRIES } from "../live-desks/tournament-entry-window";
import type {
	EntryH2HMatchResult,
	TournamentOfficialH2HHistory,
	TournamentBattleGroupResult,
	TournamentEntryRankingSummary,
	TournamentEventResult,
	TournamentInfo,
	TournamentParticipant,
	TournamentSeasonSnapshot,
	TournamentDetailDesk,
	ManagedTournamentStatus,
} from "./repository";
import { tournamentsRepository } from "./repository";

export type H2HLiveFallbackCandidate = {
	entryIds: readonly number[];
	viewerMatch: boolean;
};

export const selectH2HLiveFallbackEntryWindow = (
	candidates: readonly H2HLiveFallbackCandidate[],
	limit = MAX_TOURNAMENT_DESK_ENTRIES
): { entryIds: number[]; deferredEntryIds: number[] } => {
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new RangeError("H2H live fallback entry limit must be a positive integer");
	}
	const normalized = candidates.map((candidate) => ({
		entryIds: [...new Set(candidate.entryIds)],
		viewerMatch: candidate.viewerMatch,
	}));
	const ordered = [
		...normalized.filter((candidate) => candidate.viewerMatch),
		...normalized.filter((candidate) => !candidate.viewerMatch),
	];
	const selected = new Set<number>();
	for (const candidate of ordered) {
		const newEntryIds = candidate.entryIds.filter((entryId) => !selected.has(entryId));
		if (selected.size + newEntryIds.length > limit) continue;
		for (const entryId of newEntryIds) selected.add(entryId);
	}
	const allEntryIds = new Set(normalized.flatMap((candidate) => candidate.entryIds));
	return {
		entryIds: [...selected],
		deferredEntryIds: [...allEntryIds].filter((entryId) => !selected.has(entryId)),
	};
};

export const assertTournamentStandingsReady = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentInfo> => {
	const tournament = await tournamentsRepository.getTournamentInfoUncached(context, tournamentId);
	if (!tournament?.standingsReadyAt) {
		throw new GraphQLError("Tournament standings are still being prepared", {
			extensions: { code: "TOURNAMENT_STANDINGS_NOT_READY" },
		});
	}
	return tournament;
};

export const assertTournamentInsightsReady = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentInfo> => {
	const tournament = await assertTournamentStandingsReady(context, tournamentId);
	if (
		tournament.setupStatus !== "ready" ||
		tournament.setupPhase !== "ready" ||
		!tournament.insightsReadyAt
	) {
		throw new GraphQLError("Tournament insights are still being prepared", {
			extensions: { code: "TOURNAMENT_INSIGHTS_NOT_READY" },
		});
	}
	return tournament;
};

export const tournamentsService = {
	getTournamentInfoUncached(
		context: GraphQLContext,
		tournamentId: number
	): Promise<TournamentInfo | null> {
		return tournamentsRepository.getTournamentInfoUncached(context, tournamentId);
	},

	getTournamentForMember(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		return tournamentsRepository.getTournamentForMember(context, tournamentId, entryId);
	},

	getTournamentMemberEntryIds(
		context: GraphQLContext,
		tournamentId: number,
		entryIds: number[]
	): Promise<number[]> {
		return tournamentsRepository.getTournamentMemberEntryIds(context, tournamentId, entryIds);
	},

	getManagedTournament(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		return tournamentsRepository.getManagedTournament(context, tournamentId, entryId);
	},

	getTournamentParticipants(
		context: GraphQLContext,
		tournamentId: number
	): Promise<TournamentParticipant[]> {
		return tournamentsRepository.getTournamentParticipants(context, tournamentId);
	},

	getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]> {
		return tournamentsRepository.getEntryTournaments(context, entryId);
	},

	getEntryParticipatingTournaments(
		context: GraphQLContext,
		entryId: number
	): Promise<TournamentInfo[]> {
		return tournamentsRepository.getEntryParticipatingTournaments(context, entryId);
	},

	getManageableTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]> {
		return tournamentsRepository.getManageableTournaments(context, entryId);
	},

	getTournamentEntryIds(context: GraphQLContext, tournamentId: number): Promise<number[]> {
		return tournamentsRepository.getTournamentEntryIds(context, tournamentId);
	},

	getTournamentEntryIdsUncached(context: GraphQLContext, tournamentId: number): Promise<number[]> {
		return tournamentsRepository.getTournamentEntryIdsUncached(context, tournamentId);
	},

	getTournamentEventResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number | null,
		offset: number | null
	): Promise<TournamentEventResult[]> {
		return tournamentsRepository.getTournamentEventResults(
			context,
			tournamentId,
			eventId,
			limit,
			offset
		);
	},

	getTournamentEntryRankingSummary(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number
	): Promise<TournamentEntryRankingSummary> {
		return tournamentsRepository.getTournamentEntryRankingSummary(
			context,
			tournamentId,
			eventId,
			entryId
		);
	},

	getTournamentSeasonSnapshot(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentSeasonSnapshot> {
		return tournamentsRepository.getTournamentSeasonSnapshot(context, tournamentId, eventId);
	},

	getTournamentBattleGroupResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentBattleGroupResult[]> {
		return tournamentsRepository.getTournamentBattleGroupResults(context, tournamentId, eventId);
	},

	async getEntryH2HMatchResults(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryH2HMatchResult[]> {
		return tournamentsRepository.getEntryH2HMatchResults(context, entryId);
	},

	getTournamentOfficialH2HHistory(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number,
		limit?: number | null
	): Promise<TournamentOfficialH2HHistory> {
		return tournamentsRepository.getTournamentOfficialH2HHistory(
			context,
			tournamentId,
			eventId,
			entryId,
			limit
		);
	},

	getTournamentDetailDesk(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number,
		eventId?: number | null
	): Promise<TournamentDetailDesk | null> {
		return tournamentsRepository.getTournamentDetailDesk(context, tournamentId, entryId, eventId);
	},

	getManagedTournamentStatus(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<ManagedTournamentStatus | null> {
		return tournamentsRepository.getManagedTournamentStatus(context, tournamentId, entryId);
	},
};
