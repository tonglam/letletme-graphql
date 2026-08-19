import { describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import fixture from "../../fixtures/briefing/week-publication-v1.json";
import type { QueryExecutor } from "../../../src/infra/database";
import { schema } from "../../../src/graphql/schema";
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
const DATA_WEEK_PUBLICATION_FIXTURE_SHA256 =
	"8870d420a7cb01b037905b378a3186ed087608dc03892fee9b356fde05fc75cc";
const rawFixtureSha256 = createHash("sha256")
	.update(
		readFileSync(new URL("../../fixtures/briefing/week-publication-v1.json", import.meta.url))
	)
	.digest("hex");
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
	withFrozenBriefingClock(() => {
	test("consumes the Data-owned fixture checksum", () => {
		expect(rawFixtureSha256).toBe(DATA_WEEK_PUBLICATION_FIXTURE_SHA256);
	});

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

	test("briefingStory preserves week state when the publication is not servable", async () => {
		const unservableDb: QueryExecutor = {
			async query(text: string) {
				if (text.includes("content.briefing_active_publication"))
					return { rows: [{ ...metadata, servable: false, state: "READY" }] } as never;
				return { rows: [] } as never;
			},
		};
		const result = await graphql({
			schema,
			source: `
				query BriefingStory($slug: String!, $locale: BriefingLocale!) {
					briefingStory(slug: $slug, locale: $locale) {
						state
						story { slug }
					}
				}
			`,
			variableValues: { slug: "missing-story", locale: "EN" },
			contextValue: {
				database: unservableDb,
				redis: { get: async () => null },
			} as never,
		});
		expect(result.errors).toBeUndefined();
		expect(result.data?.briefingStory).toMatchObject({ state: "READY", story: null });
	});

	test("briefingStory returns REMOVED when the slug is absent from a loaded week", async () => {
		const result = await graphql({
			schema,
			source: `
				query BriefingStory($slug: String!, $locale: BriefingLocale!) {
					briefingStory(slug: $slug, locale: $locale) {
						state
						story { slug }
					}
				}
			`,
			variableValues: { slug: "missing-story", locale: "EN" },
			contextValue: {
				database,
				redis: { get: async () => null },
			} as never,
		});
		expect(result.errors).toBeUndefined();
		expect(result.data?.briefingStory).toMatchObject({ state: "REMOVED", story: null });
	});

	test("briefingWeek and briefingStory share one publication read per request", async () => {
		let metadataReads = 0;
		const countingDb: QueryExecutor = {
			async query(text: string) {
				if (text.includes("content.briefing_active_publication")) {
					metadataReads += 1;
					return { rows: [metadata] } as never;
				}
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
		const contextValue = {
			database: countingDb,
			redis: { get: async () => null },
			requestScope: {},
		};
		const result = await graphql({
			schema,
			source: `
				query BriefingCombined($slug: String!, $locale: BriefingLocale!) {
					briefingWeek(locale: $locale) { state revision }
					briefingStory(slug: $slug, locale: $locale) { state }
				}
			`,
			variableValues: { slug: "missing-story", locale: "EN" },
			contextValue: contextValue as never,
		});
		expect(result.errors).toBeUndefined();
		expect(metadataReads).toBe(1);
	});
	});
});
