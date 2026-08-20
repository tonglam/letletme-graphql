import { describe, expect, it } from "bun:test";
import {
	createMarketPinFailure,
	getMarketSnapshotContext,
	refreshMarketSnapshotContext,
} from "../../../src/domains/market/context";
import { metrics } from "../../../src/infra/metrics";
import {
	buildSnapshotContext,
	createTestPublication,
	TestRedis,
} from "../../helpers/data-publication";

const capturedAt = "2026-08-20T01:02:03.000Z";
const pgMetadata = (overrides: Record<string, unknown> = {}) => ({
	rows: [
		{
			snapshot_date: "2026-08-20",
			captured_at: capturedAt,
			row_count: 2,
			capture_count: 1,
			...overrides,
		},
	],
});

const contextFor = (redis: TestRedis, row = pgMetadata()) =>
	buildSnapshotContext(redis, { databaseQuery: async () => row });

const marketCounter = async (event: string): Promise<number> => {
	const metric = await metrics.cacheRepositoryEvents.get();
	const sample = metric.values.find(
		(value) => value.labels.domain === "market_context" && value.labels.event === event
	);
	return sample?.value ?? 0;
};

describe("market snapshot context", () => {
	it("qualifies the snapshot date in the joined PostgreSQL metadata query", async () => {
		let query = "";
		const context = contextFor(new TestRedis());
		context.database.query = (async (sql: string) => {
			query = sql;
			return pgMetadata();
		}) as unknown as typeof context.database.query;

		await getMarketSnapshotContext(context);

		expect(query).toContain("SELECT snapshot.snapshot_date::text AS snapshot_date");
	});

	it("uses DATA_PUBLICATION only when Redis and PostgreSQL metadata match", async () => {
		const redis = new TestRedis(
			createTestPublication({ dataset: "fpl:market", seasonCode: "2627" }, 17, {
				context: {
					seasonCode: "2627",
					snapshotDate: "2026-08-20",
					capturedAt,
					rowCount: 2,
				},
			})
		);
		const result = await getMarketSnapshotContext(contextFor(redis));
		expect(result).toMatchObject({
			source: "DATA_PUBLICATION",
			revision: "market-17",
			cacheTtlSeconds: 86_400,
			snapshotDate: "2026-08-20",
			capturedAt,
		});
	});

	it("falls back to a numeric PostgreSQL capture revision on mismatch", async () => {
		const redis = new TestRedis(
			createTestPublication({ dataset: "fpl:market", seasonCode: "2627" }, 18, {
				context: {
					seasonCode: "2627",
					snapshotDate: "2026-08-19",
					capturedAt,
					rowCount: 999,
				},
			})
		);
		const result = await getMarketSnapshotContext(contextFor(redis));
		expect(result).toMatchObject({
			source: "POSTGRES_FALLBACK",
			revision: `pg-${Date.parse(capturedAt)}`,
		});
		expect(result?.cacheTtlSeconds).toBe(300);
	});

	it("falls back when Redis is unavailable and refuses incoherent PG batches", async () => {
		const redis = new TestRedis();
		redis.get = async () => {
			throw new Error("redis down");
		};
		const result = await getMarketSnapshotContext(contextFor(redis));
		expect(result?.source).toBe("POSTGRES_FALLBACK");

		const incoherent = await getMarketSnapshotContext(
			contextFor(new TestRedis(), pgMetadata({ capture_count: 2 }))
		);
		expect(incoherent).toBeNull();
	});

	it("shares one immutable pin when market resolvers start in parallel", async () => {
		let metadataReads = 0;
		const redis = new TestRedis();
		const context = contextFor(redis);
		context.database.query = (async () => {
			metadataReads += 1;
			await Promise.resolve();
			return pgMetadata();
		}) as unknown as typeof context.database.query;
		const [first, second] = await Promise.all([
			getMarketSnapshotContext(context),
			getMarketSnapshotContext(context),
		]);
		expect(first).toEqual(second);
		expect(metadataReads).toBe(1);
	});

	it("refreshes a request pin once when the selected batch changes", async () => {
		let metadataReads = 0;
		const redis = new TestRedis();
		const context = contextFor(redis);
		context.database.query = (async () => {
			metadataReads += 1;
			return pgMetadata({
				captured_at: metadataReads === 1 ? capturedAt : "2026-08-20T02:02:03.000Z",
			});
		}) as unknown as typeof context.database.query;

		const first = await getMarketSnapshotContext(context);
		const refreshed = await refreshMarketSnapshotContext(context);
		expect(first?.revision).toBe("pg-" + Date.parse(capturedAt));
		expect(refreshed?.revision).toBe("pg-" + Date.parse("2026-08-20T02:02:03.000Z"));
		expect(metadataReads).toBe(2);
	});

	it("counts retry success without recording pin_failed", async () => {
		let metadataReads = 0;
		const context = contextFor(new TestRedis());
		context.database.query = (async () => {
			metadataReads += 1;
			return pgMetadata({
				captured_at: metadataReads === 1 ? capturedAt : "2026-08-20T02:02:03.000Z",
			});
		}) as unknown as typeof context.database.query;

		const beforeRetry = await marketCounter("pin_retry");
		const beforeFailure = await marketCounter("pin_failed");
		await getMarketSnapshotContext(context);
		await refreshMarketSnapshotContext(context);

		expect((await marketCounter("pin_retry")) - beforeRetry).toBe(1);
		expect((await marketCounter("pin_failed")) - beforeFailure).toBe(0);
	});

	it("counts each terminal retry failure, including a refresh-null path", async () => {
		const context = contextFor(new TestRedis(), pgMetadata({ capture_count: 2 }));
		const beforeFailure = await marketCounter("pin_failed");
		const error = createMarketPinFailure(context, "Market snapshot pin unavailable after retry");

		expect(error.message).toBe("Market snapshot pin unavailable after retry");
		expect((await marketCounter("pin_failed")) - beforeFailure).toBe(1);
	});

	it("counts a second-query mismatch as the terminal pin failure", async () => {
		const context = contextFor(new TestRedis());
		const beforeFailure = await marketCounter("pin_failed");
		const error = createMarketPinFailure(context, "Market snapshot pin changed during query");

		expect(error.message).toBe("Market snapshot pin changed during query");
		expect((await marketCounter("pin_failed")) - beforeFailure).toBe(1);
	});
});
