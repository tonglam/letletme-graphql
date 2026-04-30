import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';
import { getCurrentSeason } from '../../infra/season';

const NULL_SENTINEL = '__entries:null__';

export type Entry = {
  id: number;
  entryName: string;
  playerName: string;
  region: string | null;
  startedEvent: number | null;
  overallPoints: number | null;
  overallRank: number | null;
  bank: number | null;
  teamValue: number | null;
  totalTransfers: number | null;
  lastEventId: number | null;
};

export type EntryEventResult = {
  entryId: number;
  eventId: number;
  eventPoints: number;
  eventRank: number | null;
  overallPoints: number;
  overallRank: number;
  eventTransfers: number;
  eventTransfersCost: number;
  eventNetPoints: number;
  eventBenchPoints: number;
  eventChip: string | null;
  eventPlayedCaptain: number | null;
  eventCaptainPoints: number;
  eventPicks: unknown[];
  teamValue: number | null;
  bank: number | null;
};

export type EntryHistoryInfo = {
  season: string;
  totalPoints: number;
  overallRank: number;
};

type DbEntryRow = {
  id: number;
  entry_name: string;
  player_name: string;
  region: string | null;
  started_event: number | null;
  overall_points: number | null;
  overall_rank: number | null;
  bank: number | null;
  team_value: number | null;
  total_transfers: number | null;
  last_event_id: number | null;
};

type DbEntryEventResultRow = {
  entry_id: number;
  event_id: number;
  event_points: number;
  event_rank: number | null;
  overall_points: number;
  overall_rank: number;
  event_transfers: number;
  event_transfers_cost: number;
  event_net_points: number;
  event_bench_points?: number | null;
  event_chip?: string | null;
  event_played_captain?: number | null;
  event_captain_points?: number | null;
  event_picks?: unknown;
  team_value: number | null;
  bank: number | null;
};

type DbEntryHistoryInfoRow = {
  season: string;
  total_points: number;
  overall_rank: number;
};

const mapEntry = (row: DbEntryRow): Entry => ({
  id: row.id,
  entryName: row.entry_name,
  playerName: row.player_name,
  region: row.region,
  startedEvent: row.started_event,
  overallPoints: row.overall_points,
  overallRank: row.overall_rank,
  bank: row.bank,
  teamValue: row.team_value,
  totalTransfers: row.total_transfers,
  lastEventId: row.last_event_id,
});

const mapEntryEventResult = (row: DbEntryEventResultRow): EntryEventResult => ({
  entryId: row.entry_id,
  eventId: row.event_id,
  eventPoints: row.event_points,
  eventRank: row.event_rank,
  overallPoints: row.overall_points,
  overallRank: row.overall_rank,
  eventTransfers: row.event_transfers,
  eventTransfersCost: row.event_transfers_cost,
  eventNetPoints: row.event_net_points,
  eventBenchPoints: row.event_bench_points ?? 0,
  eventChip: row.event_chip ?? null,
  eventPlayedCaptain: row.event_played_captain ?? null,
  eventCaptainPoints: row.event_captain_points ?? 0,
  eventPicks: parseJsonArray(row.event_picks),
  teamValue: row.team_value,
  bank: row.bank,
});

const parseJsonArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const mapEntryHistoryInfo = (row: DbEntryHistoryInfoRow): EntryHistoryInfo => ({
  season: row.season,
  totalPoints: row.total_points,
  overallRank: row.overall_rank,
});

