import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { env } from "../../infra/env";
import { getCurrentSeason } from "../../infra/season";
import { stableStringify } from "../../infra/stringify";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

const LEAGUE_EVENT_RESULTS_PAGE_SIZE = 1000;

const mapLeagueType = (type: string): LeagueType => {
	return type === "h2h" ? LeagueType.H2H : LeagueType.CLASSIC;
};

const mapLeague = (
	row: DbEntryLeagueRow,
	tournament?: DbTournamentEnrichmentRow | null
): League => ({
	id: row.league_id,
	name: row.league_name,
	shortName: null,
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

const fetchTournamentEnrichments = async (
	context: GraphQLContext,
	leagueKeys: string[]
): Promise<Map<string, DbTournamentEnrichmentRow>> => {
	const tournamentMap = new Map<string, DbTournamentEnrichmentRow>();
	if (leagueKeys.length === 0) return tournamentMap;

	const leagueIds = [...new Set(leagueKeys.map((k) => parseInt(k.split(":")[0], 10)))];

	const { data: tData } = await context.supabase
		.from("tournament_infos")
		.select(
			"id, name, admin_entry_id, league_id, league_type, total_team_num, tournament_mode, group_mode, state, created_at"
		)
		.in("league_id", leagueIds);

	if (tData) {
		for (const t of tData as DbTournamentEnrichmentRow[]) {
			const key = `${t.league_id}:${t.league_type}`;
			if (!tournamentMap.has(key)) {
				tournamentMap.set(key, t);
			}
		}
	}

	return tournamentMap;
};

const buildLeagueFromInfo = async (
	context: GraphQLContext,
	leagueId: number,
	leagueType: string
): Promise<League> => {
	const [lResult, tResult] = await Promise.all([
		context.supabase
			.from("entry_league_infos")
			.select(
				"league_id, league_name, league_type, entry_id, entry_rank, entry_last_rank, started_event"
			)
			.eq("league_id", leagueId)
			.eq("league_type", leagueType)
			.limit(1)
			.maybeSingle(),
		context.supabase
			.from("tournament_infos")
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
		tournamentId: tournamentRow?.id ?? null,
		tournamentName: tournamentRow?.name ?? null,
		tournamentMode: tournamentRow?.tournament_mode ?? null,
		groupMode: tournamentRow?.group_mode ?? null,
		totalTeamNum: tournamentRow?.total_team_num ?? null,
		state: tournamentRow?.state ?? null,
	};
};

interface LeaguesRepository {
	getEntryLeagues(context: GraphQLContext, entryId: number): Promise<League[]>;
	getLeagueEventResults(
		context: GraphQLContext,
		leagueId: number,
		eventId: number
	): Promise<LeagueEventResult[]>;
}

export const leaguesRepository: LeaguesRepository = {
	async getEntryLeagues(context: GraphQLContext, entryId: number): Promise<League[]> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `leagues:entry:${entryId}`);
		const cached = await readJsonCache(context, cacheKey, isLeagueArray);
		if (cached) return cached;

		const { data, error } = await context.supabase
			.from("entry_league_infos")
			.select(
				"league_id, league_name, league_type, entry_id, entry_rank, entry_last_rank, started_event"
			)
			.eq("entry_id", entryId)
			.order("league_id", { ascending: true });

		if (error) {
			context.logger.error({ err: error, entryId }, "Failed to fetch entry leagues");
			throw new Error("Failed to fetch entry leagues");
		}

		const rows = (data as DbEntryLeagueRow[] | null) ?? [];

		const leagueKeys = [...new Set(rows.map((r) => `${r.league_id}:${r.league_type}`))];
		const tournamentMap = await fetchTournamentEnrichments(context, leagueKeys);

		const leagues = rows.map((row) => {
			const key = `${row.league_id}:${row.league_type}`;
			const tournament = tournamentMap.get(key);
			return mapLeague(row, tournament);
		});

		await context.redis.set(cacheKey, JSON.stringify(leagues), "EX", env.CACHE_TTL_SECONDS);
		return leagues;
	},

	async getLeagueEventResults(
		context: GraphQLContext,
		leagueId: number,
		eventId: number
	): Promise<LeagueEventResult[]> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(
			season,
			`leagues:results:${stableStringify({ leagueId, eventId })}`
		);
		const cached = await readJsonCache(context, cacheKey, isLeagueEventResultArray);
		if (cached) return cached;

		const rows: DbLeagueEventResultRow[] = [];
		for (let from = 0; ; from += LEAGUE_EVENT_RESULTS_PAGE_SIZE) {
			const { data, error } = await context.supabase
				.from("league_event_results")
				.select(
					"league_id, league_type, event_id, entry_id, entry_name, player_name, event_points, event_rank, overall_points, overall_rank"
				)
				.eq("league_id", leagueId)
				.eq("event_id", eventId)
				.order("event_rank", { ascending: true })
				.order("entry_id", { ascending: true })
				.range(from, from + LEAGUE_EVENT_RESULTS_PAGE_SIZE - 1);
			if (error) {
				context.logger.error(
					{ err: error, leagueId, eventId },
					"Failed to fetch league event results"
				);
				throw new Error("Failed to fetch league event results");
			}
			const page = (data as DbLeagueEventResultRow[] | null) ?? [];
			rows.push(...page);
			if (page.length < LEAGUE_EVENT_RESULTS_PAGE_SIZE) break;
		}
		if (rows.length === 0) {
			return [];
		}

		const leagueType = rows[0].league_type;
		const league = await buildLeagueFromInfo(context, leagueId, leagueType);

		const results = rows.map((row) => mapLeagueEventResult(row, league));

		try {
			await context.redis.set(cacheKey, JSON.stringify(results), "EX", env.CACHE_TTL_SECONDS);
		} catch (cacheError) {
			context.logger.warn(
				{ err: cacheError, leagueId, eventId },
				"Failed to cache league event results"
			);
		}
		return results;
	},
};
