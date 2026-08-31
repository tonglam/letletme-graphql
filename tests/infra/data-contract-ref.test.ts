import { describe, expect, test } from "bun:test";

const ref = (await Bun.file(".github/data-platform-contract-ref").text()).trim();
const workflow = await Bun.file(".github/workflows/ci.yml").text();
const securityWorkflow = await Bun.file(".github/workflows/security.yml").text();
const compatibilityWorkflow = await Bun.file(
	".github/workflows/data-main-compatibility.yml"
).text();
const compatibilityProbe = await Bun.file("scripts/check-data-main-compatibility.ts").text();
const directSqlContract = await Bun.file("scripts/lib/validate-direct-data-sql-contract.ts").text();
const pinnedContractProbe = await Bun.file("scripts/check-database-contract.ts").text();
const contractFixture = await Bun.file("tests/fixtures/database-contract.sql").text();

describe("Data Platform contract pin", () => {
	test("uses a fixed full SHA for required CI", () => {
		expect(ref).toMatch(/^[0-9a-f]{40}$/);
		expect(workflow).toContain(".github/data-platform-contract-ref");
		expect(workflow).toContain("ref: ${{ steps.data-contract.outputs.ref }}");
	});

	test("checks fixed SHA drift against Data main only in scheduled security", () => {
		expect(securityWorkflow).toContain("repos/tonglam/letletme_data/commits/main");
		expect(securityWorkflow).toContain("fixed Data SHA:");
		expect(securityWorkflow).toContain("Data main SHA:");
		expect(securityWorkflow).toContain("contract-drift:");
	});

	test("runs a scheduled Data main migration and the complete GraphQL consumer contract", () => {
		expect(compatibilityWorkflow).toContain("repository: tonglam/letletme_data");
		expect(compatibilityWorkflow).toContain("ref: main");
		expect(compatibilityWorkflow).toContain("bun run db:migrate");
		expect(compatibilityWorkflow).toContain(
			"data-platform/tests/fixtures/graphql-consumer-authority.sql"
		);
		expect(compatibilityWorkflow).toContain("tests/fixtures/database-contract.sql");
		expect(compatibilityWorkflow).toContain("check-data-main-compatibility.ts");
		expect(compatibilityWorkflow).toContain('RUN_DATABASE_CONTRACT_INTEGRATION: "1"');
		expect(compatibilityWorkflow).toContain("RATE_LIMIT_REDIS_URL: redis://127.0.0.1:6380");
		const baselineAt = compatibilityWorkflow.indexOf("Apply Data main baseline");
		const identitiesAt = compatibilityWorkflow.indexOf("Provide plain-PG Supabase identities");
		const repeatAt = compatibilityWorkflow.indexOf("Verify Data main migration is repeatable");
		expect(baselineAt).toBeGreaterThan(-1);
		expect(identitiesAt).toBeGreaterThan(baselineAt);
		expect(repeatAt).toBeGreaterThan(identitiesAt);
		expect(compatibilityWorkflow).toContain("bun run docs:check");
		expect(compatibilityWorkflow).toContain("bun run typecheck");
		expect(compatibilityProbe).toContain("validateDatabaseContract(database)");
		expect(compatibilityProbe).toContain("validateDirectDataSqlContract(database)");
		expect(compatibilityProbe).toContain("directSqlProbeCount");
		expect(directSqlContract).toContain("BRIEFING_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("ENTRIES_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("GAMEWEEK_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("HOME_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("MY_FPL_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("PLAYER_DETAIL_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("PLAYERS_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("PLAYER_VALUES_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("PLAYER_STATE_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("TRENDS_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("LIVE_MATCHES_DATA_SQL_CONTRACT");
		expect(directSqlContract).toContain("EXPLAIN (FORMAT JSON, COSTS OFF)");
		expect(compatibilityProbe).not.toContain("to_regclass");
		expect(contractFixture).toContain("GRANT letletme_graphql_reader TO graphql_ci");
		expect(contractFixture).not.toContain("INSERT INTO fpl.seasons");
		expect(contractFixture).not.toContain("INSERT INTO ops.dataset_publications");
		expect(contractFixture).not.toContain("REFRESH MATERIALIZED VIEW");
		expect(contractFixture).not.toContain("GRANT USAGE ON SCHEMA content");
		expect(contractFixture).not.toContain("GRANT SELECT ON content.");
		expect(contractFixture).not.toContain(
			"CREATE OR REPLACE VIEW content.briefing_active_publication"
		);
	});

	test("uses the same consumer fixture for the pinned Data contract", () => {
		expect(workflow).toContain("data-platform/tests/fixtures/graphql-consumer-authority.sql");
		expect(workflow).toContain("tests/fixtures/database-contract.sql");
		expect(workflow).toContain("bun run contract:check");
		expect(workflow).toContain("bun run data:contract:check");
		expect(pinnedContractProbe).not.toContain("validateDirectDataSqlContract(database)");
		expect(compatibilityProbe).toContain("validateDirectDataSqlContract(database)");
	});
});
