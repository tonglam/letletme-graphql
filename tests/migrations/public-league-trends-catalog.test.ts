import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("public league trends catalog permissions", () => {
	it("grants catalog reads only to the configured runtime role", () => {
		const migration = readFileSync(
			"migrations/forward/202608100003_public_league_trends_catalog_runtime_read.sql",
			"utf8"
		);
		const runner = readFileSync("scripts/migrate.ts", "utf8");
		const selectionMigration = readFileSync(
			"migrations/forward/202608100004_tournament_selection_stats_runtime_read.sql",
			"utf8"
		);

		expect(migration).toContain("current_setting('letletme.runtime_db_role', true)");
		expect(migration).toContain("GRANT SELECT ON TABLE public.public_league_trends_catalog TO %I");
		expect(migration).toContain("CREATE POLICY public_league_trends_catalog_runtime_read");
		expect(migration).toContain("USING (enabled = true)");
		expect(migration).not.toContain(
			"GRANT SELECT ON TABLE public.public_league_trends_catalog TO PUBLIC"
		);
		expect(runner).toContain("reconcileRuntimeCatalogRead");
		expect(runner).toContain("to_regclass('public.public_league_trends_catalog')");
		expect(runner).toContain("GRANT SELECT ON TABLE public.public_league_trends_catalog TO %I");
		expect(selectionMigration).toContain(
			"GRANT SELECT ON TABLE public.tournament_selection_stats TO %I"
		);
		expect(selectionMigration).toContain("CREATE POLICY tournament_selection_stats_runtime_read");
		expect(selectionMigration).toContain("public.public_league_trends_catalog catalog");
		expect(runner).toContain("tournament_selection_stats_runtime_read");
	});
});
