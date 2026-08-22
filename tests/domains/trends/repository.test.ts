import { createHash } from "crypto";
import { describe, expect, it } from "bun:test";
import type { QueryResult, QueryResultRow } from "pg";
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
				setup_status: "ready",
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
		expect(keys.some((key) => key.includes(":trends-v3:"))).toBe(true);
		expect(keys.some((key) => key.includes(`:${revisionKey}:`))).toBe(true);
	});

	it("evicts a JSON-valid payload that fails the trends cache codec", async () => {
		const { context, values } = makeContext([
			{
				tournament_id: 7,
				display_name: "Example",
				setup_status: "ready",
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
			(key) => key.includes(":trends-v3:") && !key.includes(":pointer:")
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
			fplEntryVerifiedAt: null,
		};

		await expect(trendsRepository.listCohorts(context, "MINE")).rejects.toMatchObject({
			extensions: { code: "FORBIDDEN" },
		});
	});

	it("lists every joined tournament and marks an unfinished setup as not ready", async () => {
		let catalogSql = "";
		let catalogParams: unknown[] = [];
		const { context } = makeContext([]);
		context.principal = {
			userId: "user-1",
			source: "website",
			fplEntryId: 123,
			fplEntryVerifiedAt: "2026-08-22T00:00:00.000Z",
		};
		context.database.query = async <Row extends QueryResultRow = QueryResultRow>(
			sql: string,
			params?: readonly unknown[]
		): Promise<QueryResult<Row>> => {
			catalogSql = sql;
			catalogParams = [...(params ?? [])];
			return {
				command: "SELECT",
				rowCount: 1,
				oid: 0,
				fields: [],
				rows: [
					{
						tournament_id: 8,
						display_name: "Still preparing",
						setup_status: "processing",
						latest_event_id: null,
						revision: null,
						publication_state: null,
					},
				] as unknown as Row[],
			};
		};

		const payload = await trendsRepository.listCohorts(context, "MINE");

		expect(catalogSql).toContain("FROM competition.tournament_entries member");
		expect(catalogSql).toContain("member.season_id = $1 AND member.entry_id = $2");
		expect(catalogSql).not.toContain("tournament.setup_status = 'ready'");
		expect(catalogParams).toEqual([2025, 123]);
		expect(payload.cohorts[0]).toMatchObject({
			id: "competition:8",
			access: "MINE",
			setupStatus: "PROCESSING",
			availability: "NOT_READY",
		});
		expect(payload.cohorts[0]?.capabilities.every((item) => item.state === "NOT_READY")).toBe(true);
	});
});
