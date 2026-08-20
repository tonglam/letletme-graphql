import type { GraphQLContext } from "../../graphql/context";
import {
	readDataPublicationItemsObserved,
	type DataPublication,
} from "../../infra/data-publication";
import { metrics } from "../../infra/metrics";

export type MarketSnapshotSource = "DATA_PUBLICATION" | "POSTGRES_FALLBACK";

/** Request-scoped immutable market pin shared by all market consumers. */
export type MarketSnapshotContext = Readonly<{
	season: string;
	revision: string;
	source: MarketSnapshotSource;
	snapshotDate: string;
	capturedAt: string;
	rowCount: number;
	cacheTtlSeconds: number;
}>;

/** Preferred name for consumers that treat the request pin as a read context. */
export type MarketReadContext = MarketSnapshotContext;

type MarketContextPayload = {
	seasonCode?: unknown;
	snapshotDate?: unknown;
	capturedAt?: unknown;
	rowCount?: unknown;
};

const marketContextMemo = new WeakMap<object, Promise<MarketSnapshotContext | null>>();

const isDate = (value: unknown): value is string =>
	typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const isIso = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const integer = (value: unknown): number | null => {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const asDate = (value: unknown): string | null => {
	if (value instanceof Date)
		return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
	if (typeof value === "string")
		return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
	return null;
};

const asTimestamp = (value: unknown): string | null => {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (typeof value === "string") {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
	}
	return null;
};

const countMarketEvent = (
	event: "publication_match" | "postgres_fallback" | "pin_retry" | "pin_failed"
): void => {
	metrics.cacheRepositoryEvents.labels("market_context", event).inc();
};

type PostgresMarketMetadata = {
	snapshotDate: string;
	capturedAt: string;
	rowCount: number;
	captureCount: number;
};

const loadPostgresMetadata = async (
	context: GraphQLContext
): Promise<PostgresMarketMetadata | null> => {
	const result = await context.database.query<{
		snapshot_date: string | Date | null;
		captured_at: string | Date | null;
		row_count: number | string | null;
		capture_count: number | string | null;
	}>(
		`WITH latest_date AS (
			SELECT MAX(snapshot_date) AS snapshot_date
			FROM fpl.player_market_snapshots
			WHERE season_id = $1
		), latest_batch AS (
			SELECT snapshot.snapshot_date::text AS snapshot_date,
				MAX(captured_at) AS captured_at,
				COUNT(*)::integer AS row_count,
				COUNT(DISTINCT captured_at)::integer AS capture_count
			FROM fpl.player_market_snapshots snapshot
			JOIN latest_date ON latest_date.snapshot_date = snapshot.snapshot_date
			WHERE snapshot.season_id = $1
			GROUP BY snapshot.snapshot_date
		)
		SELECT snapshot_date, captured_at, row_count, capture_count
		FROM latest_batch
		LIMIT 1`,
		[context.currentSeason.seasonId]
	);
	const row = result.rows[0];
	const snapshotDate = asDate(row?.snapshot_date);
	const capturedAt = asTimestamp(row?.captured_at);
	const rowCount = integer(row?.row_count);
	const captureCount = integer(row?.capture_count);
	if (!snapshotDate || !capturedAt || rowCount === null || rowCount === 0 || captureCount !== 1) {
		return null;
	}
	return { snapshotDate, capturedAt, rowCount, captureCount };
};

const loadPostgresMetadataSafely = async (
	context: GraphQLContext
): Promise<PostgresMarketMetadata | null> => {
	try {
		return await loadPostgresMetadata(context);
	} catch (error) {
		context.logger.warn({ err: error }, "Market PostgreSQL metadata read failed");
		return null;
	}
};

const loadMarketPublicationSafely = async (
	context: GraphQLContext
): Promise<DataPublication | null> => {
	try {
		const read = await readDataPublicationItemsObserved(
			context.redis,
			{ dataset: "fpl:market", seasonCode: context.currentSeason.seasonCode },
			["context"]
		);
		return read.publication;
	} catch (error) {
		context.logger.warn({ err: error }, "Market Data publication read failed");
		return null;
	}
};

const fromPublication = (
	context: GraphQLContext,
	publication: DataPublication | null,
	postgresMetadata: PostgresMarketMetadata | null
): MarketSnapshotContext | null => {
	if (!publication || !postgresMetadata) return null;
	const payload = publication.items.context;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const value = payload as MarketContextPayload;
	const rowCount = integer(value.rowCount);
	const capturedAt = isIso(value.capturedAt) ? new Date(value.capturedAt).toISOString() : null;
	if (
		value.seasonCode !== context.currentSeason.seasonCode ||
		!isDate(value.snapshotDate) ||
		!capturedAt ||
		rowCount === null ||
		rowCount === 0 ||
		value.snapshotDate !== postgresMetadata.snapshotDate ||
		capturedAt !== postgresMetadata.capturedAt ||
		rowCount !== postgresMetadata.rowCount ||
		postgresMetadata.captureCount !== 1
	) {
		return null;
	}
	countMarketEvent("publication_match");
	return Object.freeze({
		season: context.currentSeason.seasonCode,
		revision: `market-${publication.manifest.revision}`,
		source: "DATA_PUBLICATION",
		snapshotDate: value.snapshotDate,
		capturedAt,
		rowCount,
		cacheTtlSeconds: 24 * 60 * 60,
	});
};

const loadMarketSnapshotContext = async (
	context: GraphQLContext
): Promise<MarketSnapshotContext | null> => {
	const [publication, postgresMetadata] = await Promise.all([
		loadMarketPublicationSafely(context),
		loadPostgresMetadataSafely(context),
	]);

	const published = fromPublication(context, publication, postgresMetadata);
	if (published) return published;
	if (!postgresMetadata) return null;
	const revisionEpoch = Date.parse(postgresMetadata.capturedAt);
	if (!Number.isSafeInteger(revisionEpoch) || revisionEpoch <= 0) return null;
	countMarketEvent("postgres_fallback");
	return Object.freeze({
		season: context.currentSeason.seasonCode,
		revision: `pg-${revisionEpoch}`,
		source: "POSTGRES_FALLBACK",
		snapshotDate: postgresMetadata.snapshotDate,
		capturedAt: postgresMetadata.capturedAt,
		rowCount: postgresMetadata.rowCount,
		cacheTtlSeconds: 5 * 60,
	});
};

export const getMarketSnapshotContext = (
	context: GraphQLContext
): Promise<MarketSnapshotContext | null> => {
	const requestScope = context.requestScope ?? context;
	const existing = marketContextMemo.get(requestScope);
	if (existing) return existing;
	const load = loadMarketSnapshotContext(context);
	marketContextMemo.set(requestScope, load);
	void load.catch(() => {
		if (marketContextMemo.get(requestScope) === load) marketContextMemo.delete(requestScope);
	});
	return load;
};

/** Clear the request pin after detecting a same-day overwrite, then read once more. */
export const refreshMarketSnapshotContext = async (
	context: GraphQLContext
): Promise<MarketSnapshotContext | null> => {
	const requestScope = context.requestScope ?? context;
	marketContextMemo.delete(requestScope);
	countMarketEvent("pin_retry");
	const refreshed = await getMarketSnapshotContext(context);
	if (!refreshed) countMarketEvent("pin_failed");
	return refreshed;
};
