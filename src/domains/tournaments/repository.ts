import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';
import { LeagueType } from '../leagues/repository';

export enum TournamentMode {
  NORMAL = 'normal',
}

export enum GroupMode {
  NO_GROUP = 'no_group',
  POINTS_RACES = 'points_races',
  BATTLE_RACES = 'battle_races',
}

export enum KnockoutMode {
  NO_KNOCKOUT = 'no_knockout',
  SINGLE_ELIMINATION = 'single_elimination',
  DOUBLE_ELIMINATION = 'double_elimination',
  HEAD_TO_HEAD = 'head_to_head',
}

export enum TournamentState {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  FINISHED = 'finished',
}

export type TournamentInfo = {
  id: number;
  name: string;
  creator: string;
  adminEntryId: number;
  leagueId: number;
  leagueType: LeagueType;
  totalTeamNum: number;
  tournamentMode: TournamentMode;
  groupMode: GroupMode | null;
  groupTeamNum: number | null;
  groupNum: number | null;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  groupAutoAverages: boolean;
  groupRounds: number | null;
  groupPlayAgainstNum: number | null;
  groupQualifyNum: number | null;
  knockoutMode: KnockoutMode | null;
  knockoutTeamNum: number | null;
  knockoutRounds: number | null;
  knockoutEventNum: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  knockoutPlayAgainstNum: number | null;
  state: TournamentState;
  createdAt: string;
  updatedAt: string;
};

export type DbTournamentEntryRow = {
  tournament_id: number;
};

export type DbTournamentInfoRow = {
  id: number;
  name: string;
  creator: string;
  admin_entry_id: number;
  league_id: number;
  league_type: string;
  total_team_num: number;
  tournament_mode: string;
  group_mode: string | null;
  group_team_num: number | null;
  group_num: number | null;
  group_started_event_id: number | null;
  group_ended_event_id: number | null;
  group_auto_averages: boolean;
  group_rounds: number | null;
  group_play_against_num: number | null;
  group_qualify_num: number | null;
  knockout_mode: string | null;
  knockout_team_num: number | null;
  knockout_rounds: number | null;
  knockout_event_num: number | null;
  knockout_started_event_id: number | null;
  knockout_ended_event_id: number | null;
  knockout_play_against_num: number | null;
  state: string;
  created_at: string;
  updated_at: string;
};

const mapLeagueType = (type: string): LeagueType => {
  return type === LeagueType.H2H ? LeagueType.H2H : LeagueType.CLASSIC;
};

const mapTournamentMode = (mode: string): TournamentMode => {
  return mode === TournamentMode.NORMAL ? TournamentMode.NORMAL : TournamentMode.NORMAL;
};

const mapGroupMode = (mode: string | null): GroupMode | null => {
  if (mode === null) {
    return null;
  }
  if (mode === GroupMode.POINTS_RACES) {
    return GroupMode.POINTS_RACES;
  }
  if (mode === GroupMode.BATTLE_RACES) {
    return GroupMode.BATTLE_RACES;
  }
  return GroupMode.NO_GROUP;
};

const mapKnockoutMode = (mode: string | null): KnockoutMode | null => {
  if (mode === null) {
    return null;
  }
  if (mode === KnockoutMode.SINGLE_ELIMINATION) {
    return KnockoutMode.SINGLE_ELIMINATION;
  }
  if (mode === KnockoutMode.DOUBLE_ELIMINATION) {
    return KnockoutMode.DOUBLE_ELIMINATION;
  }
  if (mode === KnockoutMode.HEAD_TO_HEAD) {
    return KnockoutMode.HEAD_TO_HEAD;
  }
  return KnockoutMode.NO_KNOCKOUT;
};

const mapTournamentState = (state: string): TournamentState => {
  if (state === TournamentState.INACTIVE) {
    return TournamentState.INACTIVE;
  }
  if (state === TournamentState.FINISHED) {
    return TournamentState.FINISHED;
  }
  return TournamentState.ACTIVE;
};

export const extractTournamentIds = (rows: DbTournamentEntryRow[]): number[] => {
  const unique = new Set<number>();
  rows.forEach((row) => {
    unique.add(row.tournament_id);
  });
  return [...unique];
};

export const mapTournamentInfo = (row: DbTournamentInfoRow): TournamentInfo => ({
  id: row.id,
  name: row.name,
  creator: row.creator,
  adminEntryId: row.admin_entry_id,
  leagueId: row.league_id,
  leagueType: mapLeagueType(row.league_type),
  totalTeamNum: row.total_team_num,
  tournamentMode: mapTournamentMode(row.tournament_mode),
  groupMode: mapGroupMode(row.group_mode),
  groupTeamNum: row.group_team_num,
  groupNum: row.group_num,
  groupStartedEventId: row.group_started_event_id,
  groupEndedEventId: row.group_ended_event_id,
  groupAutoAverages: row.group_auto_averages,
  groupRounds: row.group_rounds,
  groupPlayAgainstNum: row.group_play_against_num,
  groupQualifyNum: row.group_qualify_num,
  knockoutMode: mapKnockoutMode(row.knockout_mode),
  knockoutTeamNum: row.knockout_team_num,
  knockoutRounds: row.knockout_rounds,
  knockoutEventNum: row.knockout_event_num,
  knockoutStartedEventId: row.knockout_started_event_id,
  knockoutEndedEventId: row.knockout_ended_event_id,
  knockoutPlayAgainstNum: row.knockout_play_against_num,
  state: mapTournamentState(row.state),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface TournamentsRepository {
  getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]>;
}

export const tournamentsRepository: TournamentsRepository = {
  async getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]> {
    const cacheKey = `tournaments:entry:${entryId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as TournamentInfo[];
    }

    const { data: entryData, error: entryError } = await context.supabase
      .from('tournament_entries')
      .select('tournament_id')
      .eq('entry_id', entryId);

    if (entryError) {
      context.logger.error({ err: entryError, entryId }, 'Failed to fetch tournament memberships');
      throw new Error('Failed to fetch tournament memberships');
    }

    const tournamentIds = extractTournamentIds((entryData as DbTournamentEntryRow[] | null) ?? []);
    if (tournamentIds.length === 0) {
      await context.redis.set(cacheKey, JSON.stringify([]), 'EX', env.CACHE_TTL_SECONDS);
      return [];
    }

    const { data: infoData, error: infoError } = await context.supabase
      .from('tournament_infos')
      .select('*')
      .in('id', tournamentIds)
      .order('id', { ascending: true });

    if (infoError) {
      context.logger.error({ err: infoError, entryId }, 'Failed to fetch tournament details');
      throw new Error('Failed to fetch tournament details');
    }

    const tournaments = ((infoData as DbTournamentInfoRow[] | null) ?? []).map(mapTournamentInfo);
    await context.redis.set(cacheKey, JSON.stringify(tournaments), 'EX', env.CACHE_TTL_SECONDS);
    return tournaments;
  },
};
