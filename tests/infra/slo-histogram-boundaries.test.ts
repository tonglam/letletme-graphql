import { afterEach, describe, expect, it } from "bun:test";
import type { Histogram } from "prom-client";
import { metrics } from "../../src/infra/metrics";

const scenarios: Array<{
	name: string;
	metric: Histogram<string>;
	labels: Record<string, string>;
	warning: number;
	critical: number;
	values: number[];
}> = [
	{
		name: "HTTP request duration",
		metric: metrics.httpRequestDurationSeconds,
		labels: { method: "POST", route: "/graphql", status: "200" },
		warning: 0.8,
		critical: 1,
		values: [0.799, 0.8, 0.861, 0.999, 1, 1.1],
	},
	{
		name: "HEAD read duration",
		metric: metrics.liveMatchReadDurationSeconds,
		labels: { view: "HEAD", source: "REDIS_CURRENT" },
		warning: 0.05,
		critical: 0.1,
		values: [0.049, 0.05, 0.099, 0.1, 0.2],
	},
	{
		name: "FULL read duration",
		metric: metrics.liveMatchReadDurationSeconds,
		labels: { view: "FULL", source: "REDIS_CURRENT" },
		warning: 0.15,
		critical: 0.25,
		values: [0.149, 0.15, 0.249, 0.25, 0.5],
	},
	{
		name: "HEAD payload bytes",
		metric: metrics.liveMatchPayloadBytes,
		labels: { view: "HEAD", stage: "resolver" },
		warning: 3072,
		critical: 4096,
		values: [1279, 3071, 3072, 4095, 4096, 5000],
	},
	{
		name: "FULL payload bytes",
		metric: metrics.liveMatchPayloadBytes,
		labels: { view: "FULL", stage: "resolver" },
		warning: 92160,
		critical: 131072,
		values: [70000, 92159, 92160, 131071, 131072, 200000],
	},
];

afterEach(() => {
	for (const scenario of scenarios) scenario.metric.reset();
});

const severity = (value: number, warning: number, critical: number) =>
	value >= critical ? "critical" : value >= warning ? "warning" : "ok";

describe("SLO histogram boundaries", () => {
	for (const scenario of scenarios) {
		for (const value of scenario.values) {
			it(`${scenario.name}: ${value} keeps its severity after p95 bucket projection`, async () => {
				scenario.metric.reset();
				for (let count = 0; count < 100; count++) {
					scenario.metric.labels(scenario.labels).observe(value);
				}
				const sample = await scenario.metric.get();
				const buckets = sample.values
					.filter((row) => row.labels.le !== undefined)
					.map((row) => ({ upper: Number(row.labels.le), count: row.value }))
					.sort((left, right) => left.upper - right.upper);
				// Ops selects the first cumulative bucket covering the 95th
				// sample. Exercise that actual projection, not just bucket presence.
				const p95 = buckets.find((bucket) => bucket.count >= 95)?.upper;
				expect(p95).toBeDefined();
				expect(severity(p95!, scenario.warning, scenario.critical)).toBe(
					severity(value, scenario.warning, scenario.critical)
				);
			});
		}
	}
});
