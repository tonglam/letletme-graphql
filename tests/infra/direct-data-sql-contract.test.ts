import { describe, expect, test } from "bun:test";
import {
	DIRECT_DATA_SQL_CONTRACT,
	validateDirectDataSqlContract,
} from "../../scripts/lib/validate-direct-data-sql-contract";
import type { QueryResult, QueryResultRow } from "pg";
import type { QueryExecutor } from "../../src/infra/database";
import { SEARCH_ENTRIES_SQL } from "../../src/domains/entries/repository";
import {
	GAMEWEEK_HISTORICAL_TEAM_AS_OF_SQL,
	GAMEWEEK_HISTORICAL_TEAM_EXACT_SQL,
} from "../../src/domains/gameweek/service";
import {
	HOME_MARKET_AVAILABILITY_SQL,
	HOME_MARKET_OWNERSHIP_SQL,
	HOME_MARKET_PRICE_CHANGES_SQL,
} from "../../src/domains/home/market-repository";
import { HOME_PERSONAL_DESK_SQL } from "../../src/domains/home/repository";
import { MARKET_QUERY } from "../../src/domains/market/repository";
import { PLAYER_DETAIL_HISTORICAL_TEAMS_SQL } from "../../src/domains/player-detail/repository";
import {
	CORE_FALLBACK_SQL,
	CORE_LIVE_IDENTITY_FALLBACK_SQL,
	LIVE_FALLBACK_SQL,
	LIVE_LIFECYCLE_STATUS_SQL,
} from "../../src/infra/data-snapshot";
import {
	PUBLICATION_BY_ID_SQL,
	PUBLICATION_CANDIDATES_SQL,
	PUBLICATION_CONTEXT_ITEMS_SQL,
	PUBLICATION_ITEM_METADATA_SQL,
	PUBLICATION_ITEMS_SQL,
} from "../../src/infra/price-change-predictions-client";

