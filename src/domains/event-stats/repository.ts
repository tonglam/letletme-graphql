import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';
import { buildPlayerMap } from '../../infra/player-map';
import { buildTeamMap } from '../../infra/team-map';

export type SelectionStatPlayer = {
  id: number;
  webName: string;
  teamShortName: string;
  position: string;
  selectedByPercent: number;
  eoByPercent: number | null;
};

export type CaptainStatPlayer = {
  id: number;
  webName: string;
  teamShortName: string;
  position: string;
  captainByPercent: number;
  selectedByPercent: number;
  eoByPercent: number | null;
};

export type TransferStatPlayer = {
  id: number;
  webName: string;
  teamShortName: string;
  position: string;
  transfersEvent: number;
  selectedByPercent: number;
};

export type TournamentSelectionStats = {
  totalEntries: number;
  goalkeepers: SelectionStatPlayer[];
  defenders: SelectionStatPlayer[];
  midfielders: SelectionStatPlayer[];
  forwards: SelectionStatPlayer[];
  captainSelect: CaptainStatPlayer[];
  viceCaptainSelect: CaptainStatPlayer[];
  mostSelectedPlayers: SelectionStatPlayer[];
  mostTransferIn: TransferStatPlayer[];
  mostTransferOut: TransferStatPlayer[];
};

type DbTournamentInfoRow = {
  league_id: number;
  league_type: string;
};

type RpcCaptainCountRow = {
  captain_id: number;
  count: number;
  total_entries: number;
};

type RpcPickAggregationRow = {
  element_id: number;
  pick_count: number;
  vice_captain_count: number;
};

type RpcTransferAggregationRow = {
  element_id: number;
  transfer_in_count: number | null;
  transfer_out_count: number | null;
};

type DbTournamentSelectionStatRow = {
  element_id: number;
  pick_count: number;
  captain_count: number;
  vice_captain_count: number;
  transfer_in_count: number;
  transfer_out_count: number;
  total_entries: number;
};

const positionTypeToEnum = (type: number): string => {
  switch (type) {
    case 1:
      return 'GOALKEEPER';
    case 2:
      return 'DEFENDER';
    case 3:
      return 'MIDFIELDER';
    case 4:
      return 'FORWARD';
    default:
      return 'MIDFIELDER';
  }
};

async function getPlayerAndTeamMaps(
  context: GraphQLContext,
  playerIds: number[]
): Promise<{
  playerMap: Map<number, { id: number; web_name: string; team_id: number; type: number }>;
  teamMap: Map<number, { id: number; short_name: string }>;
}> {
  if (playerIds.length === 0) {
    return { playerMap: new Map(), teamMap: new Map() };
  }

  const [fullPlayerMap, fullTeamMap] = await Promise.all([
    buildPlayerMap(context, playerIds),
    buildTeamMap(context),
  ]);

  const filteredPlayerMap = new Map<
    number,
    { id: number; web_name: string; team_id: number; type: number }
  >();
  for (const [id, player] of fullPlayerMap) {
    if (playerIds.includes(id)) {
      filteredPlayerMap.set(id, {
        id: player.id,
        web_name: player.webName,
        team_id: player.teamId,
        type: player.position,
      });
    }
  }

  const neededTeamIds = new Set([...filteredPlayerMap.values()].map((p) => p.team_id));
  const filteredTeamMap = new Map<number, { id: number; short_name: string }>();
  for (const [id, team] of fullTeamMap) {
    if (neededTeamIds.has(id)) {
      filteredTeamMap.set(id, { id, short_name: team.shortName });
    }
  }

  return { playerMap: filteredPlayerMap, teamMap: filteredTeamMap };
}

async function getTournamentInfo(
  context: GraphQLContext,
  tournamentId: number
): Promise<DbTournamentInfoRow | null> {
  // Distinct from tournaments domain key `tournament:info:` (full TournamentInfo).
  const cacheKey = `tournament:info:league:${tournamentId}`;
  const cached = await context.redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as DbTournamentInfoRow;
  }

  const { data, error } = await context.supabase
    .from('tournament_infos')
    .select('league_id, league_type')
    .eq('id', tournamentId)
    .limit(1);

  if (error || !data?.[0]) {
    context.logger.error({ err: error, tournamentId }, 'Failed to fetch tournament info');
    return null;
  }

  const row = data[0] as DbTournamentInfoRow;
  await context.redis.set(cacheKey, JSON.stringify(row), 'EX', env.CACHE_TTL_SECONDS);
  return row;
}

