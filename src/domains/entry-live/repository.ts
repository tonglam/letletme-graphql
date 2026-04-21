import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

export type EntryEventPick = {
  eventId: number;
  entryId: number;
  chip: string | null;
  transfersCost: number;
  picks: Pick[];
};

export type Pick = {
  eventId: number;
  entryId: number;
  element: number;
  position: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
};

export type EntryEventTransferRow = {
  eventId: number;
  entryId: number;
  elementIn: number;
  elementOut: number;
  time: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const parsePick = (
  raw: unknown,
  fallback: { eventId: number; entryId: number }
): Pick | null => {
  if (!isRecord(raw)) {
    return null;
  }

  const element =
    asNumber(raw.element) ??
    asNumber(raw.element_id) ??
    asNumber(raw.playerId) ??
    asNumber(raw.player_id);
  const position = asNumber(raw.position);
  const multiplier = asNumber(raw.multiplier) ?? 1;

  const isCaptain =
    asBoolean(raw.isCaptain) ??
    asBoolean(raw.is_captain) ??
    asBoolean(raw.captain) ??
    false;
  const isViceCaptain =
    asBoolean(raw.isViceCaptain) ??
    asBoolean(raw.is_vice_captain) ??
    asBoolean(raw.viceCaptain) ??
    false;

  if (!element || !position) {
    return null;
  }

  return {
    eventId: fallback.eventId,
    entryId: fallback.entryId,
    element,
    position,
    multiplier,
    isCaptain,
    isViceCaptain,
  };
};

const parsePicks = (raw: unknown, fallback: { eventId: number; entryId: number }): Pick[] => {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsePicks(parsed, fallback);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => parsePick(item, fallback))
    .filter((p): p is Pick => p !== null);
};

type DbEntryEventPickRow = Record<string, unknown>;
type DbEntryEventTransferRow = Record<string, unknown>;

