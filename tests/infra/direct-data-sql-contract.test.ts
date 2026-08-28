import { describe, expect, test } from "bun:test";
import {
	DIRECT_DATA_SQL_CONTRACT,
	allowedResultTypes,
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
	CORE_PHASE_SHAPE_SQL,
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

	test("asserts JSON-compatible types for payload columns decoded by the runtime", () => {
		const payloadAssertions = DIRECT_DATA_SQL_CONTRACT.flatMap(
			(probe) => probe.resultTypes ?? []
		).filter(({ column }) => column === "payload");
		expect(payloadAssertions.length).toBeGreaterThan(0);
		expect(payloadAssertions.every(({ pgType }) => pgType === "jsonb")).toBe(true);
		expect(
			payloadAssertions.every(
				({ acceptedPgTypes }) =>
					JSON.stringify(acceptedPgTypes) === JSON.stringify(["json", "jsonb"])
			)
		).toBe(true);
		expect(payloadAssertions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relation: "ops.dataset_publication_items",
					column: "payload",
					pgType: "jsonb",
					acceptedPgTypes: ["json", "jsonb"],
				}),
				expect.objectContaining({
					relation: "content.publication_payloads",
					column: "payload",
					pgType: "jsonb",
					acceptedPgTypes: ["json", "jsonb"],
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
				const runtimeProbe = DIRECT_DATA_SQL_CONTRACT.find(
					(probe) => probe.runtime && probe.sql === text
				);
				if (runtimeProbe?.runtime === "must-return-board") {
					return {
						rows: [{ field_size: 1, viewer_row: { entryId: 1 } }],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-row") {
					return { rows: [{}] } as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		await expect(validateDirectDataSqlContract(database)).rejects.toThrow(
			/expected json or jsonb, got text/
		);
	});

	test("allows equivalent JSON and JSONB decoded types only where declared", () => {
		const metadata = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "briefing.active-metadata"
		);
		expect(metadata?.resultTypes).toEqual([
			expect.objectContaining({
				relation: "content.briefing_active_publication",
				column: "locale_manifest",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			}),
		]);
	});

	test("always keeps the primary PostgreSQL type in the accepted type set", () => {
		expect(
			allowedResultTypes({
				relation: "content.publication_payloads",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json"],
			})
		).toEqual(["json", "jsonb"]);
	});

	test("accepts character varying for the decoded Market position", () => {
		const market = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "market.snapshot-window"
		);
		const position = market?.resultTypes?.find((assertion) => assertion.column === "position");
		expect(position && allowedResultTypes(position)).toEqual(["character varying", "text"]);
	});

	test("accepts JSON for every decoded JSON contract column", async () => {
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, attribute.atttypmod)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type:
								relation === "fpl.player_market_snapshots" && columns[index] === "position"
									? "text"
									: "json",
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				const runtimeProbe = DIRECT_DATA_SQL_CONTRACT.find(
					(probe) => probe.runtime && probe.sql === text
				);
				if (runtimeProbe?.runtime === "must-return-board") {
					return {
						rows: [{ field_size: 1, viewer_row: { entryId: 1 } }],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-row") {
					return { rows: [{}] } as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		expect(await validateDirectDataSqlContract(database)).toBe(DIRECT_DATA_SQL_CONTRACT.length);
	});

	test("fails closed when the runtime reader cannot see the authority fixture", async () => {
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, attribute.atttypmod)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type:
								relation === "fpl.player_market_snapshots" && columns[index] === "position"
									? "text"
									: "jsonb",
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		await expect(validateDirectDataSqlContract(database)).rejects.toThrow(/runtime visibility/);
	});

	test("fails closed when the runtime board join is empty or has no viewer row", async () => {
		const boardSql = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "my-fpl.competition-board"
		)?.sql;
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, attribute.atttypmod)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type:
								relation === "fpl.player_market_snapshots" && columns[index] === "position"
									? "text"
									: "jsonb",
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				if (text === boardSql) {
					return { rows: [{ field_size: 0, viewer_row: null }] } as unknown as QueryResult<Row>;
				}
				if (DIRECT_DATA_SQL_CONTRACT.some((probe) => probe.runtime && probe.sql === text)) {
					return { rows: [{}] } as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		await expect(validateDirectDataSqlContract(database)).rejects.toThrow(
			/my-fpl\.competition-board/
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
		const market = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "market.snapshot-window"
		);
		expect(market?.sql).toBe(MARKET_QUERY);
		expect(market?.resultTypes).toEqual([
			expect.objectContaining({
				relation: "fpl.player_market_snapshots",
				column: "position",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			}),
		]);
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
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "data-snapshot.core-phase-shape")?.sql
		).toBe(CORE_PHASE_SHAPE_SQL);
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

	test("requires the My FPL authority fixture to be visible to the runtime reader", () => {
		const runtimeProbes = DIRECT_DATA_SQL_CONTRACT.filter((probe) => probe.runtime);
		expect(runtimeProbes.map((probe) => probe.name)).toEqual(
			expect.arrayContaining([
				"my-fpl.active-publications",
				"my-fpl.snapshot-entry",
				"my-fpl.snapshot-tournament-row-visibility",
				"my-fpl.competition-aggregate",
				"my-fpl.assert-tournament-membership",
				"my-fpl.list-tournament-memberships",
			])
		);
		expect(runtimeProbes.map((probe) => probe.name)).toContain("public-league-trends.catalog");
		expect(
			runtimeProbes.every(
				(probe) => probe.runtime === "must-return-row" || probe.runtime === "must-return-board"
			)
		).toBe(true);
	});

	test("lets PostgreSQL infer the opaque Trends publication identity", () => {
		const aggregate = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "trends.aggregate-union"
		);
		expect(aggregate?.values).toEqual([null, 12, 2026, 1, 1]);
	});
});
