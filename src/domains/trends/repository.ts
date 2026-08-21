import { GraphQLError } from "graphql";
import { createHash } from "crypto";
import type { GraphQLContext } from "../../graphql/context";
import { authorizeProtectedBinding } from "../../graphql/authorization";
import { gqlCacheKey } from "../../infra/cache-key";

const capabilities = [
	"OWNERSHIP",
	"EFFECTIVE_OWNERSHIP",
	"CAPTAINCY",
	"VICE_CAPTAINCY",
	"TRANSFERS",
	"PERSONAL_EXPOSURE",
] as const;

// Trends snapshots are revisioned by their own publication pointer. They are
// deliberately kept out of the core Data snapshot path, so use an explicit
// cache-key revision rather than forcing a full core snapshot read.
const TRENDS_CACHE_SCHEMA_VERSION = "trends-v2";

const trendsRevisionKey = (revision: string): string =>
	`trends-${createHash("sha256").update(revision, "utf8").digest("hex").slice(0, 24)}`;

const notFound = (message: string): never => {
	throw new GraphQLError(message, { extensions: { code: "NOT_FOUND", http: { status: 404 } } });
};

const forbidden = (message: string): never => {
	throw new GraphQLError(message, { extensions: { code: "FORBIDDEN", http: { status: 403 } } });
};

