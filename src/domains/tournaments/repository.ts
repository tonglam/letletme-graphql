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

export type TournamentEventResult = {
  tournament: TournamentInfo;
  eventId: number;
  groupId: number;
  entryId: number;
  entryName: string | null;
  playerName: string | null;
  eventGroupRank: number | null;
  eventPoints: number | null;
  eventCost: number | null;
  eventNetPoints: number | null;
  eventRank: number | null;
  overallPoints: number | null;
  overallRank: number | null;
  eventChip: string | null;
  captainId: number | null;
  captainPoints: number | null;
  teamValue: number | null;
  bank: number | null;
};

export type TournamentEntryRankingSummary = {
  eventId: number;
  entryId: number;
  overallRank: number | null;
  tournamentOverallRank: number | null;
  teamValue: number | null;
  tournamentTeamValueRank: number | null;
  transfersNum: number | null;
  tournamentTransfersRank: number | null;
  totalCosts: number | null;
  tournamentCostsRank: number | null;
  totalBenchPoints: number | null;
  tournamentBenchPointsRank: number | null;
  autoSubPoints: number | null;
  tournamentAutoSubRank: number | null;
};

export type DbTournamentPointsGroupResultRow = {
  tournament_id: number;
  group_id: number;
  event_id: number;
  entry_id: number;
  event_group_rank: number | null;
  event_points: number | null;
  event_cost: number | null;
  event_net_points: number | null;
  event_rank: number | null;
};

export type DbTournamentEventResultRow = {
  tournament_id: number;
  event_id: number;
  entry_id: number;
  group_id: number;
  event_group_rank: number | null;
  event_points: number | null;
  event_cost: number | null;
  event_net_points: number | null;
  event_rank: number | null;
  overall_points: number | null;
  overall_rank: number | null;
  event_chip: string | null;
  captain_id: number | null;
  captain_points: number | null;
  team_value: number | null;
  bank: number | null;
  entry_name: string | null;
  player_name: string | null;
  // Embedded tournament metadata (identical for every row)
  _tournament_id: number;
  _tournament_name: string;
  _tournament_creator: string;
  _tournament_admin_entry_id: number;
  _tournament_league_id: number;
  _tournament_league_type: string;
  _tournament_total_team_num: number;
  _tournament_tournament_mode: string;
  _tournament_group_mode: string | null;
  _tournament_group_team_num: number | null;
  _tournament_group_num: number | null;
  _tournament_group_started_event_id: number | null;
  _tournament_group_ended_event_id: number | null;
  _tournament_group_auto_averages: boolean;
  _tournament_group_rounds: number | null;
  _tournament_group_play_against_num: number | null;
  _tournament_group_qualify_num: number | null;
  _tournament_knockout_mode: string | null;
  _tournament_knockout_team_num: number | null;
  _tournament_knockout_rounds: number | null;
  _tournament_knockout_event_num: number | null;
  _tournament_knockout_started_event_id: number | null;
  _tournament_knockout_ended_event_id: number | null;
  _tournament_knockout_play_against_num: number | null;
  _tournament_state: string;
  _tournament_created_at: string;
  _tournament_updated_at: string;
};

export type DbLeagueEventResultEnrichmentRow = {
  league_id: number;
  league_type: string;
  event_id: number;
  entry_id: number;
  entry_name: string | null;
  player_name: string | null;
  overall_points: number | null;
  overall_rank: number | null;
  event_chip: string | null;
  captain_id: number | null;
  captain_points: number | null;
  team_value: number | null;
  bank: number | null;
};

export type DbEntryInfoNameRow = {
  id: number;
  entry_name: string | null;
  player_name: string | null;
};

type DbTournamentEventSnapshotRow = {
  tournament_id: number;
  event_id: number;
  entry_id: number;
  group_mode: string | null;
  tournament_overall_rank: number | null;
  overall_rank: number | null;
  team_value: number | null;
  cum_transfers_num: number;
  cum_total_costs: number;
  cum_total_bench_points: number;
  cum_auto_sub_points: number;
  tournament_team_value_rank: number | null;
  tournament_transfers_rank: number | null;
  tournament_costs_rank: number | null;
  tournament_bench_points_rank: number | null;
  tournament_auto_sub_rank: number | null;
};

