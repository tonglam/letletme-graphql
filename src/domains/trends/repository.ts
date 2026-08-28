import { GraphQLError } from "graphql";
import { createHash } from "crypto";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID } from "../../contracts/data-fixture-identities";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import type { GraphQLContext } from "../../graphql/context";
import { authorizeViewerEntry, viewerEntryIdForPrincipal } from "../../graphql/authorization";
import { gqlCacheKey } from "../../infra/cache-key";

const capabilities = [
	"OWNERSHIP",
	"EFFECTIVE_OWNERSHIP",
	"CAPTAINCY",
	"VICE_CAPTAINCY",
	"TRANSFERS",
	"PERSONAL_EXPOSURE",
] as const;

type AggregateTrendCapability = Exclude<(typeof capabilities)[number], "PERSONAL_EXPOSURE">;
type TrendCapability = (typeof capabilities)[number];

const aggregateTrendCapabilities: readonly AggregateTrendCapability[] = [
	"OWNERSHIP",
	"EFFECTIVE_OWNERSHIP",
	"CAPTAINCY",
	"VICE_CAPTAINCY",
	"TRANSFERS",
];

/**
 * Keep the aggregate read as one bounded statement.  Each arm owns its sort
 * and LIMIT so a popular capability cannot consume another capability's page.
 * The only interpolated values are compile-time column names and labels.
 */
export const TRENDS_AGGREGATE_UNION_SQL = `
      SELECT * FROM (
        SELECT 'OWNERSHIP'::text AS capability, element_id, player_name, player_position, team_short_name,
          selected_count AS count, NULL::integer AS pick_position
        FROM reporting.tournament_selection_stat_rows
        WHERE publication_id = $1
        ORDER BY selected_count DESC NULLS LAST, element_id
        LIMIT $2
      ) ownership
      UNION ALL
      SELECT * FROM (
        SELECT 'EFFECTIVE_OWNERSHIP'::text AS capability, element_id, player_name, player_position, team_short_name,
          effective_selection_count AS count, NULL::integer AS pick_position
        FROM reporting.tournament_selection_stat_rows
        WHERE publication_id = $1
        ORDER BY effective_selection_count DESC NULLS LAST, element_id
        LIMIT $2
      ) effective_ownership
      UNION ALL
      SELECT * FROM (
        SELECT 'CAPTAINCY'::text AS capability, element_id, player_name, player_position, team_short_name,
          captain_count AS count, NULL::integer AS pick_position
        FROM reporting.tournament_selection_stat_rows
        WHERE publication_id = $1
        ORDER BY captain_count DESC NULLS LAST, element_id
        LIMIT $2
      ) captaincy
      UNION ALL
      SELECT * FROM (
        SELECT 'VICE_CAPTAINCY'::text AS capability, element_id, player_name, player_position, team_short_name,
          vice_captain_count AS count, NULL::integer AS pick_position
        FROM reporting.tournament_selection_stat_rows
        WHERE publication_id = $1
        ORDER BY vice_captain_count DESC NULLS LAST, element_id
        LIMIT $2
      ) vice_captaincy
      UNION ALL
      SELECT * FROM (
        SELECT 'TRANSFERS'::text AS capability, element_id, player_name, player_position, team_short_name,
          transfer_in_count AS count, NULL::integer AS pick_position
        FROM reporting.tournament_selection_stat_rows
        WHERE publication_id = $1
        ORDER BY transfer_in_count DESC NULLS LAST, element_id
        LIMIT $2
      ) transfers
      UNION ALL
      SELECT * FROM (
        SELECT 'PERSONAL_EXPOSURE'::text AS capability, pick.element_id,
          COALESCE(NULLIF(concat_ws(' ', player.first_name, player.second_name), ''), player.web_name) AS player_name,
          player.element_type AS player_position, team.short_name AS team_short_name, pick.multiplier::int AS count,
          pick.position AS pick_position
        FROM competition.entry_event_picks pick
        JOIN fpl.players player ON player.season_id = pick.season_id AND player.element_id = pick.element_id
        JOIN fpl.teams team ON team.season_id = pick.season_id AND team.team_id = player.team_id
        WHERE pick.season_id = $3 AND pick.entry_id = $4 AND pick.event_id = $5
        ORDER BY pick.multiplier DESC, pick.position
      ) personal
      ORDER BY capability, count DESC NULLS LAST, pick_position ASC NULLS LAST, element_id`;

