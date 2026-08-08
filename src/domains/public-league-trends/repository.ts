import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { dbPool } from "../../infra/db-pool";
import { env } from "../../infra/env";
import { getCurrentSeason } from "../../infra/season";
import {
	getTournamentSelectionStatsReadModel,
	type TournamentSelectionStats,
} from "../event-stats/repository";

export type PublicLeagueTrend = {
	tournamentId: number;
	displayName: string;
	sortOrder: number;
	publishedAt: string;
	updatedAt: string;
	latestAvailableEventId: number;
	totalEntries: number;
};

type QueryExecutor = {
	query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

type CatalogRow = {
	tournament_id: number;
	display_name: string;
	sort_order: number;
	published_at: string | Date;
	updated_at: string | Date;
	latest_event_id: number;
	total_entries: number;
	catalog_revision: string | Date;
	snapshot_revision?: string | Date | null;
};

type AccessRow = {
	catalog_revision: string | Date;
	snapshot_revision: string | Date;
};

const CATALOG_EXISTS_SQL = `
	SELECT to_regclass('public.public_league_trends_catalog') AS catalog
`;

const CATALOG_SQL = `
	SELECT
		catalog.tournament_id,
		catalog.display_name,
		catalog.sort_order,
		catalog.published_at,
		catalog.updated_at,
		snapshot.event_id AS latest_event_id,
		snapshot.total_entries,
		(SELECT MAX(updated_at) FROM public.public_league_trends_catalog) AS catalog_revision,
		MAX(snapshot.snapshot_revision) OVER () AS snapshot_revision
	FROM public.public_league_trends_catalog catalog
	JOIN public.tournament_infos tournament
		ON tournament.id = catalog.tournament_id
		AND tournament.setup_status = 'READY'
	JOIN LATERAL (
		SELECT
			stats.event_id,
			MAX(stats.total_entries)::integer AS total_entries,
			MAX(COALESCE(stats.updated_at, stats.created_at)) AS snapshot_revision
		FROM public.tournament_selection_stats stats
		WHERE stats.tournament_id = catalog.tournament_id
		GROUP BY stats.event_id
		ORDER BY stats.event_id DESC
		LIMIT 1
	) snapshot ON true
	WHERE catalog.enabled = true
	ORDER BY catalog.sort_order ASC, catalog.display_name ASC, catalog.tournament_id ASC
`;

const ACCESS_SQL = `
	SELECT
		(SELECT MAX(updated_at) FROM public.public_league_trends_catalog) AS catalog_revision,
		MAX(COALESCE(stats.updated_at, stats.created_at)) AS snapshot_revision
	FROM public.public_league_trends_catalog catalog
	JOIN public.tournament_infos tournament
		ON tournament.id = catalog.tournament_id
		AND tournament.setup_status = 'READY'
	JOIN public.tournament_selection_stats stats
		ON stats.tournament_id = catalog.tournament_id
		AND stats.event_id = $2
	WHERE catalog.enabled = true
		AND catalog.tournament_id = $1
	GROUP BY catalog.tournament_id
`;

const iso = (value: string | Date): string => {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("Invalid public league revision timestamp");
	return date.toISOString();
};

const catalogAvailable = async (executor: QueryExecutor): Promise<boolean> => {
	const result = await executor.query(CATALOG_EXISTS_SQL);
	const row = result.rows[0] as { catalog?: unknown } | undefined;
	return typeof row?.catalog === "string" && row.catalog.length > 0;
};

const parseCachedStats = (value: string): TournamentSelectionStats | null | undefined => {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed === null) return null;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as TournamentSelectionStats;
		}
	} catch {
		return undefined;
	}
	return undefined;
};

export type PublicLeagueTrendsRepository = {
	list(context: GraphQLContext): Promise<PublicLeagueTrend[]>;
	getSelectionStats(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number
	): Promise<TournamentSelectionStats | null>;
};

type ReadSelectionStats = typeof getTournamentSelectionStatsReadModel;

export const createPublicLeagueTrendsRepository = (
	executor: QueryExecutor = dbPool as unknown as QueryExecutor,
	readSelectionStats: ReadSelectionStats = getTournamentSelectionStatsReadModel
): PublicLeagueTrendsRepository => ({
	async list(context): Promise<PublicLeagueTrend[]> {
		if (!(await catalogAvailable(executor))) return [];
		const result = await executor.query(CATALOG_SQL);
		const rows = result.rows as CatalogRow[];
		if (rows.length === 0) return [];
		const revision = iso(rows[0]!.catalog_revision);
		const season = await getCurrentSeason(context);
		const snapshotRevision = rows
			.map((row) =>
				row.snapshot_revision === undefined || row.snapshot_revision === null
					? null
					: iso(row.snapshot_revision)
			)
			.filter((value): value is string => value !== null)
			.sort()
			.at(-1);
		const cacheKey = gqlCacheKey(
			season,
			`public-league-trends:v2:${revision}:${snapshotRevision ?? "none"}`
		);
		try {
			const cached = await context.redis.get(cacheKey);
			if (cached !== null) {
				const parsed: unknown = JSON.parse(cached);
				if (Array.isArray(parsed)) return parsed as PublicLeagueTrend[];
			}
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to read public league catalog cache");
		}
		const trends = rows.map((row) => ({
			tournamentId: Number(row.tournament_id),
			displayName: row.display_name,
			sortOrder: Number(row.sort_order),
			publishedAt: iso(row.published_at),
			updatedAt: iso(row.updated_at),
			latestAvailableEventId: Number(row.latest_event_id),
			totalEntries: Number(row.total_entries),
		}));
		try {
			await context.redis.set(cacheKey, JSON.stringify(trends), "EX", env.CACHE_TTL_SECONDS);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to write public league catalog cache");
		}
		return trends;
	},

	async getSelectionStats(
		context,
		tournamentId,
		eventId,
		limit
	): Promise<TournamentSelectionStats | null> {
		if (!(await catalogAvailable(executor))) return null;
		const accessResult = await executor.query(ACCESS_SQL, [tournamentId, eventId]);
		const access = accessResult.rows[0] as AccessRow | undefined;
		if (!access?.catalog_revision || !access.snapshot_revision) return null;
		const season = await getCurrentSeason(context);
		const safeLimit = Math.min(Math.max(limit, 1), 12);
		const cacheKey = gqlCacheKey(
			season,
			`public-league-selection:v1:${iso(access.catalog_revision)}:${tournamentId}:${eventId}:${safeLimit}:${iso(access.snapshot_revision)}`
		);
		try {
			const cached = await context.redis.get(cacheKey);
			if (cached !== null) {
				const parsed = parseCachedStats(cached);
				if (parsed !== undefined) return parsed;
				await context.redis.del(cacheKey);
			}
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to read public league stats cache");
		}
		const stats = await readSelectionStats(context, tournamentId, eventId, safeLimit);
		try {
			await context.redis.set(cacheKey, JSON.stringify(stats), "EX", env.CACHE_TTL_SECONDS);
		} catch (error) {
			context.logger.warn({ err: error, cacheKey }, "Failed to write public league stats cache");
		}
		return stats;
	},
});

export const publicLeagueTrendsRepository = createPublicLeagueTrendsRepository();
