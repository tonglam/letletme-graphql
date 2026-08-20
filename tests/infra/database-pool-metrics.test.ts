import { describe, expect, it } from "bun:test";
import { metrics, registerDatabasePoolMetrics } from "../../src/infra/metrics";

describe("PostgreSQL pool observability", () => {
	it("exports bounded total, idle, and waiting gauges", async () => {
		registerDatabasePoolMetrics(() => ({ total: 5, idle: 3, waiting: 0 }));
		const rendered = await metrics.registry.metrics();
		expect(rendered).toContain('postgres_pool_clients{state="total"} 5');
		expect(rendered).toContain('postgres_pool_clients{state="idle"} 3');
		expect(rendered).toContain('postgres_pool_clients{state="waiting"} 0');
	});
});
