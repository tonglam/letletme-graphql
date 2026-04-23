import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

type PositionEnum = 'GOALKEEPER' | 'DEFENDER' | 'MIDFIELDER' | 'FORWARD';

export type PlayerValue = {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  teamShortName: string;
  position: string;
  positionEnum: PositionEnum | null;
  price: number;
  value: number;
  lastValue: number;
  points: number;
  selectedBy: number;
  transfersIn: number;
  transfersOut: number;
  netTransfers: number;
  form: number | null;
  totalPoints: number;
  eventPoints: number | null;
};

export type PlayerValueHistoryItem = {
  playerId: number;
  changeDate: Date;
  oldValue: number;
  newValue: number;
  changeType: 'RISE' | 'FALL' | 'UNCHANGED';
  transfersIn: number | null;
  transfersOut: number | null;
};

export type PlayerValueHistoryRepositoryItem = Omit<PlayerValueHistoryItem, 'changeType'>;

export type GetPlayerValueHistoryArgs = {
  playerId: number;
  limit: number;
  fromDate?: Date;
  toDate?: Date;
};

export interface PlayerValuesRepository {
  getPlayerValues(context: GraphQLContext, changeDate?: Date | null): Promise<PlayerValue[]>;
  getPlayerValueHistory(
    context: GraphQLContext,
    args: GetPlayerValueHistoryArgs
  ): Promise<PlayerValueHistoryRepositoryItem[]>;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `PlayerValue:${year}${month}${day}`;
}

function getDateKey(changeDate?: Date | null): string {
  const date = changeDate ?? new Date();
  return formatDateKey(date);
}

type DbPlayerValueRow = {
  player_id: number;
  player_name: string;
  team_id: number;
  team_name: string;
  team_short_name?: string | null;
  position: string;
  price: number;
  value: number;
  last_value: number;
  points: number;
  selected_by: number;
  transfers_in: number;
  transfers_out: number;
  net_transfers: number;
  form: number | null;
  total_points: number;
  event_points: number | null;
  change_date: string;
};

type DbPlayerValueHistoryRow = {
  element_id: number;
  value: number;
  last_value: number | null;
  change_date: string | Date;
};

const compactDatePattern = /^\d{8}$/;

function toPositionEnum(position: string): PositionEnum | null {
  const normalized = position.trim().toUpperCase();
  if (normalized === 'GOALKEEPER' || normalized === 'GK') {
    return 'GOALKEEPER';
  }
  if (normalized === 'DEFENDER' || normalized === 'DEF') {
    return 'DEFENDER';
  }
  if (normalized === 'MIDFIELDER' || normalized === 'MID') {
    return 'MIDFIELDER';
  }
  if (normalized === 'FORWARD' || normalized === 'FWD' || normalized === 'STRIKER') {
    return 'FORWARD';
  }
  return null;
}

function buildTeamShortName(teamShortName: string | null | undefined, teamName: string): string {
  if (teamShortName && teamShortName.trim().length > 0) {
    return teamShortName.trim();
  }

  const words = teamName
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return 'UNK';
  }
  if (words.length === 1) {
    return words[0].slice(0, 3).toUpperCase();
  }

  return words
    .slice(0, 3)
    .map((word) => word[0].toUpperCase())
    .join('');
}

