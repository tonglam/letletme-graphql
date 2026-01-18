import type { GraphQLContext } from '../../graphql/context';
import { env } from '../../infra/env';

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

interface PlayersRepository {
  getPlayerById(context: GraphQLContext, id: number): Promise<Player | null>;
  listPlayers(
    context: GraphQLContext,
    filter: PlayersFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Player[]>;
  getTeamById(context: GraphQLContext, id: number): Promise<Team | null>;
  listTeams(context: GraphQLContext): Promise<Team[]>;
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
    const cacheKey = `teams:id:${id}`;
    const cached = await context.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Team;
    }

    const { data, error } = await context.supabase.from('teams').select('*').eq('id', id).limit(1);

    if (error) {
      context.logger.error({ err: error, id }, 'Failed to fetch team');
      throw new Error('Failed to fetch team');
    }

    const row = data?.[0] as DbTeamRow | undefined;
    if (!row) {
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
};