const mapLeagueType = (type: string): LeagueType => {
  return type === LeagueType.H2H ? LeagueType.H2H : LeagueType.CLASSIC;
};

const mapTournamentMode = (mode: string): TournamentMode => {
  if (mode === TournamentMode.NORMAL) {
    return TournamentMode.NORMAL;
  }
  throw new Error(`Unknown tournament mode: ${mode}`);
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
  if (mode === GroupMode.NO_GROUP) {
    return GroupMode.NO_GROUP;
  }
  throw new Error(`Unknown group mode: ${mode}`);
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
  if (mode === KnockoutMode.NO_KNOCKOUT) {
    return KnockoutMode.NO_KNOCKOUT;
  }
  throw new Error(`Unknown knockout mode: ${mode}`);
};

const mapTournamentState = (state: string): TournamentState => {
  if (state === TournamentState.INACTIVE) {
    return TournamentState.INACTIVE;
  }
  if (state === TournamentState.FINISHED) {
    return TournamentState.FINISHED;
  }
  if (state === TournamentState.ACTIVE) {
    return TournamentState.ACTIVE;
  }
  throw new Error(`Unknown tournament state: ${state}`);
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
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

export const mapTournamentEventResult = (
  tournament: TournamentInfo,
  row: DbTournamentPointsGroupResultRow,
  leagueEventRow?: DbLeagueEventResultEnrichmentRow | null,
  entryInfoRow?: DbEntryInfoNameRow | null
): TournamentEventResult => ({
  tournament,
  eventId: row.event_id,
  groupId: row.group_id,
  entryId: row.entry_id,
  entryName: leagueEventRow?.entry_name ?? entryInfoRow?.entry_name ?? null,
  playerName: leagueEventRow?.player_name ?? entryInfoRow?.player_name ?? null,
  eventGroupRank: row.event_group_rank,
  eventPoints: row.event_points,
  eventCost: row.event_cost,
  eventNetPoints: row.event_net_points,
  eventRank: row.event_rank,
  overallPoints: leagueEventRow?.overall_points ?? null,
  overallRank: leagueEventRow?.overall_rank ?? null,
  eventChip: leagueEventRow?.event_chip ?? null,
  captainId: leagueEventRow?.captain_id ?? null,
  captainPoints: leagueEventRow?.captain_points ?? null,
  teamValue: leagueEventRow?.team_value ?? null,
  bank: leagueEventRow?.bank ?? null,
});

export const mapTournamentInfoFromViewRow = (
  row: DbTournamentEventResultRow
): TournamentInfo => ({
  id: row._tournament_id,
  name: row._tournament_name,
  creator: row._tournament_creator,
  adminEntryId: row._tournament_admin_entry_id,
  leagueId: row._tournament_league_id,
  leagueType: mapLeagueType(row._tournament_league_type),
  totalTeamNum: row._tournament_total_team_num,
  tournamentMode: mapTournamentMode(row._tournament_tournament_mode),
  groupMode: mapGroupMode(row._tournament_group_mode),
  groupTeamNum: row._tournament_group_team_num,
  groupNum: row._tournament_group_num,
  groupStartedEventId: row._tournament_group_started_event_id,
  groupEndedEventId: row._tournament_group_ended_event_id,
  groupAutoAverages: row._tournament_group_auto_averages,
  groupRounds: row._tournament_group_rounds,
  groupPlayAgainstNum: row._tournament_group_play_against_num,
  groupQualifyNum: row._tournament_group_qualify_num,
  knockoutMode: mapKnockoutMode(row._tournament_knockout_mode),
  knockoutTeamNum: row._tournament_knockout_team_num,
  knockoutRounds: row._tournament_knockout_rounds,
  knockoutEventNum: row._tournament_knockout_event_num,
  knockoutStartedEventId: row._tournament_knockout_started_event_id,
  knockoutEndedEventId: row._tournament_knockout_ended_event_id,
  knockoutPlayAgainstNum: row._tournament_knockout_play_against_num,
  state: mapTournamentState(row._tournament_state),
  createdAt: row._tournament_created_at,
  updatedAt: row._tournament_updated_at,
});

export const mapTournamentEventResultFromView = (
  tournament: TournamentInfo,
  row: DbTournamentEventResultRow
): TournamentEventResult => ({
  tournament,
  eventId: row.event_id,
  groupId: row.group_id,
  entryId: row.entry_id,
  entryName: row.entry_name,
  playerName: row.player_name,
  eventGroupRank: row.event_group_rank,
  eventPoints: row.event_points,
  eventCost: row.event_cost,
  eventNetPoints: row.event_net_points,
  eventRank: row.event_rank,
  overallPoints: row.overall_points,
  overallRank: row.overall_rank,
  eventChip: row.event_chip,
  captainId: row.captain_id,
  captainPoints: row.captain_points,
  teamValue: row.team_value,
  bank: row.bank,
});

/**
 * Fetches and caches a single tournament's full metadata.
 * Used by result/summary queries to avoid redundant validation fetches.
 */
const getTournamentInfoById = async (
  context: GraphQLContext,
  tournamentId: number
): Promise<TournamentInfo | null> => {
  const cacheKey = `tournament:info:${tournamentId}`;
  const cached = await context.redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as TournamentInfo;
  }

  const { data, error } = await context.supabase
    .from('tournament_infos')
    .select('*')
    .eq('id', tournamentId)
    .limit(1);

  if (error) {
    context.logger.error({ err: error, tournamentId }, 'Failed to fetch tournament');
    throw new Error('Failed to fetch tournament');
  }

  const row = data?.[0] as DbTournamentInfoRow | undefined;
  if (!row) {
    return null;
  }

  const tournament = mapTournamentInfo(row);
  await context.redis.set(cacheKey, JSON.stringify(tournament), 'EX', env.CACHE_TTL_SECONDS);
  return tournament;
};

