import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

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
  teamValue: number | null;
  bank: number | null;
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
  team_value: number | null;
  bank: number | null;
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
  teamValue: row.team_value,
  bank: row.bank,
});

interface EntriesRepository {
  getEntryById(context: GraphQLContext, id: number): Promise<Entry | null>;
  getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]>;
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

  async getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]> {
    const cacheKey = `entries:history:${entryId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
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
    await context.redis.set(cacheKey, JSON.stringify(history), 'EX', env.CACHE_TTL_SECONDS);
    return history;
  },

  async getEntryEventResult(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventResult | null> {
    const cacheKey = `entries:result:${entryId}:${eventId}`;
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