async function getCaptainCounts(
  context: GraphQLContext,
  leagueId: number,
  leagueType: string,
  eventId: number
): Promise<{ captainCounts: Map<number, number>; totalEntries: number }> {
  const cacheKey = `tournament-selection-stats:captain-counts:${leagueId}:${leagueType}:${eventId}`;
  const cached = await context.redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as {
      captainCounts: [number, number][];
      totalEntries: number;
    };
    return {
      captainCounts: new Map(parsed.captainCounts),
      totalEntries: parsed.totalEntries,
    };
  }

  const rpcResult = await context.supabase.rpc('get_captain_counts', {
    p_league_id: leagueId,
    p_league_type: leagueType,
    p_event_id: eventId,
  });

  if (rpcResult.error) {
    context.logger.error(
      { err: rpcResult.error, leagueId, leagueType, eventId },
      'Failed to fetch captain counts via RPC'
    );
    return { captainCounts: new Map(), totalEntries: 0 };
  }

  const rows = (rpcResult.data as RpcCaptainCountRow[] | null) ?? [];
  const captainCounts = new Map<number, number>();
  let totalEntries = 0;

  for (const row of rows) {
    captainCounts.set(row.captain_id, Number(row.count));
    totalEntries = Number(row.total_entries);
  }

  const result = { captainCounts, totalEntries };
  await context.redis.set(
    cacheKey,
    JSON.stringify({
      captainCounts: [...captainCounts.entries()],
      totalEntries,
    }),
    'EX',
    env.CACHE_TTL_SECONDS
  );

  return result;
}

async function getPickAggregation(
  context: GraphQLContext,
  tournamentId: number,
  entryIds: number[],
  eventId: number
): Promise<{
  pickCounts: Map<number, number>;
  viceCaptainCounts: Map<number, number>;
}> {
  if (entryIds.length === 0) {
    return { pickCounts: new Map(), viceCaptainCounts: new Map() };
  }

  const cacheKey = `tournament-selection-stats:pick-aggregation:${tournamentId}:${eventId}`;
  const cached = await context.redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as {
      pickCounts: [number, number][];
      viceCaptainCounts: [number, number][];
    };
    return {
      pickCounts: new Map(parsed.pickCounts),
      viceCaptainCounts: new Map(parsed.viceCaptainCounts),
    };
  }

  const result = await context.supabase.rpc('get_pick_aggregation', {
    p_event_id: eventId,
    p_entry_ids: entryIds,
  });

  if (result.error) {
    context.logger.error(
      { err: result.error, eventId, entryCount: entryIds.length },
      'Failed to fetch pick aggregation via RPC'
    );
    return { pickCounts: new Map(), viceCaptainCounts: new Map() };
  }

  const rows = (result.data as RpcPickAggregationRow[] | null) ?? [];
  const pickCounts = new Map<number, number>();
  const viceCaptainCounts = new Map<number, number>();

  for (const row of rows) {
    pickCounts.set(row.element_id, Number(row.pick_count));
    if (Number(row.vice_captain_count) > 0) {
      viceCaptainCounts.set(row.element_id, Number(row.vice_captain_count));
    }
  }

  await context.redis.set(
    cacheKey,
    JSON.stringify({
      pickCounts: [...pickCounts.entries()],
      viceCaptainCounts: [...viceCaptainCounts.entries()],
    }),
    'EX',
    env.CACHE_TTL_SECONDS
  );

  return { pickCounts, viceCaptainCounts };
}

