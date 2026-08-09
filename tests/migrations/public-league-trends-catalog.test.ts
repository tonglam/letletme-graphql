import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("public league trends catalog permissions", () => {
	it("grants catalog reads only to the configured runtime role", () => {
		const migration = readFileSync(
			"migrations/forward/202608100003_public_league_trends_catalog_runtime_read.sql",
			"utf8"
		);

		expect(migration).toContain("current_setting('letletme.runtime_db_role', true)");
		expect(migration).toContain("GRANT SELECT ON TABLE public.public_league_trends_catalog TO %I");
		expect(migration).toContain("CREATE POLICY public_league_trends_catalog_runtime_read");
		expect(migration).toContain("USING (enabled = true)");
		expect(migration).not.toContain(
			"GRANT SELECT ON TABLE public.public_league_trends_catalog TO PUBLIC"
		);
	});
});