const requirePrivateTrendsPrincipal = (context: GraphQLContext): void => {
	const result = authorizeProtectedBinding(context.principal);
	if (!result.ok) forbidden(result.message);
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type TrendCohort = ReturnType<typeof mapCohort>;

const decodeTrendCohort = (value: unknown): TrendCohort | null => {
	if (!isRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		typeof value.kind !== "string" ||
		typeof value.access !== "string" ||
		typeof value.displayName !== "string" ||
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
	return [
		["OWNERSHIP", status(row?.ownership_state)],
		["EFFECTIVE_OWNERSHIP", status(row?.ownership_state)],
		["CAPTAINCY", status(row?.captaincy_state)],
		["VICE_CAPTAINCY", status(row?.vice_captaincy_state)],
		["TRANSFERS", status(row?.transfers_state)],
		["PERSONAL_EXPOSURE", access === "MINE" ? status(row?.ownership_state) : "UNSUPPORTED"],
	].map(([capability, state]) => ({ capability, state }));
}

const mapCohort = (row: Record<string, unknown>, access: "PUBLIC" | "MINE") => ({
	id: `competition:${Number(row.tournament_id)}`,
	kind: "TRACKED_OFFICIAL_COMPETITION",
	access,
	displayName: String(row.display_name ?? row.name ?? `Competition ${row.tournament_id}`),
	exact: true,
	latestEventId:
		row.latest_event_id === null || row.latest_event_id === undefined
			? null
			: Number(row.latest_event_id),
	revision: row.revision === null || row.revision === undefined ? null : String(row.revision),
	availability: status(row.publication_state ?? "NOT_YET_CAPTURED"),
	capabilities: capabilityStatuses(row, access),
});

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
		let sql =
			access === "MINE"
				? `
      SELECT tournament.tournament_id, COALESCE(catalog.display_name, tournament.name) AS display_name,
					latest.event_id AS latest_event_id, latest.revision, latest.publication_state,
					latest.captured_at AS source_checked_at,
        latest.ownership_state, latest.captaincy_state, latest.vice_captaincy_state, latest.transfers_state
      FROM competition.tournaments tournament
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
      WHERE tournament.season_id = $1 AND tournament.setup_status = 'ready'`
				: `
      SELECT catalog.tournament_id, catalog.display_name,
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
      WHERE catalog.season_id = $1 AND catalog.enabled = TRUE`;
		if (access === "MINE") {
			params.push(context.principal!.fplEntryId);
			sql += ` AND EXISTS (SELECT 1 FROM competition.tournament_entries member WHERE member.season_id = tournament.season_id AND member.tournament_id = tournament.tournament_id AND member.entry_id = $2)`;
		}
		sql +=
			access === "MINE"
				? " ORDER BY COALESCE(catalog.sort_order, 0), tournament.tournament_id"
				: " ORDER BY catalog.sort_order, catalog.tournament_id";
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
			params.push(context.principal!.fplEntryId!);
		}
		const cohortResult = await context.database.query<Record<string, unknown>>(
			`
      SELECT tournament.tournament_id, COALESCE(catalog.display_name, tournament.name) AS display_name, publication.event_id AS latest_event_id,
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
        AND ${access === "PUBLIC" ? "catalog.enabled = TRUE" : "TRUE"}
        ${access === "MINE" ? "AND EXISTS (SELECT 1 FROM competition.tournament_entries member WHERE member.season_id = tournament.season_id AND member.tournament_id = tournament.tournament_id AND member.entry_id = $4)" : ""}
      LIMIT 1`,
			params
		);
		const cohortRow = cohortResult.rows[0];
		if (!cohortRow) {
			if (access === "MINE") {
				const entryId = context.principal?.fplEntryId;
				const membership = await context.database.query<{
					tournament_id: number;
					is_member: boolean;
				}>(
					`SELECT tournament.tournament_id,
            EXISTS (SELECT 1 FROM competition.tournament_entries member WHERE member.season_id = tournament.season_id AND member.tournament_id = tournament.tournament_id AND member.entry_id = $3) AS is_member
           FROM competition.tournaments tournament
           WHERE tournament.season_id = $1 AND tournament.tournament_id = $2 AND tournament.setup_status = 'ready'`,
					[context.currentSeason.seasonId, tournamentId, entryId]
				);
				if (membership.rows[0] && !membership.rows[0].is_member)
					forbidden("User is not a member of this Trends cohort");
			}
			notFound("Trends cohort not found");
		}
		const cohort = mapCohort(cohortRow, access);
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
					const entryId = context.principal?.fplEntryId;
					if (!entryId) return { capability, state: "NOT_READY", evidenceContext, rows: null };
					const personal = await context.database.query<Record<string, unknown>>(
						`
          SELECT pick.element_id, COALESCE(NULLIF(concat_ws(' ', player.first_name, player.second_name), ''), player.web_name) AS player_name,
            player.element_type AS player_position, team.short_name AS team_short_name, pick.multiplier::int AS count
          FROM competition.entry_event_picks pick
          JOIN fpl.players player ON player.season_id = pick.season_id AND player.element_id = pick.element_id
          JOIN fpl.teams team ON team.season_id = player.season_id AND team.team_id = player.team_id
          WHERE pick.season_id = $1 AND pick.entry_id = $2 AND pick.event_id = $3
          ORDER BY pick.multiplier DESC, pick.position`,
						[context.currentSeason.seasonId, entryId, eventId]
					);
					return {
						capability,
						state,
						evidenceContext,
						rows: personal.rows
							.map((row) => ({
								elementId: Number(row.element_id),
								playerName: String(row.player_name),
								playerPosition: Number(row.player_position),
								teamShortName: String(row.team_short_name),
								count: Number(row.count),
								percentage: null,
							}))
							.slice(0, limit),
					};
				}
				const orderColumn =
					capability === "OWNERSHIP"
						? "selected_count"
						: capability === "EFFECTIVE_OWNERSHIP"
							? "effective_selection_count"
							: capability === "CAPTAINCY"
								? "captain_count"
								: capability === "VICE_CAPTAINCY"
									? "vice_captain_count"
									: capability === "TRANSFERS"
										? "transfer_in_count"
										: "selected_count";
				const result = await context.database.query<Record<string, unknown>>(
					`
        SELECT element_id, player_name, player_position, team_short_name,
          ${orderColumn} AS count
        FROM reporting.tournament_selection_stat_rows
        WHERE publication_id = $1
        ORDER BY ${orderColumn} DESC NULLS LAST, element_id
        LIMIT $2`,
					[cohortRow.publication_id, limit]
				);
				const denominator = Number(cohortRow.expected_entries ?? 0);
				return {
					capability,
					state,
					evidenceContext,
					rows: result.rows.map((row) => ({
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