async function getTransferAggregation(
  context: GraphQLContext,
  tournamentId: number,
  entryIds: number[],
  eventId: number
): Promise<{
  transferInCounts: Map<number, number>;
  transferOutCounts: Map<number, number>;
}> {
  if (entryIds.length === 0) {
    return { transferInCounts: new Map(), transferOutCounts: new Map() };
  }

  const cacheKey = `tournament-selection-stats:transfer-aggregation:${tournamentId}:${eventId}`;
  const cached = await context.redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as {
      transferInCounts: [number, number][];
      transferOutCounts: [number, number][];
    };
    return {
      transferInCounts: new Map(parsed.transferInCounts),
      transferOutCounts: new Map(parsed.transferOutCounts),
    };
  }

  const result = await context.supabase.rpc('get_transfer_aggregation', {
    p_event_id: eventId,
    p_entry_ids: entryIds,
  });

  if (result.error) {
    context.logger.error(
      { err: result.error, eventId, entryCount: entryIds.length },
      'Failed to fetch transfer aggregation via RPC'
    );
    return { transferInCounts: new Map(), transferOutCounts: new Map() };
  }

  const rows = (result.data as RpcTransferAggregationRow[] | null) ?? [];
  const transferInCounts = new Map<number, number>();
  const transferOutCounts = new Map<number, number>();

  for (const row of rows) {
    if (row.transfer_in_count !== null && Number(row.transfer_in_count) > 0) {
      transferInCounts.set(row.element_id, Number(row.transfer_in_count));
    }
    if (row.transfer_out_count !== null && Number(row.transfer_out_count) > 0) {
      transferOutCounts.set(row.element_id, Number(row.transfer_out_count));
    }
  }

  await context.redis.set(
    cacheKey,
    JSON.stringify({
      transferInCounts: [...transferInCounts.entries()],
      transferOutCounts: [...transferOutCounts.entries()],
    }),
    'EX',
    env.CACHE_TTL_SECONDS
  );

  return { transferInCounts, transferOutCounts };
}

async function getTournamentEntryIds(
  context: GraphQLContext,
  tournamentId: number
): Promise<number[]> {
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
    return [];
  }

  const entryIds = ((data as { entry_id: number }[] | null) ?? []).map((r) => r.entry_id);
  await context.redis.set(cacheKey, JSON.stringify(entryIds), 'EX', env.CACHE_TTL_SECONDS);
  return entryIds;
}

const EMPTY_STATS: TournamentSelectionStats = {
  totalEntries: 0,
  goalkeepers: [],
  defenders: [],
  midfielders: [],
  forwards: [],
  captainSelect: [],
  viceCaptainSelect: [],
  mostSelectedPlayers: [],
  mostTransferIn: [],
  mostTransferOut: [],
};

type SelectionStatsCounts = {
  pickCounts: Map<number, number>;
  captainCounts: Map<number, number>;
  viceCaptainCounts: Map<number, number>;
  transferInCounts: Map<number, number>;
  transferOutCounts: Map<number, number>;
};

async function getReadModelRows(
  context: GraphQLContext,
  tournamentId: number,
  eventId: number
): Promise<DbTournamentSelectionStatRow[] | null> {
  const { data, error } = await context.supabase
    .from('tournament_selection_stats')
    .select(
      'element_id,pick_count,captain_count,vice_captain_count,transfer_in_count,transfer_out_count,total_entries'
    )
    .eq('tournament_id', tournamentId)
    .eq('event_id', eventId);

  if (error) {
    context.logger.warn(
      { err: error, tournamentId, eventId },
      'Failed to fetch tournament selection stats read model; falling back to RPC aggregation'
    );
    return null;
  }

  return (data as DbTournamentSelectionStatRow[] | null) ?? [];
}

function countsFromReadModel(rows: DbTournamentSelectionStatRow[]): {
  counts: SelectionStatsCounts;
  totalEntries: number;
} {
  const counts: SelectionStatsCounts = {
    pickCounts: new Map(),
    captainCounts: new Map(),
    viceCaptainCounts: new Map(),
    transferInCounts: new Map(),
    transferOutCounts: new Map(),
  };
  let totalEntries = 0;

  for (const row of rows) {
    const playerId = Number(row.element_id);
    if (!Number.isFinite(playerId) || playerId <= 0) continue;

    const pickCount = Number(row.pick_count) || 0;
    const captainCount = Number(row.captain_count) || 0;
    const viceCaptainCount = Number(row.vice_captain_count) || 0;
    const transferInCount = Number(row.transfer_in_count) || 0;
    const transferOutCount = Number(row.transfer_out_count) || 0;
    totalEntries = Math.max(totalEntries, Number(row.total_entries) || 0);

    if (pickCount > 0) counts.pickCounts.set(playerId, pickCount);
    if (captainCount > 0) counts.captainCounts.set(playerId, captainCount);
    if (viceCaptainCount > 0) counts.viceCaptainCounts.set(playerId, viceCaptainCount);
    if (transferInCount > 0) counts.transferInCounts.set(playerId, transferInCount);
    if (transferOutCount > 0) counts.transferOutCounts.set(playerId, transferOutCount);
  }

  return { counts, totalEntries };
}