function parseChangeDate(rawValue: string | Date): Date | null {
  if (rawValue instanceof Date) {
    return Number.isNaN(rawValue.getTime()) ? null : rawValue;
  }

  if (compactDatePattern.test(rawValue)) {
    const year = Number(rawValue.slice(0, 4));
    const month = Number(rawValue.slice(4, 6));
    const day = Number(rawValue.slice(6, 8));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(rawValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toTenthsValue(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.round(value);
}

function isWithinDateRange(date: Date, fromDate?: Date, toDate?: Date): boolean {
  if (fromDate && date.getTime() < fromDate.getTime()) {
    return false;
  }
  if (toDate && date.getTime() > toDate.getTime()) {
    return false;
  }
  return true;
}

function buildHistoryCacheKey(args: GetPlayerValueHistoryArgs): string {
  const from = args.fromDate ? formatDateKey(args.fromDate) : 'none';
  const to = args.toDate ? formatDateKey(args.toDate) : 'none';
  return `player-value-history:${args.playerId}:${args.limit}:${from}:${to}`;
}

const mapDbRowToPlayerValue = (row: DbPlayerValueRow): PlayerValue => ({
  playerId: row.player_id,
  playerName: row.player_name,
  teamId: row.team_id,
  teamName: row.team_name,
  teamShortName: buildTeamShortName(row.team_short_name, row.team_name),
  position: row.position,
  positionEnum: toPositionEnum(row.position),
  price: row.price,
  value: row.value,
  lastValue: row.last_value,
  points: row.points,
  selectedBy: row.selected_by,
  transfersIn: row.transfers_in,
  transfersOut: row.transfers_out,
  netTransfers: row.net_transfers,
  form: row.form,
  totalPoints: row.total_points,
  eventPoints: row.event_points,
});

function mapHistoryRows(
  rows: DbPlayerValueHistoryRow[],
  limit: number
): PlayerValueHistoryRepositoryItem[] {
  // SQL already ordered by change_date DESC and filtered by date range;
  // we only need to parse dates and compute pairwise old values.
  const normalizedRows = rows
    .map((row) => {
      const parsedDate = parseChangeDate(row.change_date);
      if (!parsedDate) {
        return null;
      }
      return {
        row,
        parsedDate,
      };
    })
    .filter((item): item is { row: DbPlayerValueHistoryRow; parsedDate: Date } => item !== null);

  const rowsForComparison = normalizedRows.slice(0, limit + 1);
  const history: PlayerValueHistoryRepositoryItem[] = [];

  for (let index = 0; index < Math.min(limit, rowsForComparison.length); index += 1) {
    const current = rowsForComparison[index];
    const previous = rowsForComparison[index + 1];
    const fallbackOldValue = current.row.last_value ?? current.row.value;

    history.push({
      playerId: current.row.element_id,
      changeDate: current.parsedDate,
      oldValue: toTenthsValue(previous?.row.value ?? fallbackOldValue),
      newValue: toTenthsValue(current.row.value),
      transfersIn: null,
      transfersOut: null,
    });
  }

  return history;
}

async function getPlayerValuesFromDatabase(
  context: GraphQLContext,
  changeDate?: Date | null
): Promise<PlayerValue[]> {
  try {
    let targetDate: string | undefined;

    if (changeDate) {
      const dateStr = changeDate.toISOString().split('T')[0]; // YYYY-MM-DD format
      const dateStrCompact = formatDateKey(changeDate).replace('PlayerValue:', ''); // yyyyMMdd format

      // Query for the specific date (try both formats)
      const { data, error } = await context.supabase
        .from('player_values')
        .select('*')
        .or(`change_date.eq.${dateStr},change_date.eq.${dateStrCompact}`);

      if (error) {
        context.logger.error({ err: error, changeDate: changeDate?.toISOString() }, 'Failed to fetch player values from database');
        return [];
      }

      const rows = (data as DbPlayerValueRow[] | null) ?? [];
      if (rows.length === 0) {
        context.logger.warn({ changeDate: changeDate?.toISOString() }, 'No player values found in database');
        return [];
      }

      return rows.map(mapDbRowToPlayerValue);
    }

    // No date provided: find the latest change_date, then fetch rows for that date only
    const { data: dateData, error: dateError } = await context.supabase
      .from('player_values')
      .select('change_date')
      .order('change_date', { ascending: false })
      .limit(1);

    if (dateError) {
      context.logger.error({ err: dateError }, 'Failed to fetch latest player values date');
      return [];
    }

    targetDate = (dateData?.[0] as DbPlayerValueRow | undefined)?.change_date;
    if (!targetDate) {
      context.logger.warn('No player values dates found in database');
      return [];
    }

    const { data, error } = await context.supabase
      .from('player_values')
      .select('*')
      .eq('change_date', targetDate);

    if (error) {
      context.logger.error({ err: error, targetDate }, 'Failed to fetch player values for latest date');
      return [];
    }

    const rows = (data as DbPlayerValueRow[] | null) ?? [];
    if (rows.length === 0) {
      context.logger.warn({ targetDate }, 'No player values found for latest date');
      return [];
    }

    const playerValues = rows.map(mapDbRowToPlayerValue);

    context.logger.info(
      {
        targetDate,
        count: playerValues.length,
      },
      'Successfully retrieved player values from database'
    );

    return playerValues;
  } catch (error) {
    context.logger.error({ err: error, changeDate: changeDate?.toISOString() }, 'Failed to query player values from database');
    return [];
  }
}

async function getPlayerValuesFromKey(
  context: GraphQLContext,
  cacheKey: string,
  keyType: string
): Promise<PlayerValue[]> {
  try {
    if (keyType === 'string') {
      // Handle string type (JSON array or null sentinel)
      const cached = await context.redis.get(cacheKey);
      if (!cached) {
        return [];
      }
      if (cached === NULL_SENTINEL) {
        return [];
      }
      const parsed = JSON.parse(cached) as unknown;
      if (!Array.isArray(parsed)) {
        context.logger.error({ cacheKey }, 'Invalid player values data format - expected array');
        return [];
      }
      const data = parsed as PlayerValue[];
      context.logger.info({ cacheKey, count: data.length }, 'Successfully retrieved player values from Redis');
      return data;
    } else if (keyType === 'hash') {
      // Handle hash type (player ID -> JSON string)
      const hashData = await context.redis.hgetall(cacheKey);
      const rawData = Object.values(hashData)
        .map((value) => {
          try {
            return JSON.parse(value) as Record<string, unknown>;
          } catch (error) {
            context.logger.warn({ err: error, cacheKey }, 'Failed to parse hash value');
            return null;
          }
        })
        .filter((item): item is Record<string, unknown> => item !== null);

      // Map the Redis data structure to our PlayerValue type
      const playerValues: PlayerValue[] = rawData.map((item) => {
        // Handle different possible field names from Redis
        const playerId = (item.playerId as number) ?? (item.elementId as number) ?? 0;
        const playerName = (item.playerName as string) ?? (item.webName as string) ?? '';
        const teamId = (item.teamId as number) ?? 0;
        const teamName = (item.teamName as string) ?? '';
        const position = (item.position as string) ?? (item.elementTypeName as string) ?? '';
        const price = (item.price as number) ?? (item.nowCost as number) ?? 0;
        const value = (item.value as number) ?? 0;
        const lastValue = (item.lastValue as number) ?? 0;
        const points = (item.points as number) ?? (item.totalPoints as number) ?? 0;
        const selectedBy = (item.selectedBy as number) ?? (item.selectedByPercent as number) ?? 0;
        const transfersIn = (item.transfersIn as number) ?? (item.transfersInEvent as number) ?? 0;
        const transfersOut = (item.transfersOut as number) ?? (item.transfersOutEvent as number) ?? 0;
        const netTransfers = (item.netTransfers as number) ?? transfersIn - transfersOut;
        const form = (item.form as number) ?? null;
        const totalPoints = (item.totalPoints as number) ?? points;
        const eventPoints = (item.eventPoints as number) ?? (item.points as number) ?? null;

        return {
          playerId,
          playerName,
          teamId,
          teamName,
          teamShortName: buildTeamShortName((item.teamShortName as string | undefined) ?? null, teamName),
          position,
          positionEnum: toPositionEnum(position),
          price,
          value,
          lastValue,
          points,
          selectedBy,
          transfersIn,
          transfersOut,
          netTransfers,
          form,
          totalPoints,
          eventPoints,
        };
      });

      context.logger.info({ cacheKey, count: playerValues.length }, 'Successfully retrieved player values from Redis');
      return playerValues;
    } else {
      context.logger.error({ cacheKey, keyType }, 'Unsupported Redis key type for player values');
      return [];
    }
  } catch (error) {
    context.logger.error({ err: error, cacheKey }, 'Failed to parse player values from Redis');
    return [];
  }
}

const NULL_SENTINEL = '__pv:null__';

export const playerValuesRepository: PlayerValuesRepository = {
  async getPlayerValues(context: GraphQLContext, changeDate?: Date | null): Promise<PlayerValue[]> {
    const cacheKey = getDateKey(changeDate);
    context.logger.info({ cacheKey, changeDate: changeDate?.toISOString() }, 'Looking for player values in Redis');

    // 1. Read cache first
    const keyType = await context.redis.type(cacheKey);

    if (keyType !== 'none') {
      return getPlayerValuesFromKey(context, cacheKey, keyType);
    }

    // 2. Cache miss — query database
    context.logger.info({ cacheKey, changeDate: changeDate?.toISOString() }, 'No data in Redis, querying database');
    const values = await getPlayerValuesFromDatabase(context, changeDate);

    // 3. Write back to Redis (cache empty results too)
    if (values.length === 0) {
      await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', env.CACHE_TTL_SECONDS);
    } else {
      await context.redis.set(cacheKey, JSON.stringify(values), 'EX', env.CACHE_TTL_SECONDS);
    }

    return values;
  },

  async getPlayerValueHistory(
    context: GraphQLContext,
    args: GetPlayerValueHistoryArgs
  ): Promise<PlayerValueHistoryRepositoryItem[]> {
    if (!Number.isFinite(args.playerId) || args.playerId <= 0) {
      return [];
    }

    const cacheKey = buildHistoryCacheKey(args);
    const cached = await context.redis.get(cacheKey);
    if (cached !== null) {
      if (cached === NULL_SENTINEL) {
        return [];
      }
      return JSON.parse(cached) as PlayerValueHistoryRepositoryItem[];
    }

    try {
      let query = context.supabase
        .from('player_values')
        .select('element_id,value,last_value,change_date')
        .eq('element_id', args.playerId)
        .order('change_date', { ascending: false })
        .limit(args.limit + 1);

      if (args.fromDate) {
        query = query.gte('change_date', getDateKey(args.fromDate).replace('PlayerValue:', ''));
      }

      if (args.toDate) {
        query = query.lte('change_date', getDateKey(args.toDate).replace('PlayerValue:', ''));
      }

      const { data, error } = await query;

      if (error) {
        context.logger.error(
          { err: error, playerId: args.playerId },
          'Failed to fetch player value history from database'
        );
        return [];
      }

      const rows = (data as DbPlayerValueHistoryRow[] | null) ?? [];
      if (rows.length === 0) {
        await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', env.CACHE_TTL_SECONDS);
        return [];
      }

      const history = mapHistoryRows(rows, args.limit);
      await context.redis.set(cacheKey, JSON.stringify(history), 'EX', env.CACHE_TTL_SECONDS);
      return history;
    } catch (error) {
      context.logger.error({ err: error, playerId: args.playerId }, 'Failed to query player value history');
      return [];
    }
  },
};