interface EntriesRepository {
  getEntryById(context: GraphQLContext, id: number): Promise<Entry | null>;
  getEntriesByIds(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>>;
  getEntriesByIdsFromRedis(context: GraphQLContext, ids: number[]): Promise<Map<number, Entry>>;
  getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]>;
  getEntryHistoryInfo(context: GraphQLContext, entryId: number): Promise<EntryHistoryInfo[]>;
  getEntryEventResult(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventResult | null>;
}

export const entriesRepository: EntriesRepository = {
  async getEntryById(context: GraphQLContext, id: number): Promise<Entry | null> {
    const cacheKey = `entries:id:${id}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Entry;
    }

    const { data, error } = await context.supabase
      .from('entry_infos')
      .select('*')
      .eq('id', id)
      .limit(1);

    if (error) {
      context.logger.error({ err: error, id }, 'Failed to fetch entry');
      throw new Error('Failed to fetch entry');
    }

    const row = data?.[0] as DbEntryRow | undefined;
    if (!row) {
      return null;
    }

    const entry = mapEntry(row);
    await context.redis.set(cacheKey, JSON.stringify(entry), 'EX', env.CACHE_TTL_SECONDS);
    return entry;
  },

  async getEntriesByIds(
    context: GraphQLContext,
    ids: number[],
  ): Promise<Map<number, Entry>> {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
    if (uniqueIds.length === 0) {
      return new Map();
    }

    const { data, error } = await context.supabase
      .from('entry_infos')
      .select('*')
      .in('id', uniqueIds);

    if (error) {
      context.logger.error({ err: error, ids: uniqueIds }, 'Failed to batch fetch entries');
      throw new Error('Failed to batch fetch entries');
    }

    const rows = (data as DbEntryRow[] | null) ?? [];
    const entries = new Map<number, Entry>();
    for (const row of rows) {
      entries.set(row.id, mapEntry(row));
    }
    return entries;
  },

  async getEntriesByIdsFromRedis(
    context: GraphQLContext,
    ids: number[],
  ): Promise<Map<number, Entry>> {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
    if (uniqueIds.length === 0) {
      return new Map();
    }

    const season = await getCurrentSeason(context);
    const hashKey = `EntryInfo:${season}`;

    try {
      // HMGET all requested IDs from the hash
      const values = await context.redis.hmget(hashKey, ...uniqueIds.map(String));
      const results = new Map<number, Entry>();
      const missingIds: number[] = [];

      for (let i = 0; i < uniqueIds.length; i++) {
        const value = values[i];
        if (value) {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          results.set(uniqueIds[i], {
            id: uniqueIds[i],
            entryName: String(parsed.entryName ?? ''),
            playerName: String(parsed.playerName ?? ''),
            region: parsed.region ? String(parsed.region) : null,
            startedEvent: typeof parsed.startedEvent === 'number' ? parsed.startedEvent : null,
            overallPoints: typeof parsed.overallPoints === 'number' ? parsed.overallPoints : null,
            overallRank: typeof parsed.overallRank === 'number' ? parsed.overallRank : null,
            bank: typeof parsed.bank === 'number' ? parsed.bank : null,
            teamValue: typeof parsed.teamValue === 'number' ? parsed.teamValue : null,
            totalTransfers: typeof parsed.totalTransfers === 'number' ? parsed.totalTransfers : null,
            lastEventId: typeof parsed.lastEventId === 'number' ? parsed.lastEventId : null,
          });
        } else {
          missingIds.push(uniqueIds[i]);
        }
      }

      // Fallback to DB for any IDs not found in Redis
      if (missingIds.length > 0) {
        context.logger.info(
          { hashKey, requested: uniqueIds.length, found: results.size, missing: missingIds.length },
          'EntryInfo hash partial miss, falling back to DB'
        );
        const dbEntries = await this.getEntriesByIds(context, missingIds);
        for (const [id, entry] of dbEntries) {
          results.set(id, entry);
        }
      }

      return results;
    } catch (err) {
      context.logger.warn(
        { err, hashKey, ids: uniqueIds },
        'Failed to read EntryInfo hash from Redis, falling back to DB'
      );
      return this.getEntriesByIds(context, uniqueIds);
    }
  },

  async getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]> {
    if (!Number.isFinite(entryId) || entryId <= 0) {
      return [];
    }

    const cacheKey = `entries:history:v2:${entryId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached !== null) {
      if (cached === NULL_SENTINEL) {
        return [];
      }
      return JSON.parse(cached) as EntryEventResult[];
    }

    const { data, error } = await context.supabase
      .from('entry_event_results')
      .select('*')
      .eq('entry_id', entryId)
      .order('event_id', { ascending: true });

    if (error) {
      context.logger.error({ err: error, entryId }, 'Failed to fetch entry history');
      throw new Error('Failed to fetch entry history');
    }

    const history = (data as DbEntryEventResultRow[] | null)?.map(mapEntryEventResult) ?? [];
    if (history.length === 0) {
      await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', env.CACHE_TTL_SECONDS);
    } else {
      await context.redis.set(cacheKey, JSON.stringify(history), 'EX', env.CACHE_TTL_SECONDS);
    }
    return history;
  },

  async getEntryHistoryInfo(context: GraphQLContext, entryId: number): Promise<EntryHistoryInfo[]> {
    if (!Number.isFinite(entryId) || entryId <= 0) {
      return [];
    }

    const cacheKey = `entries:history-info:${entryId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached !== null) {
      if (cached === NULL_SENTINEL) {
        return [];
      }
      return JSON.parse(cached) as EntryHistoryInfo[];
    }

    const { data, error } = await context.supabase
      .from('entry_history_infos')
      .select('season,total_points,overall_rank')
      .eq('entry_id', entryId)
      .order('season', { ascending: true });

    if (error) {
      context.logger.error({ err: error, entryId }, 'Failed to fetch entry history info');
      throw new Error('Failed to fetch entry history info');
    }

    const historyInfo = (data as DbEntryHistoryInfoRow[] | null)?.map(mapEntryHistoryInfo) ?? [];
    if (historyInfo.length === 0) {
      await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', env.CACHE_TTL_SECONDS);
    } else {
      await context.redis.set(cacheKey, JSON.stringify(historyInfo), 'EX', env.CACHE_TTL_SECONDS);
    }
    return historyInfo;
  },

  async getEntryEventResult(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventResult | null> {
    if (!Number.isFinite(entryId) || entryId <= 0 || !Number.isFinite(eventId) || eventId <= 0) {
      return null;
    }

    const cacheKey = `entries:result:v2:${entryId}:${eventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as EntryEventResult;
    }

    const { data, error } = await context.supabase
      .from('entry_event_results')
      .select('*')
      .eq('entry_id', entryId)
      .eq('event_id', eventId)
      .limit(1);

    if (error) {
      context.logger.error({ err: error, entryId, eventId }, 'Failed to fetch entry event result');
      throw new Error('Failed to fetch entry event result');
    }

    const row = data?.[0] as DbEntryEventResultRow | undefined;
    if (!row) {
      return null;
    }

    const result = mapEntryEventResult(row);
    await context.redis.set(cacheKey, JSON.stringify(result), 'EX', env.CACHE_TTL_SECONDS);
    return result;
  },

};