interface TournamentsRepository {
  getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]>;
  getTournamentEntryIds(context: GraphQLContext, tournamentId: number): Promise<number[]>;
  getTournamentEventResults(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number
  ): Promise<TournamentEventResult[]>;
  getTournamentEntryRankingSummary(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number,
    entryId: number
  ): Promise<TournamentEntryRankingSummary>;
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

  async getTournamentEntryIds(context: GraphQLContext, tournamentId: number): Promise<number[]> {
    const cacheKey = `tournaments:entry-ids:${tournamentId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as number[];
    }

    const { data, error } = await context.supabase
      .from('tournament_entries')
      .select('entry_id')
      .eq('tournament_id', tournamentId);

    if (error) {
      context.logger.error({ err: error, tournamentId }, 'Failed to fetch tournament entry IDs');
      throw new Error('Failed to fetch tournament entry IDs');
    }

    const entryIds = ((data as { entry_id: number }[] | null) ?? []).map((row) => row.entry_id);
    await context.redis.set(cacheKey, JSON.stringify(entryIds), 'EX', env.CACHE_TTL_SECONDS);
    return entryIds;
  },

  async getTournamentEventResults(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number
  ): Promise<TournamentEventResult[]> {
    const cacheKey = `tournaments:event-results:${stableStringify({ tournamentId, eventId })}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as TournamentEventResult[];
    }

    const { data: resultData, error: resultError } = await context.supabase
      .from('v_tournament_event_result')
      .select('*')
      .eq('tournament_id', tournamentId)
      .eq('event_id', eventId)
      .order('group_id', { ascending: true })
      .order('event_group_rank', { ascending: true, nullsFirst: false })
      .order('entry_id', { ascending: true });

    if (resultError) {
      context.logger.error(
        { err: resultError, tournamentId, eventId },
        'Failed to fetch tournament event results'
      );
      throw new Error('Failed to fetch tournament event results');
    }

    const rows = (resultData as DbTournamentEventResultRow[] | null) ?? [];
    if (rows.length === 0) {
      await context.redis.set(cacheKey, JSON.stringify([]), 'EX', env.CACHE_TTL_SECONDS);
      return [];
    }

    const tournament = mapTournamentInfoFromViewRow(rows[0]);
    if (tournament.groupMode !== GroupMode.POINTS_RACES) {
      throw new Error(
        `Tournament event results currently support POINTS_RACES only, got: ${tournament.groupMode}`
      );
    }

    const results = rows.map((row) => mapTournamentEventResultFromView(tournament, row));

    await context.redis.set(cacheKey, JSON.stringify(results), 'EX', env.CACHE_TTL_SECONDS);
    return results;
  },

  async getTournamentEntryRankingSummary(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number,
    entryId: number
  ): Promise<TournamentEntryRankingSummary> {
    const cacheKey = `tournaments:ranking-summary:${stableStringify({
      tournamentId,
      eventId,
      entryId,
    })}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as TournamentEntryRankingSummary;
    }

    const snapshotResponse = await context.supabase
      .from('mv_tournament_event_snapshot')
      .select(
        'tournament_id, event_id, entry_id, group_mode, tournament_overall_rank, overall_rank, team_value, cum_transfers_num, cum_total_costs, cum_total_bench_points, cum_auto_sub_points, tournament_team_value_rank, tournament_transfers_rank, tournament_costs_rank, tournament_bench_points_rank, tournament_auto_sub_rank'
      )
      .eq('tournament_id', tournamentId)
      .eq('event_id', eventId)
      .eq('entry_id', entryId)
      .limit(1);

    if (snapshotResponse.error) {
      context.logger.error(
        { err: snapshotResponse.error, tournamentId, eventId, entryId },
        'Failed to fetch tournament snapshot metrics for summary'
      );
      throw new Error('Failed to fetch tournament ranking summary');
    }

    const snapshotRow =
      (snapshotResponse.data?.[0] as DbTournamentEventSnapshotRow | undefined) ?? undefined;

    const effectiveGroupMode = snapshotRow?.group_mode ?? null;

    if (effectiveGroupMode === null) {
      const tournament = await getTournamentInfoById(context, tournamentId);
      if (!tournament) {
        throw new Error('Tournament not found');
      }
      if (tournament.groupMode !== GroupMode.POINTS_RACES) {
        throw new Error(
          `Tournament ranking summary currently supports POINTS_RACES only, got: ${tournament.groupMode}`
        );
      }
    } else if (effectiveGroupMode !== GroupMode.POINTS_RACES) {
      throw new Error(
        `Tournament ranking summary currently supports POINTS_RACES only, got: ${effectiveGroupMode}`
      );
    }

    const summary: TournamentEntryRankingSummary = {
      eventId,
      entryId,
      overallRank: snapshotRow?.overall_rank ?? null,
      tournamentOverallRank: snapshotRow?.tournament_overall_rank ?? null,
      teamValue: snapshotRow?.team_value ?? null,
      tournamentTeamValueRank: snapshotRow?.tournament_team_value_rank ?? null,
      transfersNum: snapshotRow?.cum_transfers_num ?? 0,
      tournamentTransfersRank: snapshotRow?.tournament_transfers_rank ?? null,
      totalCosts: snapshotRow?.cum_total_costs ?? 0,
      tournamentCostsRank: snapshotRow?.tournament_costs_rank ?? null,
      totalBenchPoints: snapshotRow?.cum_total_bench_points ?? 0,
      tournamentBenchPointsRank: snapshotRow?.tournament_bench_points_rank ?? null,
      autoSubPoints: snapshotRow?.cum_auto_sub_points ?? 0,
      tournamentAutoSubRank: snapshotRow?.tournament_auto_sub_rank ?? null,
    };

    await context.redis.set(cacheKey, JSON.stringify(summary), 'EX', env.CACHE_TTL_SECONDS);
    return summary;
  },
};
