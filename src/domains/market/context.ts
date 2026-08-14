import type { GraphQLContext } from "../../graphql/context";
import {
	readDataPublicationItemsObserved,
	type DataPublication,
} from "../../infra/data-publication";

export type MarketSnapshotSource = "DATA_PUBLICATION" | "POSTGRES_FALLBACK";

export type MarketSnapshotContext = {
	season: string;
	revision: string;
	source: MarketSnapshotSource;
	snapshotDate: string | null;
	capturedAt: string | null;
	rowCount: number;
};

type MarketContextPayload = {
	seasonCode?: unknown;
	snapshotDate?: unknown;
	capturedAt?: unknown;
	latestMutationAt?: unknown;
	rowCount?: unknown;
	expectedRowCount?: unknown;
	sourceEventId?: unknown;
};

type MarketContextMemoEntry = {
	withFallback?: Promise<MarketSnapshotContext | null>;
	withoutFallback?: Promise<MarketSnapshotContext | null>;
};

const marketContextMemo = new WeakMap<object, MarketContextMemoEntry>();

const isDate = (value: unknown): value is string =>
	typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const isIso = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const integer = (value: unknown): number | null => {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const fromPublication = (
	context: GraphQLContext,
	publication: DataPublication | null
): MarketSnapshotContext | null => {
	if (!publication) return null;
	const payload = publication.items.context;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const value = payload as MarketContextPayload;
	const rowCount = integer(value.rowCount);
	if (
		value.seasonCode !== context.currentSeason.seasonCode ||
		!isDate(value.snapshotDate) ||
		!isIso(value.capturedAt) ||
		rowCount === null ||
		rowCount === 0
	) {
		return null;
	}
	const revision = `market-${publication.manifest.revision}`;
	context.marketRevision = revision;
	context.marketSnapshotSource = "DATA_PUBLICATION";
	return {
		season: context.currentSeason.seasonCode,
		revision,
		source: "DATA_PUBLICATION",
		snapshotDate: value.snapshotDate,
		capturedAt: value.capturedAt,
		rowCount,
	};
};

export const getMarketSnapshotContext = (
	context: GraphQLContext,
	options: { allowPostgresFallback?: boolean } = {}
): Promise<MarketSnapshotContext | null> => {
	const allowPostgresFallback = options.allowPostgresFallback !== false;
	const requestScope = context.requestScope ?? context;
	const memo = marketContextMemo.get(requestScope) ?? {};
	const existing = allowPostgresFallback ? memo.withFallback : memo.withoutFallback;
	if (existing) return existing;

	const load = (async (): Promise<MarketSnapshotContext | null> => {
		const scope = { dataset: "fpl:market" as const, seasonCode: context.currentSeason.seasonCode };
		try {
			const read = await readDataPublicationItemsObserved(context.redis, scope, ["context"]);
			const published = fromPublication(context, read.publication);
			if (published) return published;
		} catch (error) {
			context.logger.warn({ err: error }, "Market Data publication read failed");
		}
		if (options.allowPostgresFallback === false) return null;

		const result = await context.database.query<{
			snapshot_date: string | Date | null;
			captured_at: string | Date | null;
			row_count: number | string | null;
		}>(
			`SELECT snapshot_date::text AS snapshot_date,
					MAX(captured_at) AS captured_at,
					COUNT(*)::integer AS row_count
				 FROM fpl.player_market_snapshots
				 WHERE season_id = $1
				 GROUP BY snapshot_date
				 ORDER BY snapshot_date DESC
				 LIMIT 1`,
			[context.currentSeason.seasonId]
		);
		const row = result.rows[0];
		const snapshotDate =
			row?.snapshot_date instanceof Date
				? row.snapshot_date.toISOString().slice(0, 10)
				: typeof row?.snapshot_date === "string"
					? row.snapshot_date.slice(0, 10)
					: null;
		const capturedAt = row?.captured_at ? new Date(row.captured_at).toISOString() : null;
		const rowCount = integer(row?.row_count) ?? 0;
		const revisionSeed = `${snapshotDate ?? "empty"}-${capturedAt ?? "empty"}-${rowCount}`;
		const revision = `pg-${Buffer.from(revisionSeed).toString("base64url")}`;
		context.marketRevision = revision;
		context.marketSnapshotSource = "POSTGRES_FALLBACK";
		return {
			season: context.currentSeason.seasonCode,
			revision,
			source: "POSTGRES_FALLBACK",
			snapshotDate,
			capturedAt,
			rowCount,
		};
	})();
	if (allowPostgresFallback) memo.withFallback = load;
	else memo.withoutFallback = load;
	marketContextMemo.set(requestScope, memo);
	return load;
};