export const TRENDS_COHORTS_MINE_SQL = `
	SELECT tournament.tournament_id, tournament.setup_status,
		COALESCE(catalog.display_name, tournament.name) AS display_name,
		latest.event_id AS latest_event_id, latest.revision, latest.publication_state,
		latest.captured_at AS source_checked_at,
		latest.ownership_state, latest.captaincy_state, latest.vice_captaincy_state, latest.transfers_state
	FROM competition.tournament_entries member
	JOIN competition.tournaments tournament
		ON tournament.season_id = member.season_id
		AND tournament.tournament_id = member.tournament_id
	LEFT JOIN competition.public_league_trends catalog
		ON catalog.season_id = tournament.season_id AND catalog.tournament_id = tournament.tournament_id
	LEFT JOIN LATERAL (
		SELECT publication.event_id, publication.revision, publication.publication_state,
			publication.captured_at,
			publication.ownership_state, publication.captaincy_state, publication.vice_captaincy_state,
			publication.transfers_state
		FROM reporting.tournament_selection_stat_publications publication
		WHERE publication.season_id = tournament.season_id
			AND publication.tournament_id = tournament.tournament_id AND publication.is_active
		ORDER BY publication.event_id DESC, publication.revision DESC LIMIT 1
	) latest ON true
	WHERE member.season_id = $1 AND member.entry_id = $2
	ORDER BY COALESCE(catalog.sort_order, 0), tournament.tournament_id
`;

export const TRENDS_COHORTS_PUBLIC_SQL = `
	SELECT catalog.tournament_id, tournament.setup_status, catalog.display_name,
		latest.event_id AS latest_event_id, latest.revision, latest.publication_state,
		latest.captured_at AS source_checked_at,
		latest.ownership_state, latest.captaincy_state, latest.vice_captaincy_state, latest.transfers_state
	FROM competition.public_league_trends catalog
	JOIN competition.tournaments tournament
		ON tournament.season_id = catalog.season_id
		AND tournament.tournament_id = catalog.tournament_id
		AND tournament.setup_status = 'ready'
	LEFT JOIN LATERAL (
		SELECT publication.event_id, publication.revision, publication.publication_state,
			publication.captured_at,
			publication.ownership_state, publication.captaincy_state, publication.vice_captaincy_state, publication.transfers_state
		FROM reporting.tournament_selection_stat_publications publication
		WHERE publication.season_id = catalog.season_id
			AND publication.tournament_id = catalog.tournament_id AND publication.is_active
		ORDER BY publication.event_id DESC, publication.revision DESC LIMIT 1
	) latest ON true
	WHERE catalog.season_id = $1 AND catalog.enabled = TRUE
	ORDER BY catalog.sort_order, catalog.tournament_id
`;

export const TRENDS_SNAPSHOT_COHORT_PUBLIC_SQL = `
	SELECT tournament.tournament_id, tournament.setup_status,
		COALESCE(catalog.display_name, tournament.name) AS display_name, publication.event_id AS latest_event_id,
		publication.revision, publication.publication_state, publication.ownership_state,
		publication.captaincy_state, publication.vice_captaincy_state, publication.transfers_state,
		publication.publication_id, publication.expected_entries, publication.captured_at, publication.published_at
	FROM competition.tournaments tournament
	LEFT JOIN competition.public_league_trends catalog
		ON catalog.season_id = tournament.season_id AND catalog.tournament_id = tournament.tournament_id
	LEFT JOIN reporting.tournament_selection_stat_publications publication
		ON publication.season_id = tournament.season_id AND publication.tournament_id = tournament.tournament_id
		AND publication.event_id = $3 AND publication.is_active
	WHERE tournament.season_id = $1 AND tournament.tournament_id = $2 AND tournament.setup_status = 'ready'
		AND catalog.enabled = TRUE
	LIMIT 1
`;

