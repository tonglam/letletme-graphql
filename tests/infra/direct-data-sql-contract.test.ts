import { describe, expect, test } from "bun:test";
import { DIRECT_DATA_SQL_CONTRACT } from "../../scripts/lib/validate-direct-data-sql-contract";

describe("direct Data SQL contract", () => {
	test("has unique named planner probes for every hard-cut consumer family", () => {
		const names = DIRECT_DATA_SQL_CONTRACT.map((probe) => probe.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.some((name) => name.startsWith("briefing."))).toBe(true);
		expect(names.some((name) => name.startsWith("my-fpl."))).toBe(true);
		expect(names.some((name) => name.startsWith("player-state."))).toBe(true);
		expect(names.some((name) => name.startsWith("public-league-trends."))).toBe(true);
		expect(names.some((name) => name.startsWith("trends."))).toBe(true);
	});

	test("contains the direct reporting relations and only read statements", () => {
		const sql = DIRECT_DATA_SQL_CONTRACT.map((probe) => probe.sql).join("\n");
		expect(sql).toContain("content.publication_payloads");
		expect(sql).toContain("payload_bytes");
		expect(sql).toContain("payload_sha256");
		expect(sql).toContain("reporting.player_season_summary_rows");
		expect(sql).toContain("reporting.tournament_selection_stat_publications");
		expect(sql).toContain("reporting.tournament_selection_stat_rows");
		for (const probe of DIRECT_DATA_SQL_CONTRACT) {
			const statement = probe.sql.trimStart().replace(/^\/\*[\s\S]*?\*\/\s*/, "");
			expect(statement).toMatch(/^(SELECT|WITH)\b/);
			expect(Array.isArray(probe.values)).toBe(true);
		}
	});

	test("uses the runtime Briefing payload fallback as a planner probe", () => {
		const fallback = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "briefing.payload-fallback"
		);
		expect(fallback?.values).toEqual(["00000000-0000-4000-8000-000000000001", "en"]);
	});

	test("binds the Trends aggregate publication identity as a bigint", () => {
		const aggregate = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "trends.aggregate-union"
		);
		expect(aggregate?.values).toEqual([1, 12, 2026, 1, 1]);
	});
});
