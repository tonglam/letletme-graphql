import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID } from "../../contracts/data-fixture-identities";
import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { QUERY_CACHE_TTL_SECONDS, writeQueryCache } from "../../infra/query-cache";
import { type TournamentSelectionStats } from "../event-stats/repository";

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
	selection_publication_id: string | number;
	selection_revision: string | number;
};

type SelectionCapabilityState = "READY" | "NOT_READY" | "FAILED" | "UNSUPPORTED";

export type PublicLeagueSelectionPublication = Readonly<{
	publicationId: number;
	expectedEntries: number;
	revision: number;
	ownershipState: SelectionCapabilityState;
	captaincyState: SelectionCapabilityState;
	viceCaptaincyState: SelectionCapabilityState;
	transfersState: SelectionCapabilityState;
}>;

const SELECTION_CAPABILITY_STATES: readonly SelectionCapabilityState[] = [
	"READY",
	"NOT_READY",
	"FAILED",
	"UNSUPPORTED",
];

const sqlSafeInteger = (value: unknown, minimum: number): number | null => {
	const candidate =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: null;
	return candidate !== null && Number.isSafeInteger(candidate) && candidate >= minimum
		? candidate
		: null;
};

const isSelectionCapabilityState = (value: unknown): value is SelectionCapabilityState =>
	typeof value === "string" &&
	SELECTION_CAPABILITY_STATES.includes(value as SelectionCapabilityState);

/**
 * Decode the publication metadata consumed by the public selection reader.
 * PostgreSQL bigint values may arrive as strings, so numeric coercion is
 * explicit and bounded before any percentage calculation is attempted.
 */
export const parsePublicLeagueSelectionPublication = (
	value: unknown
): PublicLeagueSelectionPublication | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const publicationId = sqlSafeInteger(row.publication_id, 1);
	const expectedEntries = sqlSafeInteger(row.expected_entries, 0);
	const revision = sqlSafeInteger(row.revision, 1);
	const states = [
		row.ownership_state,
		row.captaincy_state,
		row.vice_captaincy_state,
		row.transfers_state,
	];
	if (
		publicationId === null ||
		expectedEntries === null ||
		revision === null ||
		states.some((state) => !isSelectionCapabilityState(state))
	) {
		return null;
	}
	return {
		publicationId,
		expectedEntries,
		revision,
		ownershipState: row.ownership_state as SelectionCapabilityState,
		captaincyState: row.captaincy_state as SelectionCapabilityState,
		viceCaptaincyState: row.vice_captaincy_state as SelectionCapabilityState,
		transfersState: row.transfers_state as SelectionCapabilityState,
	};
};

export const PUBLIC_LEAGUE_SELECTION_SQL = `
	SELECT publication.publication_id, publication.expected_entries, publication.revision,
		publication.ownership_state, publication.captaincy_state, publication.vice_captaincy_state,
		publication.transfers_state,
		rows.element_id, rows.selected_count, rows.effective_selection_count,
		rows.captain_count, rows.vice_captain_count, rows.transfer_in_count,
		rows.transfer_out_count, rows.player_name, rows.player_position, rows.team_short_name
	FROM reporting.tournament_selection_stat_publications publication
	LEFT JOIN reporting.tournament_selection_stat_rows rows
		ON rows.publication_id = publication.publication_id
	WHERE publication.season_id = $1 AND publication.tournament_id = $2
		AND publication.event_id = $3
		AND publication.publication_id = $4::bigint
		AND publication.revision = $5::bigint
		AND publication.is_active
	ORDER BY rows.selected_count DESC NULLS LAST, rows.element_id
`;

const publicationPosition = (value: number): string =>
	value === 1 ? "GOALKEEPER" : value === 2 ? "DEFENDER" : value === 4 ? "FORWARD" : "MIDFIELDER";