export const TRENDS_SNAPSHOT_COHORT_MINE_SQL = `
	SELECT tournament.tournament_id, tournament.setup_status,
		COALESCE(catalog.display_name, tournament.name) AS display_name, publication.event_id AS latest_event_id,
		publication.revision, publication.publication_state, publication.ownership_state,
		publication.captaincy_state, publication.vice_captaincy_state, publication.transfers_state,
		publication.publication_id, publication.expected_entries, publication.captured_at, publication.published_at
	FROM competition.tournaments tournament
	LEFT JOIN competition.public_league_trends catalog
		ON catalog.season_id = tournament.season_id AND catalog.tournament_id = tournament.tournament_id
	LEFT JOIN reporting.tournament_selection_stat_publications publication
		ON publication.season_id = tournament.season_id AND publication.tournament_id = tournament.tournament_id
		AND publication.event_id = $3 AND publication.is_active
	WHERE tournament.season_id = $1 AND tournament.tournament_id = $2 AND tournament.setup_status = 'ready'
		AND TRUE
		AND EXISTS (
			SELECT 1
			FROM competition.tournament_entries member
			WHERE member.season_id = tournament.season_id
				AND member.tournament_id = tournament.tournament_id
				AND member.entry_id = $4
		)
	LIMIT 1
`;

export const TRENDS_MEMBERSHIP_SQL = `
	SELECT tournament.tournament_id,
		EXISTS (
			SELECT 1
			FROM competition.tournament_entries member
			WHERE member.season_id = tournament.season_id
				AND member.tournament_id = tournament.tournament_id
				AND member.entry_id = $3
		) AS is_member
	FROM competition.tournaments tournament
	WHERE tournament.season_id = $1 AND tournament.tournament_id = $2 AND tournament.setup_status = 'ready'
`;

/**
 * Contract-only lookup used to bind the direct aggregate probe to the
 * fixture's active publication. Production always passes an already
 * authorized publication id to TRENDS_AGGREGATE_UNION_SQL; the probe resolves
 * the same id dynamically so rerunning the fixture never relies on an
 * identity sequence value.
 */
export const TRENDS_CONTRACT_PUBLICATION_ID_SQL = `
	SELECT publication_id
	FROM reporting.tournament_selection_stat_publications
	WHERE season_id = $1
		AND tournament_id = $2
		AND event_id = $3
		AND is_active
	ORDER BY revision DESC
	LIMIT 1
`;

export const TRENDS_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "trends.cohorts-public",
		sql: TRENDS_COHORTS_PUBLIC_SQL,
		values: [2026],
		resultTypes: [
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "captured_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "trends.cohorts-mine",
		sql: TRENDS_COHORTS_MINE_SQL,
		values: [2026, 1],
		resultTypes: [
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "captured_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "trends.snapshot-cohort-public",
		sql: TRENDS_SNAPSHOT_COHORT_PUBLIC_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 1],
		resultTypes: [
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "captured_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "trends.snapshot-cohort-mine",
		sql: TRENDS_SNAPSHOT_COHORT_MINE_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 1, 1],
		resultTypes: [
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "captured_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "trends.membership",
		sql: TRENDS_MEMBERSHIP_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 1],
	},
	{
		name: "trends.aggregate-union",
		sql: TRENDS_AGGREGATE_UNION_SQL,
		// The publication ID is opaque to this consumer: PostgreSQL infers the
		// parameter type from the column while the remaining values still plan
		// every aggregate branch.
		values: [null, 12, 2026, 1, 2],
		runtime: "must-return-trends-personal",
	},
];

const FPL_SQUAD_SIZE = 15;

// Trends snapshots are revisioned by their own publication pointer. They are
// deliberately kept out of the core Data snapshot path, so use an explicit
// cache-key revision rather than forcing a full core snapshot read.
const TRENDS_CACHE_SCHEMA_VERSION = "trends-v3";

const trendsRevisionKey = (revision: string): string =>
	`trends-${createHash("sha256").update(revision, "utf8").digest("hex").slice(0, 24)}`;

const notFound = (message: string): never => {
	throw new GraphQLError(message, { extensions: { code: "NOT_FOUND", http: { status: 404 } } });
};

const forbidden = (message: string, code = "FORBIDDEN"): never => {
	throw new GraphQLError(message, { extensions: { code, http: { status: 403 } } });
};

const requirePrivateTrendsPrincipal = (context: GraphQLContext): void => {
	const result = authorizeViewerEntry(context.principal);
	if (!result.ok) forbidden(result.message, result.code);
};