async function buildTournamentSelectionStats(
  context: GraphQLContext,
  counts: SelectionStatsCounts,
  effectiveTotal: number,
  safeLimit: number
): Promise<TournamentSelectionStats> {
  const { pickCounts, captainCounts, viceCaptainCounts, transferInCounts, transferOutCounts } =
    counts;

  const allPlayerIds = [
    ...new Set([
      ...pickCounts.keys(),
      ...captainCounts.keys(),
      ...viceCaptainCounts.keys(),
      ...transferInCounts.keys(),
      ...transferOutCounts.keys(),
    ]),
  ];

  const { playerMap, teamMap } = await getPlayerAndTeamMaps(context, allPlayerIds);

  const computeEoPercent = (playerId: number, selectedPct: number): number => {
    const captainCount = captainCounts.get(playerId) ?? 0;
    const captainPct = effectiveTotal > 0 ? (captainCount / effectiveTotal) * 100 : 0;
    return selectedPct + captainPct;
  };

  const buildSelectionPlayer = (
    playerId: number,
    pickCount: number
  ): SelectionStatPlayer | null => {
    const player = playerMap.get(playerId);
    if (!player) return null;
    const team = teamMap.get(player.team_id);
    const selectedPct = effectiveTotal > 0 ? (pickCount / effectiveTotal) * 100 : 0;
    return {
      id: player.id,
      webName: player.web_name,
      teamShortName: team?.short_name ?? '',
      position: positionTypeToEnum(player.type),
      selectedByPercent: Math.round(selectedPct * 100) / 100,
      eoByPercent: Math.round(computeEoPercent(playerId, selectedPct) * 100) / 100,
    };
  };

  const sortedByPick = [...pickCounts.entries()].sort((a, b) => b[1] - a[1]);

  const sortByPosition = (type: number): SelectionStatPlayer[] =>
    sortedByPick
      .filter(([playerId]) => playerMap.get(playerId)?.type === type)
      .slice(0, safeLimit)
      .map(([playerId, count]) => buildSelectionPlayer(playerId, count))
      .filter((p): p is SelectionStatPlayer => p !== null);

  const buildCaptainPlayer = (playerId: number, roleCount: number): CaptainStatPlayer | null => {
    const player = playerMap.get(playerId);
    if (!player) return null;
    const team = teamMap.get(player.team_id);
    const rolePct = effectiveTotal > 0 ? (roleCount / effectiveTotal) * 100 : 0;
    const pickCount = pickCounts.get(playerId) ?? 0;
    const selectedPct = effectiveTotal > 0 ? (pickCount / effectiveTotal) * 100 : 0;
    return {
      id: player.id,
      webName: player.web_name,
      teamShortName: team?.short_name ?? '',
      position: positionTypeToEnum(player.type),
      captainByPercent: Math.round(rolePct * 100) / 100,
      selectedByPercent: Math.round(selectedPct * 100) / 100,
      eoByPercent: Math.round(computeEoPercent(playerId, selectedPct) * 100) / 100,
    };
  };

  const captainSelect: CaptainStatPlayer[] = [...captainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, safeLimit)
    .map(([playerId, count]) => buildCaptainPlayer(playerId, count))
    .filter((p): p is CaptainStatPlayer => p !== null);

  const viceCaptainSelect: CaptainStatPlayer[] = [...viceCaptainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, safeLimit)
    .map(([playerId, count]) => buildCaptainPlayer(playerId, count))
    .filter((p): p is CaptainStatPlayer => p !== null);

  const mostSelectedPlayers: SelectionStatPlayer[] = sortedByPick
    .slice(0, safeLimit)
    .map(([playerId, count]) => buildSelectionPlayer(playerId, count))
    .filter((p): p is SelectionStatPlayer => p !== null);

  const buildTransferPlayer = (
    playerId: number,
    transferCount: number
  ): TransferStatPlayer | null => {
    const player = playerMap.get(playerId);
    if (!player) return null;
    const team = teamMap.get(player.team_id);
    const pickCount = pickCounts.get(playerId) ?? 0;
    const selectedPct = effectiveTotal > 0 ? (pickCount / effectiveTotal) * 100 : 0;
    return {
      id: player.id,
      webName: player.web_name,
      teamShortName: team?.short_name ?? '',
      position: positionTypeToEnum(player.type),
      transfersEvent: transferCount,
      selectedByPercent: Math.round(selectedPct * 100) / 100,
    };
  };

  const mostTransferIn: TransferStatPlayer[] = [...transferInCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, safeLimit)
    .map(([playerId, count]) => buildTransferPlayer(playerId, count))
    .filter((p): p is TransferStatPlayer => p !== null);

  const mostTransferOut: TransferStatPlayer[] = [...transferOutCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, safeLimit)
    .map(([playerId, count]) => buildTransferPlayer(playerId, count))
    .filter((p): p is TransferStatPlayer => p !== null);

  return {
    totalEntries: effectiveTotal,
    goalkeepers: sortByPosition(1),
    defenders: sortByPosition(2),
    midfielders: sortByPosition(3),
    forwards: sortByPosition(4),
    captainSelect,
    viceCaptainSelect,
    mostSelectedPlayers,
    mostTransferIn,
    mostTransferOut,
  };
}

