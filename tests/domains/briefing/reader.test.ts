import { describe, expect, test } from "bun:test";
import type Redis from "ioredis";
import { createHash } from "node:crypto";

import fixture from "../../fixtures/briefing/week-publication-v1.json";
import type { QueryExecutor } from "../../../src/infra/database";
import { readBriefingWeek } from "../../../src/infra/content-publication";
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
	locale_manifest: { en: { bytes: Buffer.byteLength(canonical), sha256: hash } },
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

	test("returns unavailable when PostgreSQL metadata cannot be read", async () => {
		const database: QueryExecutor = {
			async query() {
				throw new Error("content schema unavailable");
			},
		};
		const result = await readBriefingWeek(database, redisWithoutPayload, "en");
		expect(result).toMatchObject({ state: "UNAVAILABLE", payload: null });
	});

	test("omits event when metadata deadline_time is invalid", async () => {
		const invalidDeadlineDb: QueryExecutor = {
			async query(text: string) {
				if (text.includes("content.briefing_active_publication"))
					return { rows: [{ ...metadata, deadline_time: "not-a-date" }] } as never;
				return {
					rows: [
						{ payload: fixture, payload_bytes: Buffer.byteLength(canonical), payload_sha256: hash },
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
