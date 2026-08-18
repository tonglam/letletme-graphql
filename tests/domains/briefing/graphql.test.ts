import { describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { createHash } from "node:crypto";

import fixture from "../../fixtures/briefing/week-publication-v1.json";
import type { QueryExecutor } from "../../../src/infra/database";
import { schema } from "../../../src/graphql/schema";

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
const metadata = {
	publication_id: fixture.publicationId,
	scope_key: "week",
	revision: "1",
	schema_version: 1,
	season_code: "2627",
	target_event_id: 1,
	event_name: "Gameweek 1",
	deadline_time: fixture.event.deadlineTime,
	state: "READY",
	servable: true,
	source_checked_at: fixture.sourceCheckedAt,
	published_at: fixture.publishedAt,
	valid_until: fixture.validUntil,
	locale_manifest: {
		en: {
			bytes: Buffer.byteLength(canonical),
			sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
		},
	},
};

const database: QueryExecutor = {
	async query(text: string) {
		if (text.includes("content.briefing_active_publication")) return { rows: [metadata] } as never;
		return {
			rows: [
				{
					payload: fixture,
					payload_bytes: Buffer.byteLength(canonical),
					payload_sha256: metadata.locale_manifest.en.sha256,
				},
			],
		} as never;
	},
};

describe("Briefing GraphQL contract", () => {
	test("exposes the shared Week publication without personal fields", async () => {
		const result = await graphql({
			schema,
			source: `
				query BriefingWeek($locale: BriefingLocale!) {
					briefingWeek(locale: $locale) {
						state revision event { eventId deadlineTime }
						featured { id slug title sourceUrl }
						sections { key items { slug storyRevision } }
					}
				}
			`,
			variableValues: { locale: "EN" },
			contextValue: {
				database,
				redis: { get: async () => null },
			} as never,
		});
		expect(result.errors).toBeUndefined();
		expect(result.data?.briefingWeek).toMatchObject({
			state: "READY",
			revision: 1,
			event: { eventId: 1 },
			featured: [],
			sections: [],
		});
	});
});
