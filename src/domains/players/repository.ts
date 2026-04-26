import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';
import { getCurrentSeason } from '../../infra/season';

export enum Position {
  GOALKEEPER = 1,
  DEFENDER = 2,
  MIDFIELDER = 3,
  FORWARD = 4,
}

export type Team = {
  id: number;
  code: number;
  name: string;
  shortName: string;
  strength: number;
  position: number;
  points: number;
  played: number;
  win: number;
  draw: number;
  loss: number;
  form: string | null;
  strengthOverallHome: number;
  strengthOverallAway: number;
  strengthAttackHome: number;
  strengthAttackAway: number;
  strengthDefenceHome: number;
  strengthDefenceAway: number;
};

export type Player = {
  id: number;
  code: number;
  webName: string;
  firstName: string | null;
  secondName: string | null;
  teamId: number;
  position: Position;
  price: number;
  startPrice: number;
  totalPoints: number;
  selectedByPercent: number | null;
};

export type PlayersFilter = {
  position?: Position | null;
  teamId?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
};

type DbTeamRow = {
  id: number;
  code: number;
  name: string;
  short_name: string;
  strength: number;
  position: number;
  points: number;
  played: number;
  win: number;
  draw: number;
  loss: number;
  form: string | null;
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
};

type DbPlayerRow = {
  id: number;
  code: number;
  web_name: string;
  first_name: string | null;
  second_name: string | null;
  team_id: number;
  type: number;
  price: number;
  start_price: number;
  total_points: number | null;
  selected_by_percent: number | string | null;
};

