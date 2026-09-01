import { describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	rateLimitTelemetryDirtyWindowKey,
	rateLimitTelemetryServingProcessIdentityFile,
	enqueueRateLimitAggregate,
	flushRateLimitAggregateTelemetry,
	RATE_LIMIT_TELEMETRY_BATCH_SIZE,
	RATE_LIMIT_TELEMETRY_MAX_QUEUE_SIZE,
	RATE_LIMIT_TELEMETRY_SERVING_PROCESS_LEASE_MS,
	recordRateLimitAggregate,
	readRateLimitTelemetryOverflowSpool,
	readRateLimitTelemetryPersistenceFailureSpool,
	readRateLimitTelemetryDirtyWindowSpool,
	retryRateLimitTelemetryOverflowMarkers,
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
		expect(rateLimitTelemetryDirtyWindowKey("2026-08-20", "graphql-v4")).toBe(
			"llm:gql:rate-limit:v4:dirty-window:2026-08-20"
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
		const date = new Date("2026-08-22T00:00:00.000Z");
		const dateText = rateLimitAggregateDate(date);
		let releasePipeline!: () => void;
		let releaseMarker!: () => void;
		let observeSpool!: (value: boolean) => void;
		const pipelineBlocked = new Promise<void>((resolve) => {
			releasePipeline = resolve;
		});
		const markerSawSpool = new Promise<boolean>((resolve) => {
			observeSpool = resolve;
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
			set: async () => {
				observeSpool(
					(await readRateLimitTelemetryOverflowSpool("graphql-v3", [dateText])).includes(dateText)
				);
				return markerBlocked;
			},
		} as unknown as Redis;
		for (
			let index = 0;
			index <= RATE_LIMIT_TELEMETRY_MAX_QUEUE_SIZE + RATE_LIMIT_TELEMETRY_BATCH_SIZE;
			index += 1
		) {
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
		}

		await expect(markerSawSpool).resolves.toBe(true);
		await expect(flushRateLimitAggregateTelemetry(10)).rejects.toThrow(
			"rate-limit telemetry flush timed out"
		);
		releaseMarker();
		releasePipeline();
		await flushRateLimitAggregateTelemetry(100);
		expect(await readRateLimitTelemetryOverflowSpool("graphql-v3", [dateText])).toEqual([]);
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

	it("ignores active dirty windows but reports orphaned process markers", async () => {
		const date = "2026-08-24";
		const spoolDirectory =
			process.env.RATE_LIMIT_TELEMETRY_SPOOL_DIR ??
			join(tmpdir(), `letletme-graphql-rate-limit-${process.pid}`);
		const orphanPath = join(spoolDirectory, `dirty.v3.${date}.2147483647.orphan-test`);
		const reusedPidPath = join(
			spoolDirectory,
			`dirty.v3.${date}.${process.pid}.previous-generation`
		);
		await mkdir(spoolDirectory, { recursive: true });
		await writeFile(orphanPath, "orphan\n", { encoding: "utf8" });
		await writeFile(reusedPidPath, "previous container\n", { encoding: "utf8" });
		try {
			const redis = {
				pipeline: () => ({
					hincrby: () => undefined,
					expire: () => undefined,
					zincrby: () => undefined,
					exec: async () => [],
				}),
			} as unknown as Redis;
			enqueueRateLimitAggregate({
				redis,
				trafficClass: "web_rsc",
				workload: "fixtures",
				scope: "workload",
				outcome: "allowed",
				fingerprint: "abc123abc123",
				date: new Date("2026-08-25T00:00:00.000Z"),
				logger: { warn: () => undefined } as never,
			});
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", ["2026-08-25"])).toEqual(
				[]
			);
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", [date])).toEqual([date]);
			await flushRateLimitAggregateTelemetry();
		} finally {
			await unlink(orphanPath).catch(() => undefined);
			await unlink(reusedPidPath).catch(() => undefined);
		}
	});

	it("uses the serving process identity when a report process reuses its PID", async () => {
		const activeDate = "2099-01-03";
		const orphanedDate = "2099-01-04";
		const servingGeneration = "serving-generation";
		const spoolDirectory =
			process.env.RATE_LIMIT_TELEMETRY_SPOOL_DIR ??
			join(tmpdir(), `letletme-graphql-rate-limit-${process.pid}`);
		const activePath = join(
			spoolDirectory,
			`dirty.v3.${activeDate}.${process.pid}.${servingGeneration}`
		);
		const orphanedPath = join(
			spoolDirectory,
			`dirty.v3.${orphanedDate}.${process.pid}.old-serving-generation`
		);
		let previousIdentity: string | null = null;
		try {
			previousIdentity = await readFile(rateLimitTelemetryServingProcessIdentityFile, {
				encoding: "utf8",
			});
		} catch {
			// This test process normally has no serving identity; restore that
			// absence after the isolated report-process simulation.
		}
		await mkdir(spoolDirectory, { recursive: true });
		await writeFile(
			rateLimitTelemetryServingProcessIdentityFile,
			JSON.stringify({
				pid: process.pid,
				generation: servingGeneration,
				heartbeatAt: new Date().toISOString(),
			}) + "\n",
			{ encoding: "utf8" }
		);
		await writeFile(activePath, "active\n", { encoding: "utf8" });
		await writeFile(orphanedPath, "orphaned\n", { encoding: "utf8" });
		try {
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", [activeDate])).toEqual([]);
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", [orphanedDate])).toEqual([
				orphanedDate,
			]);
		} finally {
			await unlink(activePath).catch(() => undefined);
			await unlink(orphanedPath).catch(() => undefined);
			if (previousIdentity === null) {
				await unlink(rateLimitTelemetryServingProcessIdentityFile).catch(() => undefined);
			} else {
				await writeFile(rateLimitTelemetryServingProcessIdentityFile, previousIdentity, {
					encoding: "utf8",
				});
			}
		}
	});

	it("keeps dirty markers owned by either blue/green serving process", async () => {
		const spoolDirectory =
			process.env.RATE_LIMIT_TELEMETRY_SPOOL_DIR ??
			join(tmpdir(), `letletme-graphql-rate-limit-${process.pid}`);
		const blueGeneration = "blue-serving-generation";
		const greenGeneration = "green-serving-generation";
		const blueIdentityPath = join(spoolDirectory, "serving-process.blue.json");
		const greenIdentityPath = join(spoolDirectory, "serving-process.green.json");
		const blueDate = "2099-02-01";
		const greenDate = "2099-02-02";
		const orphanDate = "2099-02-03";
		const markerPath = (date: string, generation: string) =>
			join(spoolDirectory, `dirty.v3.${date}.${process.pid}.${generation}`);
		await mkdir(spoolDirectory, { recursive: true });
		await writeFile(
			blueIdentityPath,
			JSON.stringify({
				pid: process.pid,
				generation: blueGeneration,
				heartbeatAt: new Date().toISOString(),
			}) + "\n",
			{ encoding: "utf8" }
		);
		await writeFile(
			greenIdentityPath,
			JSON.stringify({
				pid: process.pid,
				generation: greenGeneration,
				heartbeatAt: new Date().toISOString(),
			}) + "\n",
			{ encoding: "utf8" }
		);
		const markerPaths = [
			markerPath(blueDate, blueGeneration),
			markerPath(greenDate, greenGeneration),
			markerPath(orphanDate, "old-serving-generation"),
		];
		await Promise.all(markerPaths.map((path) => writeFile(path, "marker\n", { encoding: "utf8" })));
		try {
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", [blueDate])).toEqual([]);
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", [greenDate])).toEqual([]);
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", [orphanDate])).toEqual([
				orphanDate,
			]);
		} finally {
			await Promise.all([
				unlink(blueIdentityPath).catch(() => undefined),
				unlink(greenIdentityPath).catch(() => undefined),
				...markerPaths.map((path) => unlink(path).catch(() => undefined)),
			]);
		}
	});

	it("does not trust a stale slot lease as a serving process", async () => {
		const spoolDirectory =
			process.env.RATE_LIMIT_TELEMETRY_SPOOL_DIR ??
			join(tmpdir(), `letletme-graphql-rate-limit-${process.pid}`);
		const date = "2099-02-04";
		const generation = "stale-serving-generation";
		const identityPath = join(spoolDirectory, "serving-process.green.json");
		const markerPath = join(spoolDirectory, `dirty.v3.${date}.${process.pid}.${generation}`);
		await mkdir(spoolDirectory, { recursive: true });
		await writeFile(
			identityPath,
			JSON.stringify({
				pid: process.pid,
				generation,
				heartbeatAt: new Date(
					Date.now() - RATE_LIMIT_TELEMETRY_SERVING_PROCESS_LEASE_MS - 1_000
				).toISOString(),
			}) + "\n",
			{ encoding: "utf8" }
		);
		await writeFile(markerPath, "stale\n", { encoding: "utf8" });
		try {
			expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", [date])).toEqual([date]);
		} finally {
			await unlink(identityPath).catch(() => undefined);
			await unlink(markerPath).catch(() => undefined);
		}
	});

	it("retries a dirty-window marker after a transient spool write failure", async () => {
		const spoolDirectory =
			process.env.RATE_LIMIT_TELEMETRY_SPOOL_DIR ??
			join(tmpdir(), `letletme-graphql-rate-limit-${process.pid}`);
		const identityDate = new Date("2099-01-01T00:00:00.000Z");
		const blockedDate = new Date("2099-01-02T00:00:00.000Z");
		const identityDateText = rateLimitAggregateDate(identityDate);
		const blockedDateText = rateLimitAggregateDate(blockedDate);
		const identityPrefix = `dirty.v3.${identityDateText}.${process.pid}.`;
		const blockedPrefix = `dirty.v3.${blockedDateText}.${process.pid}.`;
		await mkdir(spoolDirectory, { recursive: true });
		for (const name of await readdir(spoolDirectory)) {
			if (name.startsWith(identityPrefix) || name.startsWith(blockedPrefix))
				await unlink(join(spoolDirectory, name)).catch(() => undefined);
		}

		const pipeline = {
			hincrby: () => pipeline,
			expire: () => pipeline,
			zincrby: () => pipeline,
			exec: async () => [],
		};
		const redis = { pipeline: () => pipeline } as unknown as Redis;
		const input = {
			redis,
			trafficClass: "web_rsc" as const,
			workload: "fixtures" as const,
			scope: "workload" as const,
			outcome: "allowed" as const,
			fingerprint: "abc123abc123",
			logger: { warn: () => undefined } as never,
		};

		try {
			enqueueRateLimitAggregate({ ...input, date: identityDate });
			const identityMarker = (await readdir(spoolDirectory)).find((name) =>
				name.startsWith(identityPrefix)
			);
			expect(identityMarker).toBeDefined();
			const generation = identityMarker?.slice(identityPrefix.length);
			expect(generation).toMatch(/^[A-Za-z0-9-]+$/);
			await flushRateLimitAggregateTelemetry();

			const blockedPath = join(spoolDirectory, `${blockedPrefix}${generation}`);
			await mkdir(blockedPath);
			enqueueRateLimitAggregate({ ...input, date: blockedDate });
			await rmdir(blockedPath);
			enqueueRateLimitAggregate({ ...input, date: blockedDate });

			expect(await readFile(blockedPath, { encoding: "utf8" })).toContain(
				rateLimitTelemetryDirtyWindowKey(blockedDateText)
			);
			await expect(flushRateLimitAggregateTelemetry()).rejects.toThrow(
				"rate-limit telemetry persistence failed"
			);
			await expect(readFile(blockedPath, { encoding: "utf8" })).rejects.toThrow();
		} finally {
			for (const name of await readdir(spoolDirectory).catch(() => [] as string[])) {
				if (name.startsWith(identityPrefix) || name.startsWith(blockedPrefix)) {
					await unlink(join(spoolDirectory, name)).catch(() => undefined);
				}
			}
		}
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
		expect(await readRateLimitTelemetryDirtyWindowSpool("graphql-v3", ["2026-08-20"])).toEqual([]);
		expect(
			await readRateLimitTelemetryPersistenceFailureSpool("graphql-v3", ["2026-08-20"])
		).toEqual([]);
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

	it("retains an overflow marker before Redis and retries it after recovery", async () => {
		const date = new Date("2026-08-23T00:00:00.000Z");
		const dateText = rateLimitAggregateDate(date);
		let releasePipeline!: () => void;
		let markerAttempts = 0;
		let observeSpool!: (value: boolean) => void;
		const pipelineBlocked = new Promise<void>((resolve) => {
			releasePipeline = resolve;
		});
		const markerSawSpool = new Promise<boolean>((resolve) => {
			observeSpool = resolve;
		});
		const pipeline = {
			hincrby: () => pipeline,
			expire: () => pipeline,
			zincrby: () => pipeline,
			exec: () => pipelineBlocked,
		};
		const redis = {
			pipeline: () => pipeline,
			set: async () => {
				observeSpool(
					(await readRateLimitTelemetryOverflowSpool("graphql-v3", [dateText])).includes(dateText)
				);
				markerAttempts += 1;
				if (markerAttempts === 1) throw new Error("redis unavailable");
				return "OK";
			},
		} as unknown as Redis;

		for (
			let index = 0;
			index <= RATE_LIMIT_TELEMETRY_MAX_QUEUE_SIZE + RATE_LIMIT_TELEMETRY_BATCH_SIZE;
			index += 1
		) {
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
		}

		await expect(markerSawSpool).resolves.toBe(true);
		await expect(flushRateLimitAggregateTelemetry(10)).rejects.toThrow(
			"rate-limit telemetry flush timed out"
		);
		expect(await readRateLimitTelemetryOverflowSpool("graphql-v3", [dateText])).toEqual([dateText]);

		releasePipeline();
		await expect(flushRateLimitAggregateTelemetry(100)).rejects.toThrow(
			"rate-limit telemetry persistence failed"
		);
		await expect(
			retryRateLimitTelemetryOverflowMarkers({
				redis,
				policyVersion: "graphql-v3",
				dates: [dateText],
			})
		).resolves.toEqual([]);
		expect(markerAttempts).toBe(2);
		expect(await readRateLimitTelemetryOverflowSpool("graphql-v3", [dateText])).toEqual([]);
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
