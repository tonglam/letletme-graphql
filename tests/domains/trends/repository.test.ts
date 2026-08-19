import { createHash } from "crypto";
import { describe, expect, it } from "bun:test";
import { trendsRepository } from "../../../src/domains/trends/repository";
import type { GraphQLContext } from "../../../src/graphql/context";

const makeContext = (rows: Record<string, unknown>[]) => {
	const values = new Map<string, string>();
	const context = {
		currentSeason: { seasonId: 2025, seasonCode: "2526" },
		dataRevision: "core-test",
		redis: {
			get: async (key: string) => values.get(key) ?? null,
			set: async (key: string, value: string) => {
				values.set(key, value);
				return "OK";
			},
			del: async (key: string) => {
				values.delete(key);
			},
		},
		database: { query: async () => ({ rows }) },
		logger: { warn: () => {} },
	} as unknown as GraphQLContext;
	return { context, values };
};

describe("Trends revisioned cache", () => {
	it("uses a schema-versioned pointer and a hash of the actual publication revision", async () => {
		const { context, values } = makeContext([
			{
				tournament_id: 7,
				display_name: "Example",
				latest_event_id: 10,
				revision: "2026:10|7:abc",
				publication_state: "READY",
				ownership_state: "READY",
				captaincy_state: "READY",
				vice_captaincy_state: "READY",
				transfers_state: "READY",
			},
		]);
		await trendsRepository.listCohorts(context, "PUBLIC");
		const keys = [...values.keys()];
		const revisionKey = `trends-${createHash("sha256")
			.update("7:2026:10|7:abc", "utf8")
			.digest("hex")
			.slice(0, 24)}`;
		expect(keys.some((key) => key.includes(":trends-v2:"))).toBe(true);
		expect(keys.some((key) => key.includes(`:${revisionKey}:`))).toBe(true);
	});

	it("evicts a JSON-valid payload that fails the trends cache codec", async () => {
		const { context, values } = makeContext([
			{
				tournament_id: 7,
				display_name: "Example",
				latest_event_id: 10,
				revision: "7:abc",
				publication_state: "READY",
				ownership_state: "READY",
				captaincy_state: "READY",
				vice_captaincy_state: "READY",
				transfers_state: "READY",
			},
		]);
		await trendsRepository.listCohorts(context, "PUBLIC");
		const payloadKey = [...values.keys()].find(
			(key) => key.includes(":trends-v2:") && !key.includes(":pointer:")
		);
		expect(payloadKey).toBeDefined();
		values.set(payloadKey!, JSON.stringify({ invalid: true }));

		const rebuilt = await trendsRepository.listCohorts(context, "PUBLIC");
		expect(rebuilt.cohorts).toHaveLength(1);
		expect(values.get(payloadKey!)).not.toBe(JSON.stringify({ invalid: true }));
	});
});

describe("Trends private access", () => {
	it("rejects MINE catalog reads for an unverified assurance binding", async () => {
		const { context } = makeContext([]);
		context.principal = {
			userId: "user-1",
			source: "wechat_miniprogram",
			fplEntryId: 123,
			fplEntryVerifiedAt: "2026-07-18T00:00:00.000Z",
			fplEntrySeason: "2526",
			fplEntryBindingAssurance: "UNVERIFIED",
			envelopeVersion: 2,
		};

		await expect(trendsRepository.listCohorts(context, "MINE")).rejects.toMatchObject({
			extensions: { code: "FORBIDDEN" },
		});
	});
});
