import type { GraphQLContext } from '../../graphql/context';

export type PlayerValue = {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  position: string;
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

export interface PlayerValuesRepository {
  getPlayerValues(context: GraphQLContext, changeDate?: Date | null): Promise<PlayerValue[]>;
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

const mapDbRowToPlayerValue = (row: DbPlayerValueRow): PlayerValue => ({
  playerId: row.player_id,
  playerName: row.player_name,
  teamId: row.team_id,
  teamName: row.team_name,
  position: row.position,
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
          position,
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
};
