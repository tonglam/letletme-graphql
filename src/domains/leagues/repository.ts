import type { GraphQLContext } from "../../graphql/context";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import { gqlCacheKey } from "../../infra/cache-key";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { stableStringify } from "../../infra/stringify";
import type { OfficialLeagueKind } from "./display-order";
import { mapFplOfficialKind, sortLeaguesForOfficialDisplay } from "./display-order";

const readJsonCache = async <T>(
	context: GraphQLContext,
	key: string,
	validate: (value: unknown) => value is T
): Promise<T | null> => {
	let cached: string | null;
	try {
		cached = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read leagues cache");
		return null;
	}
	if (cached === null) return null;
	try {
		const parsed: unknown = JSON.parse(cached);
		if (validate(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed leagues cache");
	}
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict malformed leagues cache");
	}
	return null;
};

const isLeagueArray = (value: unknown): value is League[] =>
	Array.isArray(value) && value.every((item) => isRecord(item) && Number.isFinite(Number(item.id)));

const isLeagueEventResultArray = (value: unknown): value is LeagueEventResult[] =>
	Array.isArray(value) &&
	value.every(
		(item) =>
			isRecord(item) &&
			Number.isFinite(Number(item.eventId)) &&
			Number.isFinite(Number(item.entryId)) &&
			isRecord(item.league)
	);

export enum LeagueType {
	CLASSIC = "classic",
	H2H = "h2h",
}

export type League = {
	id: number;
	name: string;
	shortName: string | null;
	type: LeagueType;
	created: string | null;
	closed: boolean | null;
	maxEntries: number | null;
	scoring: string | null;
	adminEntry: number | null;
	startEvent: number | null;
	startedEvent: number | null;
	entryRank: number | null;
	entryLastRank: number | null;
	officialKind: OfficialLeagueKind | null;
	tournamentId: number | null;
	tournamentName: string | null;
	tournamentMode: string | null;
	groupMode: string | null;
	totalTeamNum: number | null;
	state: string | null;
};

export type LeagueEventResult = {
	league: League;
	eventId: number;
	entryId: number;
	entryName: string | null;
	playerName: string | null;
	eventPoints: number;
	eventRank: number | null;
	overallPoints: number;
	overallRank: number;
};

type DbEntryLeagueRow = {
	league_id: number;
	league_name: string;
	league_type: string;
	entry_id: number;
	entry_rank: number | null;
	entry_last_rank: number | null;
	started_event: number | null;
	official_kind: string | null;
	short_name: string | null;
};

type DbTournamentEnrichmentRow = {
	id: number;
	name: string;
	admin_entry_id: number;
	league_id: number;
	league_type: string;
	total_team_num: number;
	tournament_mode: string;
	group_mode: string | null;
	state: string;
	created_at: string;
};

type TournamentProjection = {
	id: number | null;
	name: string | null;
	admin_entry_id: number | null;
	total_team_num: number | null;
	tournament_mode: string | null;
	group_mode: string | null;
	state: string | null;
	created_at: string | null;
};

type DbEntryLeagueWithTournamentRow = DbEntryLeagueRow & {
	tournament_id: number | null;
	tournament_name: string | null;
	tournament_admin_entry_id: number | null;
	tournament_total_team_num: number | null;
	tournament_mode: string | null;
	tournament_group_mode: string | null;
	tournament_state: string | null;
	tournament_created_at: string | null;
};

type DbLeagueEventResultRow = {
	league_id: number;
	league_type: string;
	event_id: number;
	entry_id: number;
	entry_name: string | null;
	player_name: string | null;
	event_points: number;
	event_rank: number | null;
	overall_points: number;
	overall_rank: number;
};

const mapLeagueType = (type: string): LeagueType => {
	return type === "h2h" ? LeagueType.H2H : LeagueType.CLASSIC;
};

const mapLeague = (row: DbEntryLeagueRow, tournament?: TournamentProjection | null): League => ({
	id: row.league_id,
	name: row.league_name,
	shortName: row.short_name ?? null,
	type: mapLeagueType(row.league_type),
	created: tournament?.created_at ?? null,
	closed: tournament?.state === "finished" ? true : null,
	maxEntries: tournament?.total_team_num ?? null,
	scoring: null,
	adminEntry: tournament?.admin_entry_id ?? null,
	startEvent: null,
	startedEvent: row.started_event,
	entryRank: row.entry_rank,
	entryLastRank: row.entry_last_rank,
	officialKind: mapFplOfficialKind(row.official_kind),
	tournamentId: tournament?.id ?? null,
	tournamentName: tournament?.name ?? null,
	tournamentMode: tournament?.tournament_mode ?? null,
	groupMode: tournament?.group_mode ?? null,
	totalTeamNum: tournament?.total_team_num ?? null,
	state: tournament?.state ?? null,
});

const mapLeagueEventResult = (row: DbLeagueEventResultRow, league: League): LeagueEventResult => ({
	league,
	eventId: row.event_id,
	entryId: row.entry_id,
	entryName: row.entry_name,
	playerName: row.player_name,
	eventPoints: row.event_points,
	eventRank: row.event_rank,
	overallPoints: row.overall_points,
	overallRank: row.overall_rank,
});

const mapTournamentProjection = (
	row: DbEntryLeagueWithTournamentRow
): TournamentProjection | null => {
	if (row.tournament_id === null) return null;
	return {
		id: row.tournament_id,
		name: row.tournament_name,
		admin_entry_id: row.tournament_admin_entry_id,
		total_team_num: row.tournament_total_team_num,
		tournament_mode: row.tournament_mode,
		group_mode: row.tournament_group_mode,
		state: row.tournament_state,
		created_at: row.tournament_created_at,
	};
};

const buildLeagueFromInfo = async (
	context: GraphQLContext,
	leagueId: number,
	leagueType: string
): Promise<League> => {
	const [lResult, tResult] = await Promise.all([
		context.data
			.read("competition.entry_leagues")
			.select(
				"league_id, league_name, league_type, entry_id, entry_rank, entry_last_rank, started_event, official_kind, short_name"
			)
			.eq("league_id", leagueId)
			.eq("league_type", leagueType)
			.limit(1)
			.maybeSingle(),
		context.data
			.read("competition.tournaments")
			.select(
				"id, name, admin_entry_id, league_id, league_type, total_team_num, tournament_mode, group_mode, state, created_at"
			)
			.eq("league_id", leagueId)
			.eq("league_type", leagueType)
			.limit(1)
			.maybeSingle(),
	]);

	const leagueRow = lResult.data as DbEntryLeagueRow | null;
	const tournamentRow = tResult.data as DbTournamentEnrichmentRow | null;

	if (leagueRow) {
		return mapLeague(leagueRow, tournamentRow);
	}

	return {
		id: leagueId,
		name: "",
		shortName: null,
		type: mapLeagueType(leagueType),
		created: tournamentRow?.created_at ?? null,
		closed: tournamentRow?.state === "finished" ? true : null,
		maxEntries: tournamentRow?.total_team_num ?? null,
		scoring: null,
		adminEntry: tournamentRow?.admin_entry_id ?? null,
		startEvent: null,
		startedEvent: null,
		entryRank: null,
		entryLastRank: null,
		officialKind: null,
		tournamentId: tournamentRow?.id ?? null,
		tournamentName: tournamentRow?.name ?? null,
		tournamentMode: tournamentRow?.tournament_mode ?? null,
		groupMode: tournamentRow?.group_mode ?? null,
		totalTeamNum: tournamentRow?.total_team_num ?? null,
		state: tournamentRow?.state ?? null,
	};
};

const normalizeLeagueTypeFilter = (type?: string | null): string | null => {
	if (!type) return null;
	const upper = type.trim().toUpperCase();
	return upper === "H2H" ? "h2h" : upper === "CLASSIC" ? "classic" : null;
};

interface LeaguesRepository {
	getEntryLeagues(
		context: GraphQLContext,
		entryId: number,
		type?: string | null
	): Promise<League[]>;
	getLeagueEventResults(
		context: GraphQLContext,
		leagueId: number,
		eventId: number
	): Promise<LeagueEventResult[]>;
}

export const leaguesRepository: LeaguesRepository = {
	async getEntryLeagues(
		context: GraphQLContext,
		entryId: number,
		type?: string | null
	): Promise<League[]> {
		const dbType = normalizeLeagueTypeFilter(type);
		const cacheSuffix = dbType ? `:${dbType}` : "";
		const cacheKey = gqlCacheKey(context, `leagues:entry:v2:${entryId}${cacheSuffix}`);
		const cached = await readJsonCache(context, cacheKey, isLeagueArray);
		if (cached) return cached;

		let query = context.data
			.read("competition.entry_leagues_with_tournament")
			.select(
				"league_id, league_name, league_type, entry_id, entry_rank, entry_last_rank, started_event, official_kind, short_name, tournament_id, tournament_name, tournament_admin_entry_id, tournament_total_team_num, tournament_mode, tournament_group_mode, tournament_state, tournament_created_at"
			)
			.eq("entry_id", entryId);
		if (dbType) {
			query = query.eq("league_type", dbType);
		}
		const { data, error } = await query;

		if (error) {
			context.logger.error({ err: error, entryId }, "Failed to fetch entry leagues");
			throw new Error("Failed to fetch entry leagues");
		}

		const rows = (data as DbEntryLeagueWithTournamentRow[] | null) ?? [];

		const leagues = sortLeaguesForOfficialDisplay(
			rows.map((row) => {
				return mapLeague(row, mapTournamentProjection(row));
			})
		);

		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(leagues),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
		return leagues;
	},

	async getLeagueEventResults(
		context: GraphQLContext,
		leagueId: number,
		eventId: number
	): Promise<LeagueEventResult[]> {
		const cacheKey = gqlCacheKey(
			context,
			`leagues:results:v2:${stableStringify({ leagueId, eventId })}`
		);
		const cached = await readJsonCache(context, cacheKey, isLeagueEventResultArray);
		if (cached) return cached;

		const { data, error } = await context.data
			.read("competition.league_event_results")
			.select(
				"league_id, league_type, event_id, entry_id, entry_name, player_name, event_points, event_rank, overall_points, overall_rank"
			)
			.eq("league_id", leagueId)
			.eq("event_id", eventId)
			.order("event_rank", { ascending: true });

		if (error) {
			context.logger.error(
				{ err: error, leagueId, eventId },
				"Failed to fetch league event results"
			);
			throw new Error("Failed to fetch league event results");
		}

		const rows = (data as DbLeagueEventResultRow[] | null) ?? [];
		if (rows.length === 0) {
			return [];
		}

		const leagueType = rows[0].league_type;
		const league = await buildLeagueFromInfo(context, leagueId, leagueType);

		const results = rows.map((row) => mapLeagueEventResult(row, league));

		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(results),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
		return results;
	},
};
