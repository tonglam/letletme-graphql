import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { metrics, registerDatabasePoolMetrics } from "../../src/infra/metrics";

describe("PostgreSQL pool observability", () => {
	it("exports bounded total, idle, and waiting gauges", async () => {
		registerDatabasePoolMetrics(() => ({ total: 5, idle: 3, waiting: 0 }));
		const rendered = await metrics.registry.metrics();
		expect(rendered).toContain('postgres_pool_clients{state="total"} 5');
		expect(rendered).toContain('postgres_pool_clients{state="idle"} 3');
		expect(rendered).toContain('postgres_pool_clients{state="waiting"} 0');
	});

	it("exports the monotonic wait-event metric used by the capacity gate", async () => {
		const rendered = await metrics.registry.metrics();
		const capacitySource = readFileSync(
			new URL("../../scripts/live-match-capacity.ts", import.meta.url),
			"utf8"
		);

		expect(rendered).toContain("postgres_pool_wait_events_total");
		expect(capacitySource).toContain("postgres_pool_wait_events_total");
		expect(capacitySource).toContain("dbPoolWaitEventsZero");
		expect(capacitySource).toContain('session.on("goaway"');
	});
});
