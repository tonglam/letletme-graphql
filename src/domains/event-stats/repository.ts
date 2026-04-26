import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

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
  eventId: number;
  tournamentId: number;
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

type DbPlayerRow = {
  id: number;
  web_name: string;
  team_id: number;
  type: number;
};

type DbTeamRow = {
  id: number;
  short_name: string;
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

type CachedPlayerTeamRow = {
  id: number;
  web_name: string;
  team_id: number;
  type: number;
  team_short_name: string;
};

const PLAYER_TEAM_CACHE_KEY = 'lookup:players-teams:brief';
const PLAYER_TEAM_CACHE_TTL = 300;

const positionTypeToEnum = (type: number): string => {
  switch (type) {
    case 1: return 'GOALKEEPER';
    case 2: return 'DEFENDER';
    case 3: return 'MIDFIELDER';
    case 4: return 'FORWARD';
    default: return 'MIDFIELDER';
  }
};

async function getCachedPlayerTeamRows(
  context: GraphQLContext,
): Promise<CachedPlayerTeamRow[]> {
  const cached = await context.redis.get(PLAYER_TEAM_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached) as CachedPlayerTeamRow[];
  }

  const { data: playerData, error: playerError } = await context.supabase
    .from('players')
    .select('id, web_name, team_id, type');

  if (playerError) {
    context.logger.error({ err: playerError }, 'Failed to fetch players for lookup cache');
    return [];
  }

  const { data: teamData, error: teamError } = await context.supabase
    .from('teams')
    .select('id, short_name');

  if (teamError) {
    context.logger.error({ err: teamError }, 'Failed to fetch teams for lookup cache');
    return [];
  }

  const playerRows = (playerData as DbPlayerRow[] | null) ?? [];
  const teamMap = new Map(
    ((teamData as DbTeamRow[] | null) ?? []).map((t) => [t.id, t]),
  );

  const allRows: CachedPlayerTeamRow[] = playerRows.map((p) => ({
    id: p.id,
    web_name: p.web_name,
    team_id: p.team_id,
    type: p.type,
    team_short_name: teamMap.get(p.team_id)?.short_name ?? '',
  }));

  await context.redis.set(
    PLAYER_TEAM_CACHE_KEY,
    JSON.stringify(allRows),
    'EX',
    PLAYER_TEAM_CACHE_TTL,
  );
  return allRows;
}

async function getPlayerAndTeamMaps(
  context: GraphQLContext,
  playerIds: number[],
): Promise<{
  playerMap: Map<number, DbPlayerRow>;
  teamMap: Map<number, DbTeamRow>;
}> {
  if (playerIds.length === 0) {
    return { playerMap: new Map(), teamMap: new Map() };
  }

  const allRows = await getCachedPlayerTeamRows(context);
  const playerIdSet = new Set(playerIds);
  const playerMap = new Map<number, DbPlayerRow>();
  const teamMap = new Map<number, DbTeamRow>();

  for (const row of allRows) {
    if (playerIdSet.has(row.id)) {
      playerMap.set(row.id, {
        id: row.id,
        web_name: row.web_name,
        team_id: row.team_id,
        type: row.type,
      });
      if (!teamMap.has(row.team_id)) {
        teamMap.set(row.team_id, {
          id: row.team_id,
          short_name: row.team_short_name,
        });
      }
    }
  }

  return { playerMap, teamMap };
}

async function getTournamentInfo(
  context: GraphQLContext,
  tournamentId: number,
): Promise<DbTournamentInfoRow | null> {
  const cacheKey = `tournament:info:brief:${tournamentId}`;
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
  eventId: number,
): Promise<{ captainCounts: Map<number, number>; totalEntries: number }> {
  const cacheKey = `tournament-selection-stats:captain-counts:${leagueId}:${leagueType}:${eventId}`;
  const cached = await context.redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as { captainCounts: [number, number][]; totalEntries: number };
    return { captainCounts: new Map(parsed.captainCounts), totalEntries: parsed.totalEntries };
  }

  const rpcResult = await context.supabase.rpc('get_captain_counts', {
    p_league_id: leagueId,
    p_league_type: leagueType,
    p_event_id: eventId,
  });

  if (rpcResult.error) {
    context.logger.error({ err: rpcResult.error, leagueId, leagueType, eventId }, 'Failed to fetch captain counts via RPC');
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
  await context.redis.set(cacheKey, JSON.stringify({
    captainCounts: [...captainCounts.entries()],
    totalEntries,
  }), 'EX', env.CACHE_TTL_SECONDS);

  return result;
}