describe("direct Data SQL contract", () => {
	test("has unique named planner probes for every hard-cut consumer family", () => {
		const names = DIRECT_DATA_SQL_CONTRACT.map((probe) => probe.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.some((name) => name.startsWith("briefing."))).toBe(true);
		expect(names).toContain("entries.search");
		expect(names.some((name) => name.startsWith("gameweek."))).toBe(true);
		expect(names).toContain("home.personal-desk");
		expect(names.some((name) => name.startsWith("home-market."))).toBe(true);
		expect(names.some((name) => name.startsWith("market."))).toBe(true);
		expect(names.some((name) => name.startsWith("my-fpl."))).toBe(true);
		expect(names.some((name) => name.startsWith("player-detail."))).toBe(true);
		expect(names.some((name) => name.startsWith("players."))).toBe(true);
		expect(names.some((name) => name.startsWith("player-values."))).toBe(true);
		expect(names.some((name) => name.startsWith("player-state."))).toBe(true);
		expect(names.some((name) => name.startsWith("public-league-trends."))).toBe(true);
		expect(names.some((name) => name.startsWith("trends."))).toBe(true);
		expect(names.some((name) => name.startsWith("data-snapshot."))).toBe(true);
		expect(names.some((name) => name.startsWith("price-change."))).toBe(true);
	});

	test("contains the direct reporting relations and only read statements", () => {
		const sql = DIRECT_DATA_SQL_CONTRACT.map((probe) => probe.sql).join("\n");
		expect(sql).toContain("content.publication_payloads");
		expect(sql).toContain("payload_bytes");
		expect(sql).toContain("payload_sha256");
		expect(sql).toContain("reporting.player_season_summary_rows");
		expect(sql).toContain("reporting.tournament_selection_stat_publications");
		expect(sql).toContain("reporting.tournament_selection_stat_rows");
		expect(sql).toContain("captured_at = $3::timestamptz");
		for (const probe of DIRECT_DATA_SQL_CONTRACT) {
			const statement = probe.sql.trimStart().replace(/^\/\*[\s\S]*?\*\/\s*/, "");
			expect(statement).toMatch(/^(SELECT|WITH)\b/);
			expect(Array.isArray(probe.values)).toBe(true);
		}
	});

	test("asserts JSONB for payload columns decoded by the runtime", () => {
		const payloadAssertions = DIRECT_DATA_SQL_CONTRACT.flatMap(
			(probe) => probe.resultTypes ?? []
		).filter(({ column }) => column === "payload");
		expect(payloadAssertions.length).toBeGreaterThan(0);
		expect(payloadAssertions.every(({ pgType }) => pgType === "jsonb")).toBe(true);
		expect(payloadAssertions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relation: "ops.dataset_publication_items",
					column: "payload",
					pgType: "jsonb",
				}),
				expect.objectContaining({
					relation: "content.publication_payloads",
					column: "payload",
					pgType: "jsonb",
				}),
			])
		);
		const expectedRelations = new Set(payloadAssertions.map(({ relation }) => relation));
		expect(expectedRelations).toEqual(
			new Set([
				"content.publication_payloads",
				"ops.dataset_publication_items",
				"competition.my_fpl_snapshot_entries",
				"competition.my_fpl_snapshot_tournament_rows",
				"competition.my_fpl_snapshot_tournament_aggregates",
			])
		);
	});

	test("fails the candidate contract when a decoded payload column is text", async () => {
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, attribute.atttypmod)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type: "text",
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		await expect(validateDirectDataSqlContract(database)).rejects.toThrow(
			/expected jsonb, got text/
		);
	});

	test("uses the runtime Briefing payload fallback as a planner probe", () => {
		const fallback = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "briefing.payload-fallback"
		);
		expect(fallback?.values).toEqual([null, "en"]);
	});

	test("uses the runtime historical-team statements as planner probes", () => {
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "gameweek.historical-team-exact")?.sql
		).toBe(GAMEWEEK_HISTORICAL_TEAM_EXACT_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "gameweek.historical-team-as-of")?.sql
		).toBe(GAMEWEEK_HISTORICAL_TEAM_AS_OF_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "player-detail.historical-teams")?.sql
		).toBe(PLAYER_DETAIL_HISTORICAL_TEAMS_SQL);
	});

	test("uses the runtime Entry search and Home desk statements as planner probes", () => {
		expect(DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "entries.search")?.sql).toBe(
			SEARCH_ENTRIES_SQL
		);
		expect(DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home.personal-desk")?.sql).toBe(
			HOME_PERSONAL_DESK_SQL
		);
	});

	test("uses the runtime Market statements as planner probes", () => {
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "market.snapshot-window")?.sql
		).toBe(MARKET_QUERY);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home-market.ownership")?.sql
		).toBe(HOME_MARKET_OWNERSHIP_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home-market.price-changes")?.sql
		).toBe(HOME_MARKET_PRICE_CHANGES_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home-market.availability")?.sql
		).toBe(HOME_MARKET_AVAILABILITY_SQL);
	});

	test("uses the runtime publication and snapshot fallback statements as planner probes", () => {
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "price-change.publication-candidates")
				?.sql
		).toBe(PUBLICATION_CANDIDATES_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "price-change.publication-by-id")?.sql
		).toBe(PUBLICATION_BY_ID_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "price-change.publication-items")?.sql
		).toBe(PUBLICATION_ITEMS_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find(
				(probe) => probe.name === "price-change.publication-context-items"
			)?.sql
		).toBe(PUBLICATION_CONTEXT_ITEMS_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find(
				(probe) => probe.name === "price-change.publication-item-metadata"
			)?.sql
		).toBe(PUBLICATION_ITEM_METADATA_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "data-snapshot.core-fallback")?.sql
		).toBe(CORE_FALLBACK_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "data-snapshot.live-fallback")?.sql
		).toBe(LIVE_FALLBACK_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find(
				(probe) => probe.name === "data-snapshot.core-live-identity-fallback"
			)?.sql
		).toBe(CORE_LIVE_IDENTITY_FALLBACK_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "data-snapshot.live-lifecycle-status")
				?.sql
		).toBe(LIVE_LIFECYCLE_STATUS_SQL);
	});

	test("lets PostgreSQL infer the opaque Trends publication identity", () => {
		const aggregate = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "trends.aggregate-union"
		);
		expect(aggregate?.values).toEqual([null, 12, 2026, 1, 1]);
	});
});
