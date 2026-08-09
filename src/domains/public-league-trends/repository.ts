import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
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
	readiness_revision?: string | Date | null;
};

type AccessRow = {
	catalog_revision: string | Date;
	snapshot_revision: string | Date;
};

const CATALOG_SQL = `
	SELECT
		catalog.tournament_id,
		catalog.display_name,
		catalog.sort_order,
		catalog.published_at,
		catalog.updated_at,
		snapshot.event_id AS latest_event_id,
		snapshot.total_entries,
		MAX(catalog.updated_at) OVER () AS catalog_revision,
		MAX(tournament.updated_at) OVER () AS snapshot_revision,
		(
			SELECT MAX(tournament_revision.updated_at)
			FROM competition.public_league_trends catalog_revision
			JOIN competition.tournaments tournament_revision
				ON tournament_revision.season_id = catalog_revision.season_id
				AND tournament_revision.tournament_id = catalog_revision.tournament_id
			WHERE catalog_revision.season_id = $1
		) AS readiness_revision
	FROM competition.public_league_trends catalog
	JOIN competition.tournaments tournament
		ON tournament.season_id = catalog.season_id
		AND tournament.tournament_id = catalog.tournament_id
		AND (tournament.setup_status IS NULL OR tournament.standings_ready_at IS NOT NULL)
	JOIN LATERAL (
		SELECT
			stats.event_id,
			MAX(stats.total_entries)::integer AS total_entries
		FROM reporting.tournament_selection_stats stats
		WHERE stats.season_id = catalog.season_id
			AND stats.tournament_id = catalog.tournament_id
		GROUP BY stats.event_id
		ORDER BY stats.event_id DESC
		LIMIT 1
	) snapshot ON true
	WHERE catalog.season_id = $1
		AND catalog.enabled = true
	ORDER BY catalog.sort_order ASC, catalog.display_name ASC, catalog.tournament_id ASC
`;

const ACCESS_SQL = `
	SELECT
		catalog.updated_at AS catalog_revision,
		GREATEST(catalog.updated_at, tournament.updated_at) AS snapshot_revision
	FROM competition.public_league_trends catalog
	JOIN competition.tournaments tournament
		ON tournament.season_id = catalog.season_id
		AND tournament.tournament_id = catalog.tournament_id
		AND (tournament.setup_status IS NULL OR tournament.standings_ready_at IS NOT NULL)
	JOIN reporting.tournament_selection_stats stats
		ON stats.season_id = catalog.season_id
		AND stats.tournament_id = catalog.tournament_id
		AND stats.event_id = $3
	WHERE catalog.enabled = true
		AND catalog.season_id = $1
		AND catalog.tournament_id = $2
	GROUP BY catalog.updated_at, tournament.updated_at
`;

const iso = (value: string | Date): string => {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("Invalid public league revision timestamp");
	return date.toISOString();
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
	executor?: QueryExecutor,
	readSelectionStats: ReadSelectionStats = getTournamentSelectionStatsReadModel
): PublicLeagueTrendsRepository => ({
	async list(context): Promise<PublicLeagueTrend[]> {
		const result = await (executor ?? context.database).query(CATALOG_SQL, [
			context.currentSeason.seasonId,
		]);
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
		const readinessRevision =
			rows[0]!.readiness_revision === undefined || rows[0]!.readiness_revision === null
				? "none"
				: iso(rows[0]!.readiness_revision);
		const cacheKey = gqlCacheKey(
			season,
			`public-league-trends:v3:${revision}:${snapshotRevision ?? "none"}:${readinessRevision}`
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
		const accessResult = await (executor ?? context.database).query(ACCESS_SQL, [
			context.currentSeason.seasonId,
			tournamentId,
			eventId,
		]);
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
