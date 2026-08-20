import { describe, expect, test } from "bun:test";
import type Redis from "ioredis";
import { createHash } from "node:crypto";

import fixture from "../../fixtures/briefing/week-publication-v1.json";
import type { QueryExecutor } from "../../../src/infra/database";
import { getBriefingReaderMetrics, readBriefingWeek } from "../../../src/infra/content-publication";
import { metrics } from "../../../src/infra/metrics";
import { withFrozenBriefingClock } from "./frozen-clock";

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
	);
};

const canonical = JSON.stringify(canonicalize(fixture));
const hash = createHash("sha256").update(canonical, "utf8").digest("hex");

const metadata = {
	publication_id: fixture.publicationId,
	scope_key: "week",
	revision: "1",
	schema_version: 1,
	season_code: "2627",
	target_event_id: 1,
	event_name: "Gameweek 1",
	deadline_time: fixture.event.deadlineTime,
	state: "READY" as const,
	servable: true,
	source_checked_at: fixture.sourceCheckedAt,
	published_at: fixture.publishedAt,
	valid_until: fixture.validUntil,
	locale_manifest: {
		en: { bytes: Buffer.byteLength(canonical), sha256: hash },
		"zh-CN": { bytes: Buffer.byteLength(canonical), sha256: hash },
	},
};

const redisWithoutPayload = {
	get: async () => null,
} as unknown as Redis;

function databaseWithFallback(): QueryExecutor {
	return {
		async query(text: string) {
			if (text.includes("content.briefing_active_publication"))
				return { rows: [metadata] } as never;
			return {
				rows: [
					{ payload: fixture, payload_bytes: Buffer.byteLength(canonical), payload_sha256: hash },
				],
			} as never;
		},
	};
}