const asNullableNumber = (value: number | string | null | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const mapTeam = (row: DbTeamRow): Team => ({
  id: row.id,
  code: row.code,
  name: row.name,
  shortName: row.short_name,
  strength: row.strength,
  position: row.position,
  points: row.points,
  played: row.played,
  win: row.win,
  draw: row.draw,
  loss: row.loss,
  form: row.form,
  strengthOverallHome: row.strength_overall_home,
  strengthOverallAway: row.strength_overall_away,
  strengthAttackHome: row.strength_attack_home,
  strengthAttackAway: row.strength_attack_away,
  strengthDefenceHome: row.strength_defence_home,
  strengthDefenceAway: row.strength_defence_away,
});

const mapPlayer = (row: DbPlayerRow): Player => ({
  id: row.id,
  code: row.code,
  webName: row.web_name,
  firstName: row.first_name,
  secondName: row.second_name,
  teamId: row.team_id,
  position: row.type as Position,
  price: row.price,
  startPrice: row.start_price,
  totalPoints: row.total_points ?? 0,
  selectedByPercent: asNullableNumber(row.selected_by_percent),
});

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

const normalizeFilter = (filter?: PlayersFilter | null): PlayersFilter | undefined => {
  if (!filter) {
    return undefined;
  }
  return {
    position: filter.position ?? undefined,
    teamId: filter.teamId ?? undefined,
    minPrice: filter.minPrice ?? undefined,
    maxPrice: filter.maxPrice ?? undefined,
  };
};

const clampLimit = (limit: number): number => {
  const safeLimit = Number.isFinite(limit) ? limit : 50;
  return Math.min(Math.max(safeLimit, 1), 200);
};

const NULL_SENTINEL = '__team:null__';

const PICKER_CACHE_TTL = 300;

export type PlayerPickerTeam = {
  id: number;
  name: string;
  shortName: string;
};

export type PlayerPickerItem = {
  id: number;
  webName: string;
  position: Position;
  team: PlayerPickerTeam;
};

export type PlayersForPickerPayload = {
  items: PlayerPickerItem[];
  nextCursor: number | null;
};

type DbPickerRow = {
  id: number;
  web_name: string;
  position: number;
  team_id: number;
  team_name: string;
  team_short_name: string;
};

const mapPickerRow = (row: DbPickerRow): PlayerPickerItem => ({
  id: row.id,
  webName: row.web_name,
  position: row.position as Position,
  team: {
    id: row.team_id,
    name: row.team_name,
    shortName: row.team_short_name,
  },
});

export type PlayerTransferStats = {
  playerId: number;
  eventId: number;
  transfersInEvent: number;
  transfersOutEvent: number;
};

interface PlayersRepository {
  getPlayerById(context: GraphQLContext, id: number): Promise<Player | null>;
  getPlayerByIdForEvent(context: GraphQLContext, id: number, eventId: number): Promise<Player | null>;
  getPlayersByIds(context: GraphQLContext, ids: number[]): Promise<Player[]>;
  getPlayersFromRedis(context: GraphQLContext): Promise<Map<number, Player>>;
  getPlayersForPicker(
    context: GraphQLContext,
    limit: number,
    cursor: number | null | undefined
  ): Promise<PlayersForPickerPayload>;
  listPlayers(
    context: GraphQLContext,
    filter: PlayersFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Player[]>;
  getTeamById(context: GraphQLContext, id: number): Promise<Team | null>;
  listTeams(context: GraphQLContext): Promise<Team[]>;
  listTeamsFromRedis(context: GraphQLContext): Promise<Team[]>;
  getTopTransfersIn(
    context: GraphQLContext,
    eventId: number,
    limit: number
  ): Promise<PlayerTransferStats[]>;
  getTopTransfersOut(
    context: GraphQLContext,
    eventId: number,
    limit: number
  ): Promise<PlayerTransferStats[]>;
}

export const playersRepository: PlayersRepository = {
  async getPlayerById(context: GraphQLContext, id: number): Promise<Player | null> {
    const cacheKey = `players:id:${id}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Player;
    }

    const { data, error } = await context.supabase
      .from('players')
      .select('*')
      .eq('id', id)
      .limit(1);

    if (error) {
      context.logger.error({ err: error, id }, 'Failed to fetch player');
      throw new Error('Failed to fetch player');
    }

    const row = data?.[0] as DbPlayerRow | undefined;
    if (!row) {
      return null;
    }

    const player = mapPlayer(row);
    await context.redis.set(cacheKey, JSON.stringify(player), 'EX', env.CACHE_TTL_SECONDS);
    return player;
  },

  async getPlayerByIdForEvent(
    context: GraphQLContext,
    id: number,
    eventId: number
  ): Promise<Player | null> {
    const cacheKey = `players:id:${id}:event:${eventId}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Player;
    }

    const basePlayer = await this.getPlayerById(context, id);
    if (!basePlayer) {
      return null;
    }

    const { data, error } = await context.supabase
      .from('player_stats')
      .select('total_points, selected_by_percent')
      .eq('event_id', eventId)
      .eq('element_id', id)
      .limit(1);

    if (error) {
      context.logger.warn(
        { err: error, eventId, playerId: id },
        'Failed to fetch player event stats; falling back to base player'
      );
      await context.redis.set(cacheKey, JSON.stringify(basePlayer), 'EX', env.CACHE_TTL_SECONDS);
      return basePlayer;
    }

    const row = data?.[0] as { total_points?: number | null; selected_by_percent?: number | string | null } | undefined;

    const playerForEvent: Player = {
      ...basePlayer,
      totalPoints: row?.total_points ?? basePlayer.totalPoints,
      selectedByPercent: asNullableNumber(row?.selected_by_percent) ?? basePlayer.selectedByPercent,
    };

    await context.redis.set(cacheKey, JSON.stringify(playerForEvent), 'EX', env.CACHE_TTL_SECONDS);
    return playerForEvent;
  },

  async getPlayersByIds(context: GraphQLContext, ids: number[]): Promise<Player[]> {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
    if (uniqueIds.length === 0) {
      return [];
    }

    const cacheKey = `players:ids:${uniqueIds.sort((a, b) => a - b).join(',')}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Player[];
    }

    const { data, error } = await context.supabase
      .from('players')
      .select('*')
      .in('id', uniqueIds);

    if (error) {
      context.logger.error({ err: error, ids: uniqueIds }, 'Failed to fetch players by ids');
      throw new Error('Failed to fetch players');
    }

    const players = (data as DbPlayerRow[] | null)?.map(mapPlayer) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(players), 'EX', env.CACHE_TTL_SECONDS);
    return players;
  },

  async getPlayersFromRedis(context: GraphQLContext): Promise<Map<number, Player>> {
    try {
      const season = await getCurrentSeason(context);
      const hashKey = `Player:${season}`;
      const hash = await context.redis.hgetall(hashKey);

      if (!hash || Object.keys(hash).length === 0) {
        context.logger.info({ hashKey }, 'Player hash missing or empty, falling back to DB');
        return new Map();
      }

      const players = new Map<number, Player>();
      for (const [fieldKey, value] of Object.entries(hash)) {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const player: Player = {
          id: Number(fieldKey),
          code: Number(parsed.code ?? 0),
          webName: String(parsed.webName ?? ''),
          firstName: parsed.firstName ? String(parsed.firstName) : null,
          secondName: parsed.secondName ? String(parsed.secondName) : null,
          teamId: Number(parsed.teamId ?? 0),
          position: Number(parsed.type ?? 0) as Position,
          price: Number(parsed.price ?? 0),
          startPrice: Number(parsed.startPrice ?? 0),
          totalPoints: 0,
          selectedByPercent: null,
        };
        players.set(player.id, player);
      }

      context.logger.info({ hashKey, count: players.size }, 'Loaded players from Redis hash');
      return players;
    } catch (err) {
      context.logger.warn({ err }, 'Failed to read Player hash from Redis');
      return new Map();
    }
  },

  async getPlayersForPicker(
    context: GraphQLContext,
    limit: number,
    cursor: number | null | undefined
  ): Promise<PlayersForPickerPayload> {
    const safeLimit = clampLimit(limit);
    const safeCursor = cursor && Number.isFinite(cursor) && cursor > 0 ? cursor : null;
    const cacheKey = `players:picker:${safeLimit}:${safeCursor ?? 0}`;

    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as PlayersForPickerPayload;
    }

    const result = await context.supabase.rpc('get_players_for_picker', {
      p_limit: safeLimit,
      p_cursor: safeCursor,
    });

    if (result.error) {
      context.logger.error({ err: result.error, limit: safeLimit, cursor: safeCursor }, 'Failed to fetch players for picker');
      throw new Error('Failed to fetch players for picker');
    }

    const rows = (result.data as DbPickerRow[] | null) ?? [];
    const items = rows.map(mapPickerRow);
    const nextCursor = items.length >= safeLimit ? items[items.length - 1].id : null;
    const payload: PlayersForPickerPayload = { items, nextCursor };

    await context.redis.set(cacheKey, JSON.stringify(payload), 'EX', PICKER_CACHE_TTL);
    return payload;
  },

  async listPlayers(
    context: GraphQLContext,
    filter: PlayersFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Player[]> {
    const normalizedFilter = normalizeFilter(filter);
    const safeLimit = clampLimit(limit);
    const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);
    const cacheKey = `players:list:${stableStringify({
      filter: normalizedFilter ?? null,
      limit: safeLimit,
      offset: safeOffset,
    })}`;

    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Player[];
    }

    let query = context.supabase.from('players').select('*');

    if (normalizedFilter?.position !== undefined) {
      query = query.eq('type', normalizedFilter.position);
    }
    if (normalizedFilter?.teamId !== undefined) {
      query = query.eq('team_id', normalizedFilter.teamId);
    }
    if (normalizedFilter?.minPrice !== undefined) {
      query = query.gte('price', normalizedFilter.minPrice);
    }
    if (normalizedFilter?.maxPrice !== undefined) {
      query = query.lte('price', normalizedFilter.maxPrice);
    }

    const { data, error } = await query
      .order('id', { ascending: true })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (error) {
      context.logger.error({ err: error, filter: normalizedFilter }, 'Failed to fetch players');
      throw new Error('Failed to fetch players');
    }

    const players = (data as DbPlayerRow[] | null)?.map(mapPlayer) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(players), 'EX', env.CACHE_TTL_SECONDS);
    return players;
  },

  async getTeamById(context: GraphQLContext, id: number): Promise<Team | null> {
    if (!Number.isFinite(id) || id <= 0) {
      return null;
    }

    const cacheKey = `teams:id:${id}`;
    const cached = await context.redis.get(cacheKey);
    if (cached !== null) {
      if (cached === NULL_SENTINEL) {
        return null;
      }
      return JSON.parse(cached) as Team;
    }

    const { data, error } = await context.supabase.from('teams').select('*').eq('id', id).limit(1);

    if (error) {
      context.logger.error({ err: error, id }, 'Failed to fetch team');
      throw new Error('Failed to fetch team');
    }

    const row = data?.[0] as DbTeamRow | undefined;
    if (!row) {
      await context.redis.set(cacheKey, NULL_SENTINEL, 'EX', env.CACHE_TTL_SECONDS);
      return null;
    }

    const team = mapTeam(row);
    await context.redis.set(cacheKey, JSON.stringify(team), 'EX', env.CACHE_TTL_SECONDS);
    return team;
  },

  async listTeams(context: GraphQLContext): Promise<Team[]> {
    const cacheKey = 'teams:list:all';
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Team[];
    }

    const { data, error } = await context.supabase
      .from('teams')
      .select('*')
      .order('position', { ascending: true });

    if (error) {
      context.logger.error({ err: error }, 'Failed to fetch teams');
      throw new Error('Failed to fetch teams');
    }

    const teams = (data as DbTeamRow[] | null)?.map(mapTeam) ?? [];
    await context.redis.set(cacheKey, JSON.stringify(teams), 'EX', env.CACHE_TTL_SECONDS);
    return teams;
  },

  async listTeamsFromRedis(context: GraphQLContext): Promise<Team[]> {
    try {
      const season = await getCurrentSeason(context);
      const hashKey = `Team:${season}`;
      const hash = await context.redis.hgetall(hashKey);

      if (!hash || Object.keys(hash).length === 0) {
        context.logger.info({ hashKey }, 'Team hash missing or empty, falling back to DB');
        return this.listTeams(context);
      }

      const teams: Team[] = [];
      for (const value of Object.values(hash)) {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        teams.push({
          id: Number(parsed.id ?? 0),
          code: Number(parsed.code ?? 0),
          name: String(parsed.name ?? ''),
          shortName: String(parsed.shortName ?? ''),
          strength: Number(parsed.strength ?? 0),
          position: Number(parsed.position ?? 0),
          points: Number(parsed.points ?? 0),
          played: Number(parsed.played ?? 0),
          win: Number(parsed.win ?? 0),
          draw: Number(parsed.draw ?? 0),
          loss: Number(parsed.loss ?? 0),
          form: parsed.form ? String(parsed.form) : null,
          strengthOverallHome: Number(parsed.strengthOverallHome ?? 0),
          strengthOverallAway: Number(parsed.strengthOverallAway ?? 0),
          strengthAttackHome: Number(parsed.strengthAttackHome ?? 0),
          strengthAttackAway: Number(parsed.strengthAttackAway ?? 0),
          strengthDefenceHome: Number(parsed.strengthDefenceHome ?? 0),
          strengthDefenceAway: Number(parsed.strengthDefenceAway ?? 0),
        });
      }

      teams.sort((a, b) => a.position - b.position);
      context.logger.info({ hashKey, count: teams.length }, 'Loaded teams from Redis hash');
      return teams;
    } catch (err) {
      context.logger.warn({ err }, 'Failed to read Team hash from Redis, falling back to DB');
      return this.listTeams(context);
    }
  },

  async getTopTransfersIn(
    context: GraphQLContext,
    eventId: number,
    limit: number
  ): Promise<PlayerTransferStats[]> {
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return [];
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const cacheKey = `players:top-transfers-in:${eventId}:${safeLimit}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as PlayerTransferStats[];
    }

    const { data, error } = await context.supabase
      .from('player_stats')
      .select('element_id, event_id, transfers_in_event, transfers_out_event')
      .eq('event_id', eventId)
      .not('transfers_in_event', 'is', null)
      .order('transfers_in_event', { ascending: false })
      .limit(safeLimit);

    if (error) {
      context.logger.error({ err: error, eventId, limit: safeLimit }, 'Failed to fetch top transfers in');
      throw new Error('Failed to fetch top transfers in');
    }

    const stats =
      (data as Array<{
        element_id: number;
        event_id: number;
        transfers_in_event: number;
        transfers_out_event: number;
      }> | null)?.map((row) => ({
        playerId: row.element_id,
        eventId: row.event_id,
        transfersInEvent: row.transfers_in_event,
        transfersOutEvent: row.transfers_out_event ?? 0,
      })) ?? [];

    await context.redis.set(cacheKey, JSON.stringify(stats), 'EX', env.CACHE_TTL_SECONDS);
    return stats;
  },

  async getTopTransfersOut(
    context: GraphQLContext,
    eventId: number,
    limit: number
  ): Promise<PlayerTransferStats[]> {
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return [];
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const cacheKey = `players:top-transfers-out:${eventId}:${safeLimit}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as PlayerTransferStats[];
    }

    const { data, error } = await context.supabase
      .from('player_stats')
      .select('element_id, event_id, transfers_in_event, transfers_out_event')
      .eq('event_id', eventId)
      .not('transfers_out_event', 'is', null)
      .order('transfers_out_event', { ascending: false })
      .limit(safeLimit);

    if (error) {
      context.logger.error({ err: error, eventId, limit: safeLimit }, 'Failed to fetch top transfers out');
      throw new Error('Failed to fetch top transfers out');
    }

    const stats =
      (data as Array<{
        element_id: number;
        event_id: number;
        transfers_in_event: number;
        transfers_out_event: number;
      }> | null)?.map((row) => ({
        playerId: row.element_id,
        eventId: row.event_id,
        transfersInEvent: row.transfers_in_event ?? 0,
        transfersOutEvent: row.transfers_out_event,
      })) ?? [];

    await context.redis.set(cacheKey, JSON.stringify(stats), 'EX', env.CACHE_TTL_SECONDS);
    return stats;
  },
};