const viewerEntryId = (context: GraphQLContext): number | null =>
	context.principal ? viewerEntryIdForPrincipal(context.principal) : null;

const validateCohortId = (cohortId: string): number => {
	const match = /^competition:([1-9][0-9]*)$/.exec(cohortId);
	if (!match)
		throw new GraphQLError("cohortId must match competition:<tournamentId>", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	const tournamentId = Number(match[1]);
	if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0)
		throw new GraphQLError("cohortId tournamentId must be a positive safe integer", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	return tournamentId;
};

const status = (value: unknown): string => (typeof value === "string" ? value : "NOT_READY");

type TrendCohort = ReturnType<typeof mapCohort>;

const decodeTrendCohort = (value: unknown): TrendCohort | null => {
	if (!isRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		typeof value.kind !== "string" ||
		typeof value.access !== "string" ||
		typeof value.displayName !== "string" ||
		typeof value.setupStatus !== "string" ||
		typeof value.exact !== "boolean" ||
		(value.latestEventId !== null && !Number.isSafeInteger(value.latestEventId)) ||
		(value.revision !== null && typeof value.revision !== "string") ||
		typeof value.availability !== "string" ||
		!Array.isArray(value.capabilities)
	) {
		return null;
	}
	return value as TrendCohort;
};

const decodeTrendCatalog = (
	value: unknown
): {
	season: string;
	revision: string;
	state: string;
	sourceCheckedAt: string | null;
	cohorts: TrendCohort[];
} | null => {
	if (!isRecord(value) || typeof value.season !== "string" || typeof value.revision !== "string")
		return null;
	if (!Array.isArray(value.cohorts)) return null;
	const cohorts = value.cohorts.map(decodeTrendCohort);
	return cohorts.every((cohort): cohort is TrendCohort => cohort !== null)
		? {
				season: value.season,
				revision: value.revision,
				state: typeof value.state === "string" ? value.state : "NOT_PUBLISHED",
				sourceCheckedAt:
					value.sourceCheckedAt === null || typeof value.sourceCheckedAt === "string"
						? ((value.sourceCheckedAt as string | null | undefined) ?? null)
						: null,
				cohorts,
			}
		: null;
};

async function readPublicCache<T>(
	context: GraphQLContext,
	pointer: string,
	namespace: string,
	decode: (value: unknown) => T | null
): Promise<T | undefined> {
	try {
		const revision = await context.redis.get(
			gqlCacheKey(context, `${namespace}:pointer:${pointer}`, TRENDS_CACHE_SCHEMA_VERSION)
		);
		if (!revision) return undefined;
		const payloadKey = gqlCacheKey(
			context,
			`${namespace}:${pointer}:${revision}`,
			trendsRevisionKey(revision)
		);
		const cached = await context.redis.get(payloadKey);
		if (!cached) return undefined;
		try {
			const value = decode(JSON.parse(cached) as unknown);
			if (value === null) throw new Error("Trends cache codec rejected value");
			return value;
		} catch (error) {
			context.logger.warn({ err: error, key: payloadKey }, "Malformed Trends public cache");
			await context.redis.del(payloadKey).catch(() => undefined);
			return undefined;
		}
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to read Trends public cache");
		return undefined;
	}
}

async function writePublicCache(
	context: GraphQLContext,
	pointer: string,
	revision: string,
	namespace: string,
	value: unknown
): Promise<void> {
	try {
		await context.redis.set(
			gqlCacheKey(context, `${namespace}:${pointer}:${revision}`, trendsRevisionKey(revision)),
			JSON.stringify(value),
			"EX",
			300
		);
		await context.redis.set(
			gqlCacheKey(context, `${namespace}:pointer:${pointer}`, TRENDS_CACHE_SCHEMA_VERSION),
			revision,
			"EX",
			60
		);
	} catch (error) {
		context.logger.warn({ err: error }, "Failed to write Trends public cache");
	}
}

function capabilityStatuses(row: Record<string, unknown> | undefined, access: "PUBLIC" | "MINE") {
	const setupReady = String(row?.setup_status).toLowerCase() === "ready";
	return [
		["OWNERSHIP", setupReady ? status(row?.ownership_state) : "NOT_READY"],
		["EFFECTIVE_OWNERSHIP", setupReady ? status(row?.ownership_state) : "NOT_READY"],
		["CAPTAINCY", setupReady ? status(row?.captaincy_state) : "NOT_READY"],
		["VICE_CAPTAINCY", setupReady ? status(row?.vice_captaincy_state) : "NOT_READY"],
		["TRANSFERS", setupReady ? status(row?.transfers_state) : "NOT_READY"],
		[
			"PERSONAL_EXPOSURE",
			access === "MINE" ? (setupReady ? status(row?.ownership_state) : "NOT_READY") : "UNSUPPORTED",
		],
	].map(([capability, state]) => ({ capability, state }));
}

const mapCohort = (row: Record<string, unknown>, access: "PUBLIC" | "MINE") => {
	const setupStatus =
		typeof row.setup_status === "string" ? row.setup_status.toUpperCase() : "PENDING";
	return {
		id: `competition:${Number(row.tournament_id)}`,
		kind: "TRACKED_OFFICIAL_COMPETITION",
		access,
		displayName: String(row.display_name ?? row.name ?? `Competition ${row.tournament_id}`),
		setupStatus,
		exact: true,
		latestEventId:
			row.latest_event_id === null || row.latest_event_id === undefined
				? null
				: Number(row.latest_event_id),
		revision: row.revision === null || row.revision === undefined ? null : String(row.revision),
		availability:
			setupStatus === "READY" ? status(row.publication_state ?? "NOT_YET_CAPTURED") : "NOT_READY",
		capabilities: capabilityStatuses(row, access),
	};
};

type TrendSnapshotPayload = {
	cohort: TrendCohort;
	eventId: number;
	sections: Record<string, unknown>[];
};

const decodeTrendSnapshot = (value: unknown): TrendSnapshotPayload | null => {
	if (!isRecord(value)) return null;
	const eventId = value.eventId;
	if (typeof eventId !== "number" || !Number.isSafeInteger(eventId) || eventId < 1) return null;
	if (!Array.isArray(value.sections) || !value.sections.every(isRecord)) return null;
	const cohort = decodeTrendCohort(value.cohort);
	return cohort ? { cohort, eventId, sections: value.sections } : null;
};

export const trendsRepository = {
	async listCohorts(context: GraphQLContext, access: "PUBLIC" | "MINE") {
		if (access === "MINE") {
			requirePrivateTrendsPrincipal(context);
		}
		if (access === "PUBLIC") {
			const cached = await readPublicCache<{
				season: string;
				revision: string;
				state: string;
				sourceCheckedAt: string | null;
				cohorts: ReturnType<typeof mapCohort>[];
			}>(context, context.currentSeason.seasonCode, "trends:catalog:public", decodeTrendCatalog);
			if (cached) return cached;
		}
		const params: unknown[] = [context.currentSeason.seasonId];
		if (access === "MINE") {
			params.push(viewerEntryId(context)!);
		}
		const sql = access === "MINE" ? TRENDS_COHORTS_MINE_SQL : TRENDS_COHORTS_PUBLIC_SQL;
		const result = await context.database.query<Record<string, unknown>>(sql, params);
		const hasPublishedRows = result.rows.some(
			(row) => row.revision !== null && row.revision !== undefined
		);
		const sourceCheckedAtValue = result.rows
			.map((row) => row.source_checked_at)
			.filter((value): value is string | Date => value !== null && value !== undefined)
			.sort((left, right) => Date.parse(String(right)) - Date.parse(String(left)))[0];
		const sourceCheckedAt = sourceCheckedAtValue
			? new Date(sourceCheckedAtValue).toISOString()
			: null;
		const payload = {
			season: context.currentSeason.seasonCode,
			revision:
				result.rows.map((row) => `${row.tournament_id}:${row.revision ?? "none"}`).join("|") ||
				`not-published:${context.currentSeason.seasonCode}`,
			state: hasPublishedRows ? "PUBLISHED" : "NOT_PUBLISHED",
			sourceCheckedAt,
			cohorts: result.rows.map((row) => mapCohort(row, access)),
		};
		if (access === "PUBLIC")
			await writePublicCache(
				context,
				context.currentSeason.seasonCode,
				payload.revision || "empty",
				"trends:catalog:public",
				payload
			);
		return payload;
	},

	async snapshot(
		context: GraphQLContext,
		cohortId: string,
		eventId: number,
		limit: number,
		access: "PUBLIC" | "MINE"
	): Promise<TrendSnapshotPayload> {
		const tournamentId = validateCohortId(cohortId);
		if (!Number.isInteger(eventId) || eventId < 1 || eventId > 38)
			throw new GraphQLError("eventId must be between 1 and 38", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		if (!Number.isInteger(limit) || limit < 1 || limit > 12)
			throw new GraphQLError("limit must be between 1 and 12", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		const params: unknown[] = [context.currentSeason.seasonId, tournamentId, eventId];
		if (access === "PUBLIC") {
			const cached = await readPublicCache<TrendSnapshotPayload>(
				context,
				`${tournamentId}:${eventId}:${limit}`,
				"trends:snapshot:public",
				decodeTrendSnapshot
			);
			if (cached) return cached;
		}
		if (access === "MINE") {
			requirePrivateTrendsPrincipal(context);
			params.push(viewerEntryId(context)!);
		}
		const cohortResult = await context.database.query<Record<string, unknown>>(
			access === "MINE" ? TRENDS_SNAPSHOT_COHORT_MINE_SQL : TRENDS_SNAPSHOT_COHORT_PUBLIC_SQL,
			params
		);
		const cohortRow = cohortResult.rows[0];
		if (!cohortRow) {
			if (access === "MINE") {
				const entryId = viewerEntryId(context);
				const membership = await context.database.query<{
					tournament_id: number;
					is_member: boolean;
				}>(TRENDS_MEMBERSHIP_SQL, [context.currentSeason.seasonId, tournamentId, entryId]);
				if (membership.rows[0] && !membership.rows[0].is_member)
					forbidden("User is not a member of this Trends cohort");
			}
			notFound("Trends cohort not found");
		}
		const cohort = mapCohort(cohortRow, access);
		const aggregateRowsByCapability = new Map<TrendCapability, Record<string, unknown>[]>();
		const viewerEntry = access === "MINE" ? viewerEntryId(context) : null;
		const aggregateReady = aggregateTrendCapabilities.some(
			(capability) =>
				status(
					cohortRow[
						capability === "OWNERSHIP" || capability === "EFFECTIVE_OWNERSHIP"
							? "ownership_state"
							: capability === "CAPTAINCY"
								? "captaincy_state"
								: capability === "VICE_CAPTAINCY"
									? "vice_captaincy_state"
									: "transfers_state"
					]
				) === "READY"
		);
		// Aggregate and personal exposure rows share one bounded SQL round trip.
		if ((cohortRow.publication_id && aggregateReady) || viewerEntry !== null) {
			const aggregateResult = await context.database.query<Record<string, unknown>>(
				TRENDS_AGGREGATE_UNION_SQL,
				[cohortRow.publication_id, limit, context.currentSeason.seasonId, viewerEntry, eventId]
			);
			for (const row of aggregateResult.rows) {
				const capability = row.capability;
				if (
					typeof capability === "string" &&
					(aggregateTrendCapabilities.includes(capability as AggregateTrendCapability) ||
						capability === "PERSONAL_EXPOSURE")
				) {
					const typedCapability = capability as TrendCapability;
					const current = aggregateRowsByCapability.get(typedCapability) ?? [];
					current.push(row);
					aggregateRowsByCapability.set(typedCapability, current);
					continue;
				}
				// Older test doubles may omit the label; scope such rows to the
				// first aggregate capability rather than fabricating every section.
				const current = aggregateRowsByCapability.get("OWNERSHIP") ?? [];
				current.push(row);
				aggregateRowsByCapability.set("OWNERSHIP", current);
			}
		}
		const sections = await Promise.all(
			capabilities.map(async (capability): Promise<Record<string, unknown>> => {
				const state =
					capability === "PERSONAL_EXPOSURE"
						? access === "MINE"
							? status(cohortRow.ownership_state)
							: "UNSUPPORTED"
						: status(
								cohortRow[
									capability === "OWNERSHIP" || capability === "EFFECTIVE_OWNERSHIP"
										? "ownership_state"
										: capability === "CAPTAINCY"
											? "captaincy_state"
											: capability === "VICE_CAPTAINCY"
												? "vice_captaincy_state"
												: "transfers_state"
								]
							);
				const evidenceContext = {
					evidenceClass: "official_competition",
					sourceKey: `competition:${tournamentId}`,
					sourceLabel: String(cohortRow.display_name),
					seasonScope: "single_season",
					season: context.currentSeason.seasonCode,
					eventId,
					scopeKind: "TRACKED_OFFICIAL_COMPETITION",
					scopeKey: `competition:${tournamentId}`,
					scopeLabel: String(cohortRow.display_name),
					observedAt: cohortRow.captured_at,
					capturedAt: cohortRow.captured_at,
					publishedAt: cohortRow.published_at,
					truthState: state === "READY" ? "observed" : "unknown",
					coverageState: state === "READY" ? "complete" : "partial",
					availabilityState: state,
					exact: true,
					targetPopulation:
						cohortRow.expected_entries === null || cohortRow.expected_entries === undefined
							? null
							: Number(cohortRow.expected_entries),
					denominator:
						cohortRow.expected_entries === null || cohortRow.expected_entries === undefined
							? null
							: Number(cohortRow.expected_entries),
					sampleSize:
						cohortRow.expected_entries === null || cohortRow.expected_entries === undefined
							? null
							: Number(cohortRow.expected_entries),
					methodKey: "exact_prepared_competition",
					methodVersion: "1",
					limitations:
						state === "READY"
							? []
							: ["This capability has not been completely captured for the requested event."],
				};
				if (state !== "READY" || (capability !== "PERSONAL_EXPOSURE" && !cohortRow.publication_id))
					return { capability, state, evidenceContext, rows: null };
				if (capability === "PERSONAL_EXPOSURE") {
					if (viewerEntry === null)
						return { capability, state: "NOT_READY", evidenceContext, rows: null };
					const personalSourceRows = aggregateRowsByCapability.get("PERSONAL_EXPOSURE") ?? [];
					const personalRows = personalSourceRows.map((row) => ({
						elementId: Number(row.element_id),
						playerName: String(row.player_name),
						playerPosition: Number(row.player_position),
						teamShortName: String(row.team_short_name),
						count: Number(row.count),
						percentage: null,
					}));
					const elementIds = new Set(personalRows.map((row) => row.elementId));
					const pickPositionValues = personalSourceRows.map((row) => Number(row.pick_position));
					const pickPositions = new Set(pickPositionValues);
					const validPersonalRows = personalRows.every(
						(row) => Number.isSafeInteger(row.elementId) && row.elementId > 0
					);
					const validPickPositions = pickPositionValues.every(
						(position) => Number.isSafeInteger(position) && position > 0
					);
					const complete =
						personalRows.length === FPL_SQUAD_SIZE &&
						validPersonalRows &&
						validPickPositions &&
						elementIds.size === personalRows.length &&
						pickPositions.size === personalRows.length;
					const personalState = complete ? state : "PARTIAL";
					const personalEvidenceContext = complete
						? evidenceContext
						: {
								...evidenceContext,
								truthState: "partial",
								coverageState: "partial",
								availabilityState: personalState,
								limitations: [
									...evidenceContext.limitations,
									`Personal exposure returned ${personalRows.length} of ${FPL_SQUAD_SIZE} squad picks or contained duplicate rows.`,
								],
							};
					return {
						capability,
						state: personalState,
						evidenceContext: personalEvidenceContext,
						rows: personalRows,
					};
				}
				const denominator = Number(cohortRow.expected_entries ?? 0);
				const aggregateCapability = capability as AggregateTrendCapability;
				return {
					capability,
					state,
					evidenceContext,
					rows: (aggregateRowsByCapability.get(aggregateCapability) ?? []).map((row) => ({
						elementId: Number(row.element_id),
						playerName: String(row.player_name),
						playerPosition: Number(row.player_position),
						teamShortName: String(row.team_short_name),
						count: Number(row.count),
						percentage: denominator > 0 ? (Number(row.count) / denominator) * 100 : null,
					})),
				};
			})
		);
		const payload = { cohort, eventId, sections };
		if (access === "PUBLIC")
			await writePublicCache(
				context,
				`${tournamentId}:${eventId}:${limit}`,
				cohort.revision ?? "empty",
				"trends:snapshot:public",
				payload
			);
		return payload;
	},
};