describe("Briefing publication reader", () => {
	withFrozenBriefingClock(() => {
		test("falls back to the same PostgreSQL revision when Redis is empty", async () => {
			const result = await readBriefingWeek(databaseWithFallback(), redisWithoutPayload, "en");
			expect(result.state).toBe("READY");
			expect(result.revision).toBe(1);
			expect(result.payload?.publicationId).toBe(fixture.publicationId);
			expect(await metrics.registry.metrics()).toContain(
				"briefing_publication_reader_events_total"
			);
		});

		test("does not query a base publication when the active relation is empty", async () => {
			const queries: string[] = [];
			const database: QueryExecutor = {
				async query(text: string) {
					queries.push(text);
					return { rows: [] } as never;
				},
			};
			const result = await readBriefingWeek(database, redisWithoutPayload, "en");
			expect(result.state).toBe("OFFSEASON");
			expect(queries).toHaveLength(1);
			expect(queries[0]).toContain("content.briefing_active_publication");
			expect(queries[0]).not.toContain("content.publications");
		});

		test("fails closed when the active publication has expired", async () => {
			const expiredDb: QueryExecutor = {
				async query(text: string) {
					if (text.includes("content.briefing_active_publication"))
						return { rows: [{ ...metadata, valid_until: "2020-01-01T00:00:00.000Z" }] } as never;
					return { rows: [] } as never;
				},
			};
			const result = await readBriefingWeek(expiredDb, redisWithoutPayload, "en");
			expect(result.state).toBe("STALE");
			expect(result.payload).toBeNull();
		});

		test("does not trust a corrupt Redis pointer or payload", async () => {
			const redis = {
				get: async (key: string) =>
					key.includes(":active")
						? JSON.stringify({ schemaVersion: 1, publicationId: "wrong", revision: 9 })
						: JSON.stringify({ ...fixture, revision: 9 }),
			} as unknown as Redis;
			const result = await readBriefingWeek(databaseWithFallback(), redis, "en");
			expect(result.state).toBe("READY");
			expect(result.payload?.revision).toBe(1);
		});

		test("records corruption when present Redis data fails semantic validation", async () => {
			const before = getBriefingReaderMetrics().corruptions;
			const redis = {
				get: async (key: string) =>
					key.includes(":active")
						? JSON.stringify({
								schemaVersion: 1,
								publicationId: fixture.publicationId,
								revision: 1,
								state: "READY",
								locales: ["en", "zh-CN"],
								hashes: { en: "0".repeat(64), "zh-CN": "0".repeat(64) },
							})
						: JSON.stringify({ ...fixture, revision: 2 }),
			} as unknown as Redis;
			await readBriefingWeek(databaseWithFallback(), redis, "en");
			const after = getBriefingReaderMetrics().corruptions;
			expect(after).toBeGreaterThan(before);
		});

		test("records corruption when a valid pointer is missing the requested locale payload", async () => {
			const before = getBriefingReaderMetrics().corruptions;
			const pointer = JSON.stringify({
				schemaVersion: 1,
				publicationId: fixture.publicationId,
				revision: 1,
				state: "READY",
				locales: ["en", "zh-CN"],
				hashes: { en: hash, "zh-CN": hash },
			});
			const redis = {
				get: async (key: string) => (key.includes(":active") ? pointer : null),
			} as unknown as Redis;
			await readBriefingWeek(databaseWithFallback(), redis, "en");
			expect(getBriefingReaderMetrics().corruptions).toBeGreaterThan(before);
		});

		test("separates Redis outages from cache corruption", async () => {
			const beforeCorruptions = getBriefingReaderMetrics().corruptions;
			const beforeUnavailable = getBriefingReaderMetrics().redisUnavailable;
			const beforeRepairs = getBriefingReaderMetrics().repairs;
			const redis = {
				get: async () => {
					throw new Error("Redis timeout");
				},
			} as unknown as Redis;
			await readBriefingWeek(databaseWithFallback(), redis, "en");
			expect(getBriefingReaderMetrics().corruptions).toBe(beforeCorruptions);
			expect(getBriefingReaderMetrics().redisUnavailable).toBeGreaterThan(beforeUnavailable);
			expect(getBriefingReaderMetrics().repairs).toBe(beforeRepairs);
		});

		test("returns unavailable when PostgreSQL metadata cannot be read", async () => {
			const database: QueryExecutor = {
				async query() {
					throw new Error("content schema unavailable");
				},
			};
			const result = await readBriefingWeek(database, redisWithoutPayload, "en");
			expect(result).toMatchObject({ state: "UNAVAILABLE", payload: null });
		});

		test("fails closed when the active publication is missing one locale manifest", async () => {
			const incompleteDb: QueryExecutor = {
				async query(text: string) {
					if (text.includes("content.briefing_active_publication"))
						return {
							rows: [{ ...metadata, locale_manifest: { en: metadata.locale_manifest.en } }],
						} as never;
					return { rows: [] } as never;
				},
			};
			const result = await readBriefingWeek(incompleteDb, redisWithoutPayload, "en");
			expect(result).toMatchObject({ state: "UNAVAILABLE", payload: null, revision: 1 });
		});

		test("fails closed when a locale manifest entry is null", async () => {
			const malformedDb: QueryExecutor = {
				async query(text: string) {
					if (text.includes("content.briefing_active_publication"))
						return {
							rows: [
								{
									...metadata,
									locale_manifest: {
										en: metadata.locale_manifest.en,
										"zh-CN": null,
									},
								},
							],
						} as never;
					return { rows: [] } as never;
				},
			};
			const result = await readBriefingWeek(malformedDb, redisWithoutPayload, "en");
			expect(result).toMatchObject({ state: "UNAVAILABLE", payload: null, revision: 1 });
		});

		test("omits event when metadata deadline_time is invalid", async () => {
			const invalidDeadlineDb: QueryExecutor = {
				async query(text: string) {
					if (text.includes("content.briefing_active_publication"))
						return { rows: [{ ...metadata, deadline_time: "not-a-date" }] } as never;
					return {
						rows: [
							{
								payload: fixture,
								payload_bytes: Buffer.byteLength(canonical),
								payload_sha256: hash,
							},
						],
					} as never;
				},
			};
			const result = await readBriefingWeek(invalidDeadlineDb, redisWithoutPayload, "en");
			expect(result.state).toBe("READY");
			expect(result.event).toBeNull();
		});
	});
});
