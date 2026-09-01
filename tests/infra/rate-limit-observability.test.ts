import { describe, expect, it } from "bun:test";
import type Redis from "ioredis";
import {
	rateLimitAggregateDate,
	rateLimitAggregateMinute,
	rateLimitFingerprint,
	rateLimitRecentAggregateKey,
	parseRateLimitStorageFailureTotal,
	parseRateLimitTelemetryOverflowTotal,
	rateLimitTelemetryOverflowKey,
	rateLimitTelemetryPersistenceFailureKey,
	enqueueRateLimitAggregate,
	flushRateLimitAggregateTelemetry,
	RATE_LIMIT_TELEMETRY_BATCH_SIZE,
	RATE_LIMIT_TELEMETRY_MAX_QUEUE_SIZE,
	recordRateLimitAggregate,
	readRateLimitTelemetryPersistenceFailureSpool,
	retryRateLimitTelemetryPersistenceFailureMarkers,
	summarizeRateLimitTotals,
} from "../../src/infra/rate-limit-observability";
import { GRAPHQL_REQUEST_OUTCOME_LABELS } from "../../src/infra/metrics";

describe("rate-limit observability privacy", () => {
	it("creates a stable twelve-character HMAC fingerprint", () => {
		const first = rateLimitFingerprint("raw-device-id", "test-secret");
		const second = rateLimitFingerprint("raw-device-id", "test-secret");
		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{12}$/);
		expect(first).not.toContain("raw-device-id");
	});

	it("uses bounded minute keys for recent rollout monitoring", () => {
		const minute = rateLimitAggregateMinute(new Date("2026-08-20T12:34:56.000Z"));
		expect(minute).toBe("2026-08-20T12:34");
		expect(rateLimitRecentAggregateKey(minute)).toBe(
			"llm:gql:rate-limit:v3:recent:2026-08-20T12:34"
		);
		expect(rateLimitRecentAggregateKey(minute, "graphql-v4")).toBe(
			"llm:gql:rate-limit:v4:recent:2026-08-20T12:34"
		);
		expect(rateLimitTelemetryOverflowKey("2026-08-20", "graphql-v4")).toBe(
			"llm:gql:rate-limit:v4:overflow:2026-08-20"
		);
		expect(rateLimitTelemetryPersistenceFailureKey("2026-08-20", "graphql-v4")).toBe(
			"llm:gql:rate-limit:v4:persistence-failure:2026-08-20"
		);
	});

	it("sums every live rate-limit storage failure series", () => {
		expect(
			parseRateLimitStorageFailureTotal(`
# HELP rate_limit_storage_failures_total Rate-limit storage failures
# TYPE rate_limit_storage_failures_total counter
rate_limit_storage_failures_total{scope="global-request",mode="open"} 2
rate_limit_storage_failures_total{scope="mini-ip-abuse-request",mode="open"} 1
rate_limit_storage_failures_total{scope="service-weighted",mode="closed"} 3
`)
		).toBe(6);
		expect(() =>
			parseRateLimitStorageFailureTotal(
				'rate_limit_storage_failures_total{scope="global-request",mode="open"} invalid'
			)
		).toThrow("Invalid rate-limit storage failure metric value");
	});

	it("sums live rate-limit telemetry overflow series", () => {
		expect(
			parseRateLimitTelemetryOverflowTotal(`
# HELP rate_limit_telemetry_overflows_total Dropped aggregate telemetry
# TYPE rate_limit_telemetry_overflows_total counter
rate_limit_telemetry_overflows_total{policy="graphql-v3"} 2
rate_limit_telemetry_overflows_total{policy="graphql-v4"} 3
`)
		).toBe(5);
		expect(() =>
			parseRateLimitTelemetryOverflowTotal(
				'rate_limit_telemetry_overflows_total{policy="graphql-v3"} invalid'
			)
		).toThrow("Invalid rate-limit telemetry overflow metric value");
	});

	it("stores only controlled dimensions and denied fingerprints", async () => {
		const commands: unknown[][] = [];
		const pipeline = {
			hincrby: (...args: unknown[]) => commands.push(["hincrby", ...args]),
			expire: (...args: unknown[]) => commands.push(["expire", ...args]),
			zincrby: (...args: unknown[]) => commands.push(["zincrby", ...args]),
			exec: async () => commands.map(() => [null, 1]),
		};
		const redis = { pipeline: () => pipeline } as unknown as Redis;
		await recordRateLimitAggregate({
			redis,
			trafficClass: "mini",
			workload: "market",
			scope: "client",
			outcome: "denied",
			fingerprint: "abc123abc123",
			date: new Date("2026-08-20T00:00:00.000Z"),
			logger: { warn: () => undefined } as never,
		});
		const serialized = JSON.stringify(commands);
		expect(serialized).toContain("mini|market|client|denied");
		expect(serialized).toContain("llm:gql:rate-limit:v3:recent:2026-08-20T00:00");
		expect(serialized).toContain("abc123abc123");
		expect(serialized).not.toContain("raw-device-id");
	});

	it("does not create a fingerprint ranking for allowed traffic", async () => {
		const commands: unknown[][] = [];
		const pipeline = {
			hincrby: (...args: unknown[]) => commands.push(["hincrby", ...args]),
			expire: (...args: unknown[]) => commands.push(["expire", ...args]),
			zincrby: (...args: unknown[]) => commands.push(["zincrby", ...args]),
			exec: async () => commands.map(() => [null, 1]),
		};
		await recordRateLimitAggregate({
			redis: { pipeline: () => pipeline } as unknown as Redis,
			trafficClass: "web_rsc",
			workload: "fixtures",
			scope: "workload",
			outcome: "allowed",
			fingerprint: "abc123abc123",
			logger: { warn: () => undefined } as never,
		});
		expect(commands.some(([command]) => command === "zincrby")).toBe(false);
	});

	it("batches request telemetry and flushes the remainder without changing admission", async () => {
		const pipelines: unknown[][] = [];
		const redis = {
			pipeline: () => {
				const commands: unknown[] = [];
				pipelines.push(commands);
				return {
					hincrby: (...args: unknown[]) => commands.push(["hincrby", ...args]),
					expire: (...args: unknown[]) => commands.push(["expire", ...args]),
					zincrby: (...args: unknown[]) => commands.push(["zincrby", ...args]),
					exec: async () => commands.map(() => [null, 1]),
				};
			},
		} as unknown as Redis;
		const count = RATE_LIMIT_TELEMETRY_BATCH_SIZE + 1;
		for (let index = 0; index < count; index += 1) {
			enqueueRateLimitAggregate({
				redis,
				trafficClass: "web_rsc",
				workload: "fixtures",
				scope: "workload",
				outcome: "allowed",
				fingerprint: "abc123abc123",
				date: new Date("2026-08-20T00:00:00.000Z"),
				logger: { warn: () => undefined } as never,
			});
		}
		await flushRateLimitAggregateTelemetry();

		expect(pipelines.length).toBe(2);
		expect(pipelines.reduce((total, commands) => total + commands.length, 0)).toBe(count * 4);
	});

	it("exports GraphQL outcomes with only one controlled result dimension", () => {
		expect(GRAPHQL_REQUEST_OUTCOME_LABELS).toEqual(["result"]);
	});

	it("waits for an overflow marker during bounded shutdown flush", async () => {
		let releasePipeline!: () => void;
		let releaseMarker!: () => void;
		const pipelineBlocked = new Promise<void>((resolve) => {
			releasePipeline = resolve;
		});
		const markerBlocked = new Promise<"OK">((resolve) => {
			releaseMarker = () => resolve("OK");
		});
		const pipeline = {
			hincrby: () => pipeline,
			expire: () => pipeline,
			zincrby: () => pipeline,
			exec: () => pipelineBlocked,
		};
		const redis = {
			pipeline: () => pipeline,
			set: () => markerBlocked,
		} as unknown as Redis;
		for (let index = 0; index <= RATE_LIMIT_TELEMETRY_MAX_QUEUE_SIZE; index += 1) {
			enqueueRateLimitAggregate({
				redis,
				trafficClass: "web_rsc",
				workload: "fixtures",
				scope: "workload",
				outcome: "allowed",
				fingerprint: "abc123abc123",
				logger: { warn: () => undefined } as never,
			});
		}

		await expect(flushRateLimitAggregateTelemetry(10)).rejects.toThrow(
			"rate-limit telemetry flush timed out"
		);
		releaseMarker();
		releasePipeline();
		await flushRateLimitAggregateTelemetry(100);
	});

	it("reports enforced and shadow rollout alarms independently", () => {
		const summary = summarizeRateLimitTotals(
			new Map([
				["mini|market|workload|allowed", 90],
				["mini|market|workload|denied", 10],
				["mini|market|workload|would_allow", 60],
				["mini|market|workload|would_deny", 40],
				["mini|market|global|would_deny", 2],
			])
		);
		expect(summary.interactiveDeniedRate).toBe(0.1);
		expect(summary.totalDecisions).toBe(202);
		expect(summary.v3Decisions).toBe(202);
		expect(summary.enforcedDecisions).toBe(100);
		expect(summary.shadowDecisions).toBe(102);
		expect(summary.shadowInteractiveDeniedRate).toBe(42 / 102);
		expect(summary.globalDenied).toBe(0);
		expect(summary.globalWouldDenied).toBe(2);
		expect(summary.miniWorkloadShadowDeniedRate.market).toBe(40 / 100);
	});

	it("does not treat unknown outcome labels as rollout evidence", () => {
		const summary = summarizeRateLimitTotals(
			new Map([
				["mini|market|client|removed_allowed", 90],
				["mini|market|client|removed_denied", 10],
			])
		);
		expect(summary.totalDecisions).toBe(100);
		expect(summary.v3Decisions).toBe(0);
		expect(summary.enforcedDecisions).toBe(0);
		expect(summary.shadowDecisions).toBe(0);
	});

	it("reports enforced v3 decisions separately from shadow decisions", () => {
		const summary = summarizeRateLimitTotals(
			new Map([
				["web_rsc|fixtures|workload|allowed", 9],
				["web_rsc|fixtures|workload|denied", 1],
			])
		);
		expect(summary.v3Decisions).toBe(10);
		expect(summary.enforcedDecisions).toBe(10);
		expect(summary.shadowDecisions).toBe(0);
	});

	it("fails shutdown when telemetry persistence rejects before the bound", async () => {
		let markerArguments: unknown[] | null = null;
		const date = new Date("2026-08-20T00:00:00.000Z");
		const pipeline = {
			hincrby: () => pipeline,
			expire: () => pipeline,
			zincrby: () => pipeline,
			exec: async () => {
				throw new Error("redis unavailable");
			},
		};
		enqueueRateLimitAggregate({
			redis: {
				pipeline: () => pipeline,
				set: (...args: unknown[]) => {
					markerArguments = args;
					return Promise.resolve("OK");
				},
			} as unknown as Redis,
			trafficClass: "web_rsc",
			workload: "fixtures",
			scope: "workload",
			outcome: "allowed",
			fingerprint: "abc123abc123",
			date,
			logger: { warn: () => undefined } as never,
		});

		await expect(flushRateLimitAggregateTelemetry(100)).rejects.toThrow(
			"rate-limit telemetry persistence failed"
		);
		expect(markerArguments?.[0] as string | undefined).toBe(
			rateLimitTelemetryPersistenceFailureKey(rateLimitAggregateDate(date))
		);
	});

	it("retains a failed marker across restart and retries it after Redis recovers", async () => {
		const date = new Date("2026-08-21T00:00:00.000Z");
		let markerAttempts = 0;
		const pipeline = {
			hincrby: () => pipeline,
			expire: () => pipeline,
			zincrby: () => pipeline,
			exec: async () => {
				throw new Error("redis unavailable");
			},
		};
		const redis = {
			pipeline: () => pipeline,
			set: () => {
				markerAttempts += 1;
				return markerAttempts === 1
					? Promise.reject(new Error("redis unavailable"))
					: Promise.resolve("OK");
			},
		} as unknown as Redis;

		enqueueRateLimitAggregate({
			redis,
			trafficClass: "web_rsc",
			workload: "fixtures",
			scope: "workload",
			outcome: "allowed",
			fingerprint: "abc123abc123",
			date,
			logger: { warn: () => undefined } as never,
		});
		await expect(flushRateLimitAggregateTelemetry(100)).rejects.toThrow(
			"rate-limit telemetry persistence failed"
		);

		expect(
			await readRateLimitTelemetryPersistenceFailureSpool("graphql-v3", ["2026-08-21"])
		).toEqual(["2026-08-21"]);
		await expect(
			retryRateLimitTelemetryPersistenceFailureMarkers({
				redis,
				policyVersion: "graphql-v3",
				dates: ["2026-08-21"],
			})
		).resolves.toEqual([]);
		expect(markerAttempts).toBe(2);
		expect(
			await readRateLimitTelemetryPersistenceFailureSpool("graphql-v3", ["2026-08-21"])
		).toEqual([]);
	});

	it("fails a shutdown flush when telemetry persistence exceeds its bound", async () => {
		const pipeline = {
			hincrby: () => pipeline,
			expire: () => pipeline,
			zincrby: () => pipeline,
			exec: () => new Promise<never>(() => undefined),
		};
		enqueueRateLimitAggregate({
			redis: { pipeline: () => pipeline } as unknown as Redis,
			trafficClass: "web_rsc",
			workload: "fixtures",
			scope: "workload",
			outcome: "allowed",
			fingerprint: "abc123abc123",
			logger: { warn: () => undefined } as never,
		});

		await expect(flushRateLimitAggregateTelemetry(10)).rejects.toThrow(
			"rate-limit telemetry flush timed out"
		);
	});
});
