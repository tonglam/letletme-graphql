import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("market player search migration", () => {
	it("keeps search server-filtered, bounded, and service-role only", () => {
		const migration = readFileSync(
			"migrations/forward/202608030001_market_player_search.sql",
			"utf8"
		);

		expect(migration).toContain("strpos(lower(player.web_name), lower(trim(p_query))) > 0");
		expect(migration).toContain("LEAST(p_limit, 50)");
		expect(migration).toContain("SECURITY INVOKER");
		expect(migration).toContain("REVOKE ALL ON FUNCTION");
		expect(migration).toContain("TO service_role");
	});
});