export interface EventStatsRepository {
  getTournamentSelectionStats(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number,
    limit: number
  ): Promise<TournamentSelectionStats>;
}

export const eventStatsRepository: EventStatsRepository = {
  async getTournamentSelectionStats(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number,
    limit: number
  ): Promise<TournamentSelectionStats> {
    if (!Number.isFinite(tournamentId) || tournamentId <= 0) return EMPTY_STATS;
    if (!Number.isFinite(eventId) || eventId <= 0) return EMPTY_STATS;
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    const cacheKey = `tournament-selection-stats:${tournamentId}:${eventId}:${safeLimit}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as TournamentSelectionStats;
    }

    const readModelRows = await getReadModelRows(context, tournamentId, eventId);
    if (readModelRows && readModelRows.length > 0) {
      const { counts, totalEntries } = countsFromReadModel(readModelRows);
      const result = await buildTournamentSelectionStats(context, counts, totalEntries, safeLimit);
      await context.redis.set(cacheKey, JSON.stringify(result), 'EX', env.CACHE_TTL_SECONDS);
      return result;
    }

    // Fetch info and entry IDs in parallel — entryIds doesn't depend on tournamentInfo
    const [tournamentInfo, entryIds] = await Promise.all([
      getTournamentInfo(context, tournamentId),
      getTournamentEntryIds(context, tournamentId),
    ]);
    if (!tournamentInfo) return EMPTY_STATS;

    // Now fan out all three aggregations in one round-trip group
    const [
      { captainCounts, totalEntries },
      { pickCounts, viceCaptainCounts },
      { transferInCounts, transferOutCounts },
    ] = await Promise.all([
      getCaptainCounts(context, tournamentInfo.league_id, tournamentInfo.league_type, eventId),
      getPickAggregation(context, tournamentId, entryIds, eventId),
      getTransferAggregation(context, tournamentId, entryIds, eventId),
    ]);

    if (totalEntries === 0 && entryIds.length === 0) return EMPTY_STATS;

    const effectiveTotal = totalEntries > 0 ? totalEntries : entryIds.length;

    const result = await buildTournamentSelectionStats(
      context,
      {
        pickCounts,
        captainCounts,
        viceCaptainCounts,
        transferInCounts,
        transferOutCounts,
      },
      effectiveTotal,
      safeLimit
    );

    await context.redis.set(cacheKey, JSON.stringify(result), 'EX', env.CACHE_TTL_SECONDS);
    return result;
  },
};
