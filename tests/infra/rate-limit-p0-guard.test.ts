import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let directory = "";

const histogram = ({
	slow = false,
	waiting = 0,
	ok = 100,
	graphqlErrors = 0,
	serverErrors = 0,
}: {
	slow?: boolean;
	waiting?: number;
	ok?: number;
	graphqlErrors?: number;
	serverErrors?: number;
} = {}) => `
http_request_duration_seconds_count{method="POST",route="/graphql",status="200"} 100
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="0.5"} ${slow ? 0 : 96}
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="0.8"} ${slow ? 0 : 99}
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="1"} ${slow ? 90 : 100}
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="2"} 100
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="+Inf"} 100
graphql_request_outcomes_total{result="ok"} ${ok}
graphql_request_outcomes_total{result="graphql_error"} ${graphqlErrors}
graphql_request_outcomes_total{result="server_error"} ${serverErrors}
postgres_pool_clients{state="waiting"} ${waiting}
`;

const emptyMetrics = `
http_request_duration_seconds_count{method="POST",route="/graphql",status="200"} 0
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="0.5"} 0
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="0.8"} 0
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="1"} 0
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="2"} 0
http_request_duration_seconds_bucket{method="POST",route="/graphql",status="200",le="+Inf"} 0
graphql_request_outcomes_total{result="ok"} 0
graphql_request_outcomes_total{result="graphql_error"} 0
graphql_request_outcomes_total{result="server_error"} 0
postgres_pool_clients{state="waiting"} 0
`;

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "letletme-p0-guard-"));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

const runGuard = async ({
	current = histogram(),
	state = { badGraphqlErrors: 0, dbWaiting: 0, cpu: 0, memory: 0, samples: 0 },
	healthStatus = 200,
}: {
	current?: string;
	state?: Record<string, number>;
	healthStatus?: number;
} = {}) => {
	const baseline = join(directory, "baseline.prom");
	const previous = join(directory, "previous.prom");
	const currentPath = join(directory, "current.prom");
	const stats = join(directory, "stats.json");
	const statePath = join(directory, "state.json");
	const output = join(directory, "output.json");
	await Promise.all([
		writeFile(baseline, histogram()),
		writeFile(previous, emptyMetrics),
		writeFile(currentPath, current),
		writeFile(stats, JSON.stringify({ CPUPerc: "10.0%", MemPerc: "20.0%" })),
		writeFile(statePath, JSON.stringify(state)),
	]);
	const process = Bun.spawn([
		"python3",
		"scripts/rate_limit_p0_guard.py",
		"--baseline",
		baseline,
		"--previous",
		previous,
		"--current",
		currentPath,
		"--stats",
		stats,
		"--state",
		statePath,
		"--output",
		output,
		"--health-status",
		String(healthStatus),
	]);
	const exitCode = await process.exited;
	return {
		exitCode,
		report: JSON.parse(await readFile(output, "utf8")) as {
			passed: boolean;
			reasons: string[];
			dbWaiting: number;
		},
	};
};

describe("P0 thirty-minute rollout guard", () => {
	it("accepts a healthy sample with complete pool and latency metrics", async () => {
		const result = await runGuard();
		expect(result.exitCode).toBe(0);
		expect(result.report.passed).toBe(true);
	});

	it("fails health and one-second p95 breaches immediately", async () => {
		const result = await runGuard({ current: histogram({ slow: true }), healthStatus: 503 });
		expect(result.exitCode).toBe(1);
		expect(result.report.reasons.join(" ")).toContain("health returned 503");
		expect(result.report.reasons.join(" ")).toContain("p95 exceeded one second");
	});

	it("fails after two consecutive non-zero PostgreSQL waiting samples", async () => {
		const result = await runGuard({
			current: histogram({ waiting: 1 }),
			state: { badGraphqlErrors: 0, dbWaiting: 1, cpu: 0, memory: 0, samples: 1 },
		});
		expect(result.exitCode).toBe(1);
		expect(result.report.dbWaiting).toBe(2);
		expect(result.report.reasons.join(" ")).toContain("two samples");
	});

	it("counts HTTP-200 GraphQL errors in the sustained rollback gate", async () => {
		const result = await runGuard({
			current: histogram({ ok: 90, graphqlErrors: 10 }),
			state: {
				badGraphqlErrors: 9,
				dbWaiting: 0,
				cpu: 0,
				memory: 0,
				samples: 9,
			},
		});
		expect(result.exitCode).toBe(1);
		expect(result.report.reasons.join(" ")).toContain("non-429 GraphQL errors exceeded 1%");
	});
});