async function readPublishedSelectionStats(
	context: GraphQLContext,
	executor: QueryExecutor,
	tournamentId: number,
	eventId: number,
	publicationId: number,
	publicationRevision: number,
	limit: number
): Promise<TournamentSelectionStats | null> {
	try {
		// getSelectionStats has already authorized the publication through the
		// catalog/readiness query. Keep this read to one publication SQL round trip.
		const result = (await executor.query(PUBLIC_LEAGUE_SELECTION_SQL, [
			context.currentSeason.seasonId,
			tournamentId,
			eventId,
			publicationId,
			publicationRevision,
		])) as { rows: Record<string, unknown>[] };
		const first = result.rows[0];
		if (!first) return null;
		const publication = parsePublicLeagueSelectionPublication(first);
		if (!publication || publication.ownershipState !== "READY") return null;
		const totalEntries = publication.expectedEntries;
		const percent = (value: number) => (totalEntries > 0 ? (value / totalEntries) * 100 : 0);
		const rows = result.rows.filter(
			(row) => row.element_id !== null && row.element_id !== undefined
		);
		const selection = rows.map((row) => {
			const selected = Number(row.selected_count ?? 0);
			const effective = Number(row.effective_selection_count ?? 0);
			return {
				id: Number(row.element_id),
				webName: String(row.player_name),
				teamShortName: String(row.team_short_name),
				position: publicationPosition(Number(row.player_position)),
				selectedByPercent: percent(selected),
				eoByPercent: percent(effective),
			};
		});
		const captain =
			publication.captaincyState === "READY"
				? rows
						.map((row) => ({
							id: Number(row.element_id),
							webName: String(row.player_name),
							teamShortName: String(row.team_short_name),
							position: publicationPosition(Number(row.player_position)),
							captainByPercent: percent(Number(row.captain_count ?? 0)),
							selectedByPercent: percent(Number(row.selected_count ?? 0)),
							eoByPercent: percent(Number(row.effective_selection_count ?? 0)),
						}))
						.sort(
							(left, right) => right.captainByPercent - left.captainByPercent || left.id - right.id
						)
						.slice(0, limit)
				: [];
		const viceCaptain =
			publication.viceCaptaincyState === "READY"
				? rows
						.map((row) => ({
							id: Number(row.element_id),
							webName: String(row.player_name),
							teamShortName: String(row.team_short_name),
							position: publicationPosition(Number(row.player_position)),
							captainByPercent: (Number(row.vice_captain_count ?? 0) / totalEntries) * 100,
							selectedByPercent: percent(Number(row.selected_count ?? 0)),
							eoByPercent: percent(Number(row.effective_selection_count ?? 0)),
						}))
						.sort(
							(left, right) => right.captainByPercent - left.captainByPercent || left.id - right.id
						)
						.slice(0, limit)
				: [];
		const transfersAvailable = publication.transfersState === "READY";
		const transferRows = (direction: "in" | "out") =>
			rows
				.filter(
					(row) =>
						transfersAvailable &&
						row[direction === "in" ? "transfer_in_count" : "transfer_out_count"] !== null &&
						row[direction === "in" ? "transfer_in_count" : "transfer_out_count"] !== undefined
				)
				.map((row) => ({
					id: Number(row.element_id),
					webName: String(row.player_name),
					teamShortName: String(row.team_short_name),
					position: publicationPosition(Number(row.player_position)),
					transfersEvent: Number(
						row[direction === "in" ? "transfer_in_count" : "transfer_out_count"] ?? 0
					),
					selectedByPercent: percent(Number(row.selected_count ?? 0)),
				}))
				.sort((left, right) => right.transfersEvent - left.transfersEvent || left.id - right.id)
				.slice(0, limit);
		return {
			totalEntries,
			goalkeepers: selection.filter((row) => row.position === "GOALKEEPER").slice(0, limit),
			defenders: selection.filter((row) => row.position === "DEFENDER").slice(0, limit),
			midfielders: selection.filter((row) => row.position === "MIDFIELDER").slice(0, limit),
			forwards: selection.filter((row) => row.position === "FORWARD").slice(0, limit),
			captainSelect: captain,
			viceCaptainSelect: viceCaptain,
			mostSelectedPlayers: selection.slice(0, limit),
			mostTransferIn: transferRows("in"),
			mostTransferOut: transferRows("out"),
		};
	} catch (error) {
		context.logger.error({ err: error }, "Trends publication read unavailable");
		throw error;
	}
}

export const PUBLIC_LEAGUE_CATALOG_SQL = `
	SELECT
		catalog.tournament_id,
		catalog.display_name,
		catalog.sort_order,
		catalog.published_at,
		catalog.updated_at,
		publication.event_id AS latest_event_id,
		publication.expected_entries AS total_entries,
		MAX(catalog.updated_at) OVER () AS catalog_revision,
		GREATEST(tournament.updated_at, COALESCE(publication.published_at, tournament.updated_at)) AS snapshot_revision,
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
		AND tournament.setup_status = 'ready'
	JOIN LATERAL (
		SELECT publication.event_id, publication.expected_entries, publication.revision,
			publication.published_at
		FROM reporting.tournament_selection_stat_publications publication
		WHERE publication.season_id = catalog.season_id
			AND publication.tournament_id = catalog.tournament_id
			AND publication.is_active
		ORDER BY publication.event_id DESC, publication.revision DESC
		LIMIT 1
	) publication ON true
	WHERE catalog.season_id = $1
		AND catalog.enabled = true
	ORDER BY catalog.sort_order ASC, catalog.display_name ASC, catalog.tournament_id ASC
`;

