import type { GraphQLContext } from '../../graphql/context';

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
  player_id: number;
  value: number;
  last_value: number | null;
  transfers_in: number | null;
  transfers_out: number | null;
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
  limit: number,
  fromDate?: Date,
  toDate?: Date
): PlayerValueHistoryRepositoryItem[] {
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
    .filter((item): item is { row: DbPlayerValueHistoryRow; parsedDate: Date } => item !== null)
    .filter(({ parsedDate }) => isWithinDateRange(parsedDate, fromDate, toDate))
    .sort((left, right) => right.parsedDate.getTime() - left.parsedDate.getTime());

  const rowsForComparison = normalizedRows.slice(0, limit + 1);
  const history: PlayerValueHistoryRepositoryItem[] = [];

  for (let index = 0; index < Math.min(limit, rowsForComparison.length); index += 1) {
    const current = rowsForComparison[index];
    const previous = rowsForComparison[index + 1];
    const fallbackOldValue = current.row.last_value ?? current.row.value;

    history.push({
      playerId: current.row.player_id,
      changeDate: current.parsedDate,
      oldValue: toTenthsValue(previous?.row.value ?? fallbackOldValue),
      newValue: toTenthsValue(current.row.value),
      transfersIn: current.row.transfers_in,
      transfersOut: current.row.transfers_out,
    });
  }

  return history;
}

async function getPlayerValuesFromDatabase(
  context: GraphQLContext,
  changeDate?: Date | null
): Promise<PlayerValue[]> {
  try {
    let query = context.supabase.from('player_values').select('*');

    // If changeDate is provided, filter by that date
    if (changeDate) {
      // Format date as YYYY-MM-DD for date column, or yyyyMMdd for string column
      const dateStr = changeDate.toISOString().split('T')[0]; // YYYY-MM-DD format
      const dateStrCompact = formatDateKey(changeDate).replace('PlayerValue:', ''); // yyyyMMdd format
      
      // Try both formats - date column or string column
      query = query.or(`change_date.eq.${dateStr},change_date.eq.${dateStrCompact}`);
    } else {
      // If no date provided, get the most recent data
      query = query.order('change_date', { ascending: false });
    }

    const { data, error } = await query;

    if (error) {
      context.logger.error({ err: error, changeDate: changeDate?.toISOString() }, 'Failed to fetch player values from database');
      // Don't throw, return empty array to allow graceful degradation
      return [];
    }

    if (!data || data.length === 0) {
      context.logger.warn({ changeDate: changeDate?.toISOString() }, 'No player values found in database');
      return [];
    }

    // If no specific date was requested, get the most recent change_date and filter to that
    const rows = data as DbPlayerValueRow[];
    let filteredRows = rows;
    
    if (!changeDate) {
      // Get the most recent change_date
      const latestDate = rows[0].change_date;
      filteredRows = rows.filter((row) => row.change_date === latestDate);
    }

    const playerValues = filteredRows.map(mapDbRowToPlayerValue);
    
    context.logger.info(
      { 
        changeDate: changeDate?.toISOString(),
        dataDate: filteredRows[0]?.change_date,
        count: playerValues.length 
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
      // Handle string type (JSON array)
      const cached = await context.redis.get(cacheKey);
      if (!cached) {
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

export const playerValuesRepository: PlayerValuesRepository = {
  async getPlayerValues(context: GraphQLContext, changeDate?: Date | null): Promise<PlayerValue[]> {
    const cacheKey = getDateKey(changeDate);
    context.logger.info({ cacheKey, changeDate: changeDate?.toISOString() }, 'Looking for player values in Redis');
    
    // Check if key exists and what type it is
    const keyType = await context.redis.type(cacheKey);
    
    if (keyType === 'none') {
      // Key doesn't exist, try to find similar keys (only if no specific date requested)
      if (!changeDate) {
        try {
          const pattern = 'PlayerValue:*';
          const keys = await context.redis.keys(pattern);
          if (keys.length > 0) {
            // Try the most recent key
            const mostRecentKey = keys.sort().reverse()[0];
            context.logger.info(
              { 
                cacheKey, 
                foundKey: mostRecentKey,
                availableKeys: keys.slice(0, 5)
              }, 
              'Today\'s key not found, trying most recent key'
            );
            
            // Recursively try the most recent key
            const mostRecentType = await context.redis.type(mostRecentKey);
            if (mostRecentType !== 'none') {
              return getPlayerValuesFromKey(context, mostRecentKey, mostRecentType);
            }
          }
        } catch (error) {
          context.logger.warn({ err: error, cacheKey }, 'Could not check for similar keys in Redis');
        }
      }
      
      // No data in Redis, fallback to database
      context.logger.info({ cacheKey, changeDate: changeDate?.toISOString() }, 'No data in Redis, querying database');
      return getPlayerValuesFromDatabase(context, changeDate);
    }

    return getPlayerValuesFromKey(context, cacheKey, keyType);
  },

  async getPlayerValueHistory(
    context: GraphQLContext,
    args: GetPlayerValueHistoryArgs
  ): Promise<PlayerValueHistoryRepositoryItem[]> {
    try {
      let query = context.supabase
        .from('player_values')
        .select('player_id,value,last_value,transfers_in,transfers_out,change_date')
        .eq('player_id', args.playerId)
        .order('change_date', { ascending: false })
        .limit(args.limit + 1);

      if (args.fromDate) {
        query = query.gte('change_date', args.fromDate.toISOString());
      }

      if (args.toDate) {
        query = query.lte('change_date', args.toDate.toISOString());
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
        return [];
      }

      return mapHistoryRows(rows, args.limit, args.fromDate, args.toDate);
    } catch (error) {
      context.logger.error({ err: error, playerId: args.playerId }, 'Failed to query player value history');
      return [];
    }
  },
};