interface EntryLiveRepository {
  getEntryEventPick(context: GraphQLContext, entryId: number, eventId: number): Promise<EntryEventPick | null>;
  getEntryEventTransfers(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventTransferRow[]>;
  getEntryTransferHistory(
    context: GraphQLContext,
    entryId: number
  ): Promise<EntryEventTransferRow[]>;
}

const mapTransferRow = (
  row: DbEntryEventTransferRow,
  fallback: { entryId: number; eventId: number | null }
): EntryEventTransferRow | null => {
  const elementIn =
    asNumber(row.element_in) ??
    asNumber(row.element_in_id) ??
    asNumber(row.player_in) ??
    asNumber(row.in_element);
  const elementOut =
    asNumber(row.element_out) ??
    asNumber(row.element_out_id) ??
    asNumber(row.player_out) ??
    asNumber(row.out_element);
  const rowEventId = asNumber(row.event_id) ?? asNumber(row.event);
  const rowEntryId = asNumber(row.entry_id) ?? asNumber(row.entry);
  const eventId = rowEventId ?? fallback.eventId;
  const entryId = rowEntryId ?? fallback.entryId;

  if (!elementIn || !elementOut || !eventId || !entryId) {
    return null;
  }

  return {
    entryId,
    eventId,
    elementIn,
    elementOut,
    time: asString(row.time) ?? asString(row.created_at) ?? null,
  };
};

export const entryLiveRepository: EntryLiveRepository = {
  async getEntryEventPick(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventPick | null> {
    const cacheKey = `entries:picks:${entryId}:${eventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as EntryEventPick;
    }

    const { data, error } = await context.supabase
      .from('entry_event_picks')
      .select('*')
      .eq('entry_id', entryId)
      .eq('event_id', eventId)
      .limit(1);

    if (error) {
      // Graceful degradation: picks are optional for live calc.
      context.logger.error(
        { err: error, entryId, eventId },
        'Failed to fetch entry event picks'
      );
      return null;
    }

    const row = data?.[0] as DbEntryEventPickRow | undefined;
    if (!row) {
      return null;
    }

    const picksRaw = row.picks ?? row.pick_list ?? row.elements ?? null;
    const chip = asString(row.chip) ?? asString(row.active_chip) ?? null;
    const transfersCost =
      asNumber(row.transfers_cost) ??
      asNumber(row.event_transfers_cost) ??
      asNumber(row.transfer_cost) ??
      0;

    const picks = parsePicks(picksRaw, { entryId, eventId });

    const result: EntryEventPick = {
      entryId,
      eventId,
      chip,
      transfersCost,
      picks,
    };

    await context.redis.set(cacheKey, JSON.stringify(result), 'EX', env.CACHE_TTL_SECONDS);
    return result;
  },

  async getEntryEventTransfers(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventTransferRow[]> {
    const cacheKey = `entries:transfers:${entryId}:${eventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as EntryEventTransferRow[];
    }

    let queryResult = await context.supabase
      .from('entry_event_transfers')
      .select('*')
      .eq('entry_id', entryId)
      .eq('event_id', eventId)
      .order('time', { ascending: true });

    if (queryResult.error && queryResult.error.message.includes('column entry_event_transfers.time does not exist')) {
      queryResult = await context.supabase
        .from('entry_event_transfers')
        .select('*')
        .eq('entry_id', entryId)
        .eq('event_id', eventId)
        .order('created_at', { ascending: true });
    }

    if (queryResult.error && queryResult.error.message.includes('column entry_event_transfers.created_at does not exist')) {
      queryResult = await context.supabase
        .from('entry_event_transfers')
        .select('*')
        .eq('entry_id', entryId)
        .eq('event_id', eventId);
    }

    const { data, error } = queryResult;

    if (error) {
      // Graceful degradation: if transfers cannot be loaded (e.g. table missing),
      // we log and return an empty list instead of failing the whole query.
      context.logger.error(
        { err: error, entryId, eventId },
        'Failed to fetch entry event transfers'
      );
      return [];
    }

    const rows = (data as DbEntryEventTransferRow[] | null) ?? [];
    const transfers: EntryEventTransferRow[] = rows
      .map((row) => mapTransferRow(row, { entryId, eventId }))
      .filter((t): t is EntryEventTransferRow => t !== null);

    await context.redis.set(cacheKey, JSON.stringify(transfers), 'EX', env.CACHE_TTL_SECONDS);
    return transfers;
  },

  async getEntryTransferHistory(
    context: GraphQLContext,
    entryId: number
  ): Promise<EntryEventTransferRow[]> {
    const cacheKey = `entries:transfers:history:${entryId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as EntryEventTransferRow[];
    }

    let queryResult = await context.supabase
      .from('entry_event_transfers')
      .select('*')
      .eq('entry_id', entryId)
      .order('event_id', { ascending: true })
      .order('time', { ascending: true });

    if (queryResult.error && queryResult.error.message.includes('column entry_event_transfers.time does not exist')) {
      queryResult = await context.supabase
        .from('entry_event_transfers')
        .select('*')
        .eq('entry_id', entryId)
        .order('event_id', { ascending: true })
        .order('created_at', { ascending: true });
    }

    if (queryResult.error && queryResult.error.message.includes('column entry_event_transfers.created_at does not exist')) {
      queryResult = await context.supabase
        .from('entry_event_transfers')
        .select('*')
        .eq('entry_id', entryId)
        .order('event_id', { ascending: true });
    }

    const { data, error } = queryResult;

    if (error) {
      context.logger.error(
        { err: error, entryId },
        'Failed to fetch entry transfer history'
      );
      return [];
    }

    const rows = (data as DbEntryEventTransferRow[] | null) ?? [];
    const transfers: EntryEventTransferRow[] = rows
      .map((row) => mapTransferRow(row, { entryId, eventId: null }))
      .filter((t): t is EntryEventTransferRow => t !== null);

    await context.redis.set(cacheKey, JSON.stringify(transfers), 'EX', env.CACHE_TTL_SECONDS);
    return transfers;
  },
};

