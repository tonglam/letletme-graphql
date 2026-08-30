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
		expect(keys.some((key) => key.includes(":trends-v4:"))).toBe(true);
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
			(key) => key.includes(":trends-v4:") && !key.includes(":pointer:")
		);
		expect(payloadKey).toBeDefined();
		values.set(payloadKey!, JSON.stringify({ invalid: true }));

		const rebuilt = await trendsRepository.listCohorts(context, "PUBLIC");
		expect(rebuilt.cohorts).toHaveLength(1);
		expect(values.get(payloadKey!)).not.toBe(JSON.stringify({ invalid: true }));
	});
});

describe("Trends private access", () => {
	type TestTrendSection = {
		rows: Array<{
			elementId?: number;
			percentage: number | null;
			isCaptain?: boolean;
			isViceCaptain?: boolean;
		}> | null;
		evidenceContext: {
			denominator: number | null;
			limitations: string[];
		};
	};

	const snapshotCohort = {
		tournament_id: 7,
		display_name: "Example",
		setup_status: "ready",
		latest_event_id: 1,
		revision: "2026:1|7:abc",
		publication_state: "READY",
		ownership_state: "READY",
		captaincy_state: "READY",
		vice_captaincy_state: "READY",
		transfers_state: "READY",
		expected_entries: 6,
		captured_at: "2026-08-22T00:00:00.000Z",
		published_at: "2026-08-22T00:00:00.000Z",
		publication_id: 99,
	};

	const personalRows = (count: number) =>
		Array.from({ length: count }, (_, index) => ({
			element_id: index + 1,
			pick_position: index + 1,
			player_name: `Player ${index + 1}`,
			player_position: index < 2 ? 1 : 3,
			team_short_name: "ARS",
			count: index === 0 ? 2 : 1,
		}));
	const aggregateCapabilities = [
		"OWNERSHIP",
		"EFFECTIVE_OWNERSHIP",
		"TEMPLATE",
		"CAPTAINCY",
		"VICE_CAPTAINCY",
		"TRANSFERS",
	] as const;

	const snapshotContext = (
		rows: Record<string, unknown>[],
		aggregateRows: Record<string, unknown>[] = [snapshotCohort]
	) => {
		const { context } = makeContext([]);
		context.principal = {
			userId: "user-1",
			source: "website",
			fplEntryId: 123,
			fplEntryVerifiedAt: "2026-08-22T00:00:00.000Z",
		};
		context.database.query = (async (sql: string) => ({
			rows: sql.includes("entry_event_picks")
				? [
						...aggregateRows.flatMap((row) =>
							aggregateCapabilities.map((capability) => ({ ...row, capability }))
						),
						...rows.map((row) => ({ ...row, capability: "PERSONAL_EXPOSURE" })),
					]
				: sql.includes("tournament_selection_stat_rows")
					? aggregateRows
					: [snapshotCohort],
		})) as typeof context.database.query;
		return context;
	};

	it("returns all 15 personal exposure picks even when aggregate limit is 12", async () => {
		const payload = await trendsRepository.snapshot(
			snapshotContext(personalRows(15)),
			"competition:7",
			1,
			12,
			"MINE"
		);
		const section = payload.sections.find((item) => item.capability === "PERSONAL_EXPOSURE");

		expect(section).toMatchObject({
			state: "READY",
			evidenceContext: { denominator: 6, sampleSize: 6, availabilityState: "READY" },
		});
		expect(section?.rows).toHaveLength(15);
	});

	it("uses exactly two SQL round trips and one fixed UNION for a MINE snapshot", async () => {
		const context = snapshotContext(personalRows(15));
		const originalQuery = context.database.query;
		const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
		context.database.query = (async (sql: string, params?: unknown[]) => {
			calls.push({ sql, params });
			return originalQuery(sql, params);
		}) as typeof context.database.query;

		await trendsRepository.snapshot(context, "competition:7", 1, 12, "MINE");

		expect(calls).toHaveLength(2);
		expect(calls[1]?.sql.match(/UNION ALL/g)).toHaveLength(6);
		expect(calls[1]?.sql.match(/LIMIT \$2/g)).toHaveLength(5);
		expect(calls[1]?.sql).toContain("LIMIT 1000");
		expect(calls[1]?.sql.trim()).toEndWith(
			"ORDER BY capability, count DESC NULLS LAST, pick_position ASC NULLS LAST, element_id"
		);
		expect(calls[1]?.params).toEqual([99, 12, 2025, 123, 1]);
	});

	it("returns a valid 15-player template with captain and vice-captain markers", async () => {
		const positions = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
		const teams = ["ARS", "BHA", "BRE", "CHE", "LIV"];
		const templateCandidates = positions.map((playerPosition, index) => ({
			element_id: index + 1,
			player_name: `Template Player ${index + 1}`,
			player_position: playerPosition,
			team_short_name: teams[index % teams.length],
			count: 100 - index,
			captain_count: index === 2 ? 100 : 20 - index,
			vice_captain_count: index === 3 ? 100 : 20 - index,
		}));

		const payload = await trendsRepository.snapshot(
			snapshotContext(personalRows(15), templateCandidates),
			"competition:7",
			1,
			12,
			"MINE"
		);
		const section = payload.sections.find((item) => item.capability === "TEMPLATE") as
			TestTrendSection | undefined;

		expect(section).toMatchObject({ state: "READY", evidenceContext: { denominator: 6 } });
		expect(section?.rows).toHaveLength(15);
		expect(section?.rows?.filter((row) => row.isCaptain)).toHaveLength(1);
		expect(section?.rows?.filter((row) => row.isViceCaptain)).toHaveLength(1);
		expect(section?.rows?.find((row) => row.isCaptain)?.elementId).toBe(3);
		expect(section?.rows?.find((row) => row.isViceCaptain)?.elementId).toBe(4);
	});

	it("keeps the template unavailable until ownership and both role captures are ready", async () => {
		const { context } = makeContext([
			{
				...snapshotCohort,
				captaincy_state: "NOT_READY",
			},
		]);

		const payload = await trendsRepository.listCohorts(context, "PUBLIC");
		const template = payload.cohorts[0]?.capabilities.find(
			(item) => item.capability === "TEMPLATE"
		);

		expect(template).toEqual({ capability: "TEMPLATE", state: "NOT_READY" });
	});

	it("recomputes aggregate percentages from the evidence denominator", async () => {
		const payload = await trendsRepository.snapshot(
			snapshotContext(personalRows(15), [
				{
					element_id: 1,
					player_name: "Popular Player",
					player_position: 3,
					team_short_name: "ARS",
					count: 3,
				},
			]),
			"competition:7",
			1,
			12,
			"MINE"
		);
		const section = payload.sections.find((item) => item.capability === "OWNERSHIP") as
			TestTrendSection | undefined;
		const firstRow = section?.rows?.[0];

		expect(section?.evidenceContext.denominator).toBe(6);
		expect(firstRow?.percentage).toBe(50);
	});

	it("marks incomplete personal exposure as partial and preserves the field denominator", async () => {
		const payload = await trendsRepository.snapshot(
			snapshotContext(personalRows(14)),
			"competition:7",
			1,
			12,
			"MINE"
		);
		const section = payload.sections.find((item) => item.capability === "PERSONAL_EXPOSURE") as
			TestTrendSection | undefined;

		expect(section).toMatchObject({
			state: "PARTIAL",
			evidenceContext: {
				denominator: 6,
				sampleSize: 6,
				availabilityState: "PARTIAL",
				coverageState: "partial",
			},
		});
		expect(section?.rows).toHaveLength(14);
		expect(section?.evidenceContext.limitations).toEqual([
			"Personal exposure returned 14 of 15 squad picks or contained duplicate rows.",
		]);
	});

	it("rejects MINE catalog reads for an unverified assurance binding", async () => {
		const { context } = makeContext([]);
		context.principal = {
			userId: "user-1",
			source: "wechat_miniprogram",
			fplEntryId: 123,
			fplEntryVerifiedAt: null,
		};

		await expect(trendsRepository.listCohorts(context, "MINE")).rejects.toMatchObject({
			extensions: { code: "VIEWER_ENTRY_REQUIRED" },
		});
	});

	it("allows MINE catalog reads for a selected Mini Program viewer", async () => {
		const { context } = makeContext([
			{
				tournament_id: 7,
				display_name: "Example",
				setup_status: "ready",
				latest_event_id: 1,
				revision: "viewer-revision",
				publication_state: "READY",
				ownership_state: "READY",
				captaincy_state: "READY",
				vice_captaincy_state: "READY",
				transfers_state: "READY",
			},
		]);
		context.principal = {
			userId: "mini-account-1",
			source: "wechat_miniprogram",
			viewerEntryId: 123,
			fplEntryId: null,
			fplEntryVerifiedAt: null,
		};

		const result = await trendsRepository.listCohorts(context, "MINE");
		expect(result.cohorts).toHaveLength(1);
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