export const PUBLIC_LEAGUE_ACCESS_SQL = `
	SELECT
		catalog.updated_at AS catalog_revision,
		GREATEST(catalog.updated_at, tournament.updated_at, COALESCE(publication.published_at, tournament.updated_at)) AS snapshot_revision,
		publication.publication_id AS selection_publication_id,
		publication.revision AS selection_revision
	FROM competition.public_league_trends catalog
	JOIN competition.tournaments tournament
		ON tournament.season_id = catalog.season_id
		AND tournament.tournament_id = catalog.tournament_id
		AND tournament.setup_status = 'ready'
	JOIN reporting.tournament_selection_stat_publications publication
		ON publication.season_id = catalog.season_id
		AND publication.tournament_id = catalog.tournament_id
		AND publication.event_id = $3
		AND publication.is_active
	WHERE catalog.enabled = true
		AND catalog.season_id = $1
		AND catalog.tournament_id = $2
	GROUP BY catalog.updated_at, tournament.updated_at, publication.published_at,
		publication.publication_id, publication.revision
`;

export const PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "public-league-trends.catalog",
		sql: PUBLIC_LEAGUE_CATALOG_SQL,
		values: [2026],
		runtime: "must-return-row",
		resultTypes: [
			{
				relation: "competition.public_league_trends",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.public_league_trends",
				column: "updated_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "public-league-trends.access",
		sql: PUBLIC_LEAGUE_ACCESS_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 2],
		resultTypes: [
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "publication_id",
				pgType: "bigint",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "public-league-trends.selection",
		sql: PUBLIC_LEAGUE_SELECTION_SQL,
		// The authority fixture inserts event 1 then the eligible event 2
		// publication at identity 2, revision 7, on a fresh database.
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 2, 2, 7],
		runtime: "must-return-selection-row",
	},
];

const iso = (value: string | Date): string => {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("Invalid public league revision timestamp");
	return date.toISOString();
};

const catalogSnapshotRevision = (rows: readonly CatalogRow[]): string =>
	rows
		.map(
			(row) =>
				`${Number(row.tournament_id)}:${Number(row.latest_event_id)}:${Number(row.total_entries)}`
		)
		.sort()
		.join(",");

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

export const createPublicLeagueTrendsRepository = (
	executor?: QueryExecutor
): PublicLeagueTrendsRepository => ({
	async list(context): Promise<PublicLeagueTrend[]> {
		const result = await (executor ?? context.database).query(PUBLIC_LEAGUE_CATALOG_SQL, [
			context.currentSeason.seasonId,
		]);
		const rows = result.rows as CatalogRow[];
		if (rows.length === 0) return [];
		const revision = iso(rows[0]!.catalog_revision);
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
			context,
			`public-league-trends:${revision}:${snapshotRevision ?? "none"}:${catalogSnapshotRevision(rows)}:${readinessRevision}`
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
		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(trends),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
		return trends;
	},

	async getSelectionStats(
		context,
		tournamentId,
		eventId,
		limit
	): Promise<TournamentSelectionStats | null> {
		const accessResult = await (executor ?? context.database).query(PUBLIC_LEAGUE_ACCESS_SQL, [
			context.currentSeason.seasonId,
			tournamentId,
			eventId,
		]);
		const access = accessResult.rows[0] as AccessRow | undefined;
		const selectionPublicationId = sqlSafeInteger(access?.selection_publication_id, 1);
		const selectionRevision = sqlSafeInteger(access?.selection_revision, 1);
		if (
			!access?.catalog_revision ||
			!access.snapshot_revision ||
			selectionPublicationId === null ||
			selectionRevision === null
		) {
			return null;
		}
		const safeLimit = Math.min(Math.max(limit, 1), 12);
		const cacheKey = gqlCacheKey(
			context,
			`public-league-selection:${iso(access.catalog_revision)}:${tournamentId}:${eventId}:${safeLimit}:${iso(access.snapshot_revision)}:${selectionPublicationId}:${selectionRevision}`
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
		const stats = await readPublishedSelectionStats(
			context,
			executor ?? context.database,
			tournamentId,
			eventId,
			selectionPublicationId,
			selectionRevision,
			safeLimit
		);
		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(stats),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
		return stats;
	},
});

export const publicLeagueTrendsRepository = createPublicLeagueTrendsRepository();