async function getPickAggregation(
  context: GraphQLContext,
  entryIds: number[],
  eventId: number,
): Promise<{
  pickCounts: Map<number, number>;
  viceCaptainCounts: Map<number, number>;
}> {
  if (entryIds.length === 0) {
    return { pickCounts: new Map(), viceCaptainCounts: new Map() };
  }

  const result = await context.supabase.rpc('get_pick_aggregation', {
    p_event_id: eventId,
    p_entry_ids: entryIds,
  });

  if (result.error) {
    context.logger.error({ err: result.error, eventId, entryCount: entryIds.length }, 'Failed to fetch pick aggregation via RPC');
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

  return { pickCounts, viceCaptainCounts };
}

async function getTransferAggregation(
  context: GraphQLContext,
  entryIds: number[],
  eventId: number,
): Promise<{
  transferInCounts: Map<number, number>;
  transferOutCounts: Map<number, number>;
}> {
  if (entryIds.length === 0) {
    return { transferInCounts: new Map(), transferOutCounts: new Map() };
  }

  const result = await context.supabase.rpc('get_transfer_aggregation', {
    p_event_id: eventId,
    p_entry_ids: entryIds,
  });

  if (result.error) {
    context.logger.error({ err: result.error, eventId, entryCount: entryIds.length }, 'Failed to fetch transfer aggregation via RPC');
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

  return { transferInCounts, transferOutCounts };
}

async function getTournamentEntryIds(
  context: GraphQLContext,
  tournamentId: number,
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

export interface EventStatsRepository {
  getTournamentSelectionStats(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number,
    limit: number,
  ): Promise<TournamentSelectionStats | null>;
}

export const eventStatsRepository: EventStatsRepository = {
  async getTournamentSelectionStats(
    context: GraphQLContext,
    tournamentId: number,
    eventId: number,
    limit: number,
  ): Promise<TournamentSelectionStats | null> {
    if (!Number.isFinite(tournamentId) || tournamentId <= 0) return null;
    if (!Number.isFinite(eventId) || eventId <= 0) return null;
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    const cacheKey = `tournament-selection-stats:${tournamentId}:${eventId}:${safeLimit}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as TournamentSelectionStats;
    }

    const tournamentInfo = await getTournamentInfo(context, tournamentId);
    if (!tournamentInfo) return null;

    const [entryIds, { captainCounts, totalEntries }] = await Promise.all([
      getTournamentEntryIds(context, tournamentId),
      getCaptainCounts(context, tournamentInfo.league_id, tournamentInfo.league_type, eventId),
    ]);

    if (totalEntries === 0 && entryIds.length === 0) return null;

    const effectiveTotal = totalEntries > 0 ? totalEntries : entryIds.length;

    const [{ pickCounts, viceCaptainCounts }, { transferInCounts, transferOutCounts }] =
      await Promise.all([
        getPickAggregation(context, entryIds, eventId),
        getTransferAggregation(context, entryIds, eventId),
      ]);

    const allPlayerIds = [...new Set([
      ...pickCounts.keys(),
      ...captainCounts.keys(),
      ...viceCaptainCounts.keys(),
      ...transferInCounts.keys(),
      ...transferOutCounts.keys(),
    ])];

    const { playerMap, teamMap } = await getPlayerAndTeamMaps(context, allPlayerIds);

    const computeEoPercent = (playerId: number, selectedPct: number): number => {
      const captainCount = captainCounts.get(playerId) ?? 0;
      const captainPct = effectiveTotal > 0 ? (captainCount / effectiveTotal) * 100 : 0;
      return selectedPct + captainPct;
    };

    const buildSelectionPlayer = (
      playerId: number,
      pickCount: number,
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

    const sortedByPick = [...pickCounts.entries()]
      .sort((a, b) => b[1] - a[1]);

    const sortByPosition = (type: number): SelectionStatPlayer[] =>
      sortedByPick
        .filter(([playerId]) => playerMap.get(playerId)?.type === type)
        .slice(0, safeLimit)
        .map(([playerId, count]) => buildSelectionPlayer(playerId, count))
        .filter((p): p is SelectionStatPlayer => p !== null);

    const buildCaptainPlayer = (
      playerId: number,
      roleCount: number,
    ): CaptainStatPlayer | null => {
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
      transferCount: number,
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

    const result: TournamentSelectionStats = {
      eventId,
      tournamentId,
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

    await context.redis.set(cacheKey, JSON.stringify(result), 'EX', env.CACHE_TTL_SECONDS);
    return result;
  },
};
