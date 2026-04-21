import type { GraphQLContext } from '../../graphql/context';
import { LeagueType } from '../leagues/repository';
import { GroupMode, KnockoutMode, TournamentState } from './repository';
import type { TournamentInfo, TournamentMode } from './repository';
import { tournamentsService } from './service';

type EntryTournamentsArgs = {
  entryId: number;
};

export const leagueTypeToEnum = (type: LeagueType): string => {
  return type === LeagueType.H2H ? 'H2H' : 'CLASSIC';
};

export const tournamentModeToEnum = (_mode: TournamentMode): string => {
  return 'NORMAL';
};

export const groupModeToEnum = (mode: GroupMode | null): string | null => {
  if (mode === null) {
    return null;
  }
  if (mode === GroupMode.POINTS_RACES) {
    return 'POINTS_RACES';
  }
  if (mode === GroupMode.BATTLE_RACES) {
    return 'BATTLE_RACES';
  }
  return 'NO_GROUP';
};

export const knockoutModeToEnum = (mode: KnockoutMode | null): string | null => {
  if (mode === null) {
    return null;
  }
  if (mode === KnockoutMode.SINGLE_ELIMINATION) {
    return 'SINGLE_ELIMINATION';
  }
  if (mode === KnockoutMode.DOUBLE_ELIMINATION) {
    return 'DOUBLE_ELIMINATION';
  }
  if (mode === KnockoutMode.HEAD_TO_HEAD) {
    return 'HEAD_TO_HEAD';
  }
  return 'NO_KNOCKOUT';
};

export const tournamentStateToEnum = (state: TournamentState): string => {
  if (state === TournamentState.INACTIVE) {
    return 'INACTIVE';
  }
  if (state === TournamentState.FINISHED) {
    return 'FINISHED';
  }
  return 'ACTIVE';
};

export const tournamentsResolvers = {
  Query: {
    entryTournaments: async (
      _parent: unknown,
      args: EntryTournamentsArgs,
      context: GraphQLContext
    ): Promise<TournamentInfo[]> => tournamentsService.getEntryTournaments(context, args.entryId),
  },
  TournamentInfo: {
    leagueType: (parent: TournamentInfo): string => leagueTypeToEnum(parent.leagueType),
    tournamentMode: (parent: TournamentInfo): string => tournamentModeToEnum(parent.tournamentMode),
    groupMode: (parent: TournamentInfo): string | null => groupModeToEnum(parent.groupMode),
    knockoutMode: (parent: TournamentInfo): string | null => knockoutModeToEnum(parent.knockoutMode),
    state: (parent: TournamentInfo): string => tournamentStateToEnum(parent.state),
  },
};
