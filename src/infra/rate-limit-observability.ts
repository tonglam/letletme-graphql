import { createHmac } from "crypto";
import type Redis from "ioredis";
import type { Logger } from "./logger";
import type { GraphQLTrafficClass, GraphQLWorkload } from "./ingress-context";
import type { GraphQLRateLimitHeaderScope } from "../http/token-bucket-v3";
import { env } from "./env";
import { metrics } from "./metrics";

export const RATE_LIMIT_AGGREGATE_RETENTION_SECONDS = 14 * 24 * 60 * 60;
export const RATE_LIMIT_RECENT_RETENTION_SECONDS = 2 * 60 * 60;
export const RATE_LIMIT_TELEMETRY_FLUSH_INTERVAL_MS = 250;
export const RATE_LIMIT_TELEMETRY_BATCH_SIZE = 256;
export const RATE_LIMIT_TELEMETRY_MAX_QUEUE_SIZE = 4096;
export const RATE_LIMIT_TELEMETRY_SHUTDOWN_TIMEOUT_MS = 500;

export type RateLimitAggregateOutcome = "allowed" | "denied" | "would_allow" | "would_deny";

export type GraphQLRateLimitPolicyVersion = "graphql-v3" | "graphql-v4";

type RateLimitAggregateRecord = Readonly<{
	redis: Redis;
	trafficClass: GraphQLTrafficClass;
	workload: GraphQLWorkload;
	scope: GraphQLRateLimitHeaderScope;
	outcome: RateLimitAggregateOutcome;
	fingerprint: string;
	policyVersion: GraphQLRateLimitPolicyVersion;
	date: Date;
	logger: Logger;
}>;

const deniedOutcomes = new Set<RateLimitAggregateOutcome>(["denied", "would_deny"]);

export const rateLimitFingerprint = (
	subject: string | null,
	secret = env.BACKEND_PROXY_SECRET
): string =>
	createHmac("sha256", secret)
		.update(subject ?? "missing-subject")
		.digest("hex")
		.slice(0, 12);

export const rateLimitAggregateDate = (date = new Date()): string =>
	date.toISOString().slice(0, 10);

const policyNamespace = (policyVersion: GraphQLRateLimitPolicyVersion): "v3" | "v4" =>
	policyVersion === "graphql-v4" ? "v4" : "v3";

export const rateLimitAggregateKey = (
	date: string,
	policyVersion: GraphQLRateLimitPolicyVersion = "graphql-v3"
): string => `llm:gql:rate-limit:${policyNamespace(policyVersion)}:aggregate:${date}`;

export const rateLimitDeniedRankingKey = (
	date: string,
	policyVersion: GraphQLRateLimitPolicyVersion = "graphql-v3"
): string => `llm:gql:rate-limit:${policyNamespace(policyVersion)}:denied:${date}`;

export const rateLimitAggregateMinute = (date = new Date()): string =>
	date.toISOString().slice(0, 16);

export const rateLimitRecentAggregateKey = (
	minute: string,
	policyVersion: GraphQLRateLimitPolicyVersion = "graphql-v3"
): string => `llm:gql:rate-limit:${policyNamespace(policyVersion)}:recent:${minute}`;

/** Durable marker for telemetry dropped by a full in-process queue. */
export const rateLimitTelemetryOverflowKey = (
	date: string,
	policyVersion: GraphQLRateLimitPolicyVersion = "graphql-v3"
): string => `llm:gql:rate-limit:${policyNamespace(policyVersion)}:overflow:${date}`;

export type RateLimitReportSummary = {
	totalDecisions: number;
	v3Decisions: number;
	enforcedDecisions: number;
	shadowDecisions: number;
	interactiveAllowed: number;
	interactiveDenied: number;
	interactiveDeniedRate: number;
	shadowInteractiveAllowed: number;
	shadowInteractiveDenied: number;
	shadowInteractiveDeniedRate: number;
	globalDenied: number;
	globalWouldDenied: number;
	miniWorkloadAllowed: Record<GraphQLWorkload, number>;
	miniWorkloadDenied: Record<GraphQLWorkload, number>;
	miniWorkloadShadowAllowed: Record<GraphQLWorkload, number>;
	miniWorkloadShadowDenied: Record<GraphQLWorkload, number>;
	miniWorkloadDeniedRate: Record<GraphQLWorkload, number>;
	miniWorkloadShadowDeniedRate: Record<GraphQLWorkload, number>;
};

export const parseRateLimitStorageFailureTotal = (metricsText: string): number => {
	let total = 0;
	for (const line of metricsText.split("\n")) {
		if (!/^rate_limit_storage_failures_total(?:\{|\s)/.test(line)) continue;
		const match = line.match(
			/^rate_limit_storage_failures_total(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/
		);
		if (!match) throw new Error("Malformed rate-limit storage failure metric");
		const value = Number(match[1]);
		if (!Number.isFinite(value) || value < 0) {
			throw new Error("Invalid rate-limit storage failure metric value");
		}
		total += value;
	}
	return total;
};

export const parseRateLimitTelemetryOverflowTotal = (metricsText: string): number => {
	let total = 0;
	for (const line of metricsText.split("\n")) {
		if (!/^rate_limit_telemetry_overflows_total(?:\{|\s)/.test(line)) continue;
		const match = line.match(
			/^rate_limit_telemetry_overflows_total(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/
		);
		if (!match) throw new Error("Malformed rate-limit telemetry overflow metric");
		const value = Number(match[1]);
		if (!Number.isFinite(value) || value < 0) {
			throw new Error("Invalid rate-limit telemetry overflow metric value");
		}
		total += value;
	}
	return total;
};

export const summarizeRateLimitTotals = (
	totals: ReadonlyMap<string, number>
): RateLimitReportSummary => {
	const workloads = [
		"interactive",
		"home",
		"fixtures",
		"market",
		"player-stats",
		"gameweek",
		"public-other",
	] as const satisfies readonly GraphQLWorkload[];
	const miniWorkloadAllowed = Object.fromEntries(
		workloads.map((workload) => [workload, 0])
	) as Record<GraphQLWorkload, number>;
	const miniWorkloadDenied = Object.fromEntries(
		workloads.map((workload) => [workload, 0])
	) as Record<GraphQLWorkload, number>;
	const miniWorkloadShadowAllowed = Object.fromEntries(
		workloads.map((workload) => [workload, 0])
	) as Record<GraphQLWorkload, number>;
	const miniWorkloadShadowDenied = Object.fromEntries(
		workloads.map((workload) => [workload, 0])
	) as Record<GraphQLWorkload, number>;
	let totalDecisions = 0;
	let enforcedDecisions = 0;
	let shadowDecisions = 0;
	let interactiveAllowed = 0;
	let interactiveDenied = 0;
	let shadowInteractiveAllowed = 0;
	let shadowInteractiveDenied = 0;
	let globalDenied = 0;
	let globalWouldDenied = 0;
	for (const [key, count] of totals) {
		const [trafficClass, workload, scope, outcome] = key.split("|");
		if (
			trafficClass === "mini" &&
			scope === "workload" &&
			workloads.includes(workload as GraphQLWorkload)
		) {
			const miniWorkload = workload as GraphQLWorkload;
			if (outcome === "allowed") miniWorkloadAllowed[miniWorkload] += count;
			if (outcome === "denied") miniWorkloadDenied[miniWorkload] += count;
			if (outcome === "would_allow") miniWorkloadShadowAllowed[miniWorkload] += count;
			if (outcome === "would_deny") miniWorkloadShadowDenied[miniWorkload] += count;
		}
		const interactive =
			trafficClass === "mini" || trafficClass === "web_browser" || workload === "interactive";
		totalDecisions += count;
		if (outcome === "allowed" || outcome === "denied") enforcedDecisions += count;
		if (outcome === "would_allow" || outcome === "would_deny") shadowDecisions += count;
		if (interactive && outcome === "allowed") {
			interactiveAllowed += count;
		}
		if (interactive && outcome === "denied") {
			interactiveDenied += count;
		}
		if (interactive && outcome === "would_allow") shadowInteractiveAllowed += count;
		if (interactive && outcome === "would_deny") shadowInteractiveDenied += count;
		if (scope === "global" && outcome === "denied") {
			globalDenied += count;
		}
		if (scope === "global" && outcome === "would_deny") globalWouldDenied += count;
	}
	const interactiveTotal = interactiveAllowed + interactiveDenied;
	const shadowInteractiveTotal = shadowInteractiveAllowed + shadowInteractiveDenied;
	const ratio = (allowed: number, denied: number): number => {
		const total = allowed + denied;
		return total === 0 ? 0 : denied / total;
	};
	return {
		totalDecisions,
		v3Decisions: enforcedDecisions + shadowDecisions,
		enforcedDecisions,
		shadowDecisions,
		interactiveAllowed,
		interactiveDenied,
		interactiveDeniedRate: interactiveTotal === 0 ? 0 : interactiveDenied / interactiveTotal,
		shadowInteractiveAllowed,
		shadowInteractiveDenied,
		shadowInteractiveDeniedRate:
			shadowInteractiveTotal === 0 ? 0 : shadowInteractiveDenied / shadowInteractiveTotal,
		globalDenied,
		globalWouldDenied,
		miniWorkloadAllowed,
		miniWorkloadDenied,
		miniWorkloadShadowAllowed,
		miniWorkloadShadowDenied,
		miniWorkloadDeniedRate: Object.fromEntries(
			workloads.map((workload) => [
				workload,
				ratio(miniWorkloadAllowed[workload], miniWorkloadDenied[workload]),
			])
		) as Record<GraphQLWorkload, number>,
		miniWorkloadShadowDeniedRate: Object.fromEntries(
			workloads.map((workload) => [
				workload,
				ratio(miniWorkloadShadowAllowed[workload], miniWorkloadShadowDenied[workload]),
			])
		) as Record<GraphQLWorkload, number>,
	};
};

const persistRateLimitAggregateBatch = async (
	records: readonly RateLimitAggregateRecord[]
): Promise<void> => {
	const byRedis = new Map<Redis, RateLimitAggregateRecord[]>();
	for (const record of records) {
		const group = byRedis.get(record.redis);
		if (group) group.push(record);
		else byRedis.set(record.redis, [record]);
	}
	await Promise.all(
		[...byRedis.entries()].map(async ([redis, group]) => {
			const failedPolicies = new Set<GraphQLRateLimitPolicyVersion>();
			try {
				const pipeline = redis.pipeline();
				for (const record of group) {
					const day = rateLimitAggregateDate(record.date);
					const aggregateKey = rateLimitAggregateKey(day, record.policyVersion);
					const recentKey = rateLimitRecentAggregateKey(
						rateLimitAggregateMinute(record.date),
						record.policyVersion
					);
					const field = [record.trafficClass, record.workload, record.scope, record.outcome].join(
						"|"
					);
					pipeline.hincrby(aggregateKey, field, 1);
					pipeline.expire(aggregateKey, RATE_LIMIT_AGGREGATE_RETENTION_SECONDS);
					pipeline.hincrby(recentKey, field, 1);
					pipeline.expire(recentKey, RATE_LIMIT_RECENT_RETENTION_SECONDS);
					if (deniedOutcomes.has(record.outcome)) {
						const rankingKey = rateLimitDeniedRankingKey(day, record.policyVersion);
						pipeline.zincrby(
							rankingKey,
							1,
							[
								record.trafficClass,
								record.workload,
								record.scope,
								record.outcome,
								record.fingerprint,
							].join("|")
						);
						pipeline.expire(rankingKey, RATE_LIMIT_AGGREGATE_RETENTION_SECONDS);
					}
				}
				const results = await pipeline.exec();
				const failure = results?.find(([error]) => error);
				if (failure?.[0]) throw failure[0];
			} catch (error) {
				for (const record of group) failedPolicies.add(record.policyVersion);
				for (const policyVersion of failedPolicies) {
					metrics.rateLimitStorageFailures.labels(`${policyVersion}-aggregate`, "open").inc();
				}
				group[0]?.logger.warn(
					{
						err: error,
						batchSize: group.length,
						policyVersions: [...failedPolicies],
					},
					"Rate-limit aggregate persistence unavailable"
				);
			}
		})
	);
};

const recordShape = ({
	redis,
	trafficClass,
	workload,
	scope,
	outcome,
	fingerprint,
	policyVersion = "graphql-v3",
	date = new Date(),
	logger,
}: {
	redis: Redis;
	trafficClass: GraphQLTrafficClass;
	workload: GraphQLWorkload;
	scope: GraphQLRateLimitHeaderScope;
	outcome: RateLimitAggregateOutcome;
	fingerprint: string;
	policyVersion?: GraphQLRateLimitPolicyVersion;
	date?: Date;
	logger: Logger;
}): RateLimitAggregateRecord => ({
	redis,
	trafficClass,
	workload,
	scope,
	outcome,
	fingerprint,
	policyVersion,
	date,
	logger,
});

/**
 * Synchronous, testable persistence entrypoint retained for reports and
 * maintenance tools. Request admission uses the bounded enqueue path below.
 */
export const recordRateLimitAggregate = async (input: {
	redis: Redis;
	trafficClass: GraphQLTrafficClass;
	workload: GraphQLWorkload;
	scope: GraphQLRateLimitHeaderScope;
	outcome: RateLimitAggregateOutcome;
	fingerprint: string;
	policyVersion?: GraphQLRateLimitPolicyVersion;
	date?: Date;
	logger: Logger;
}): Promise<void> => {
	const record = recordShape(input);
	metrics.graphqlRateLimitV3Decisions
		.labels(record.trafficClass, record.workload, record.scope, record.outcome)
		.inc();
	await persistRateLimitAggregateBatch([record]);
};

const pendingTelemetry: RateLimitAggregateRecord[] = [];
let telemetryFlushTimer: ReturnType<typeof setTimeout> | null = null;
let telemetryFlushPromise: Promise<void> | null = null;
const persistedOverflowMarkers = new Set<string>();
const overflowMarkerFlights = new Map<string, Promise<void>>();

const clearTelemetryFlushTimer = (): void => {
	if (telemetryFlushTimer === null) return;
	clearTimeout(telemetryFlushTimer);
	telemetryFlushTimer = null;
};

const flushTelemetryQueue = async (): Promise<void> => {
	while (pendingTelemetry.length > 0) {
		const batch = pendingTelemetry.splice(0, RATE_LIMIT_TELEMETRY_BATCH_SIZE);
		await persistRateLimitAggregateBatch(batch);
	}
};

const startTelemetryFlush = (): Promise<void> => {
	clearTelemetryFlushTimer();
	if (telemetryFlushPromise) return telemetryFlushPromise;
	const running = flushTelemetryQueue();
	const settled = running
		.catch(() => undefined)
		.finally(() => {
			if (telemetryFlushPromise === settled) telemetryFlushPromise = null;
		});
	telemetryFlushPromise = settled;
	return settled;
};

const scheduleTelemetryFlush = (): void => {
	if (telemetryFlushTimer !== null) return;
	telemetryFlushTimer = setTimeout(() => {
		telemetryFlushTimer = null;
		void startTelemetryFlush();
	}, RATE_LIMIT_TELEMETRY_FLUSH_INTERVAL_MS);
};

const persistOverflowMarker = (record: RateLimitAggregateRecord): void => {
	const key = rateLimitTelemetryOverflowKey(
		rateLimitAggregateDate(record.date),
		record.policyVersion
	);
	if (persistedOverflowMarkers.has(key) || overflowMarkerFlights.has(key)) return;
	let markerWrite: Promise<unknown>;
	try {
		markerWrite = record.redis.set(key, "1", "EX", RATE_LIMIT_AGGREGATE_RETENTION_SECONDS, "NX");
	} catch (error: unknown) {
		metrics.rateLimitStorageFailures.labels(`${record.policyVersion}-overflow`, "open").inc();
		record.logger.warn(
			{ err: error, policyVersion: record.policyVersion },
			"Rate-limit telemetry overflow marker unavailable"
		);
		return;
	}
	const flight = markerWrite
		.then(() => {
			if (persistedOverflowMarkers.size >= 32) {
				const oldest = persistedOverflowMarkers.values().next().value;
				if (oldest !== undefined) persistedOverflowMarkers.delete(oldest);
			}
			persistedOverflowMarkers.add(key);
		})
		.catch((error: unknown) => {
			metrics.rateLimitStorageFailures.labels(`${record.policyVersion}-overflow`, "open").inc();
			record.logger.warn(
				{ err: error, policyVersion: record.policyVersion },
				"Rate-limit telemetry overflow marker unavailable"
			);
		})
		.finally(() => {
			overflowMarkerFlights.delete(key);
		});
	overflowMarkerFlights.set(key, flight);
	void flight;
};

/**
 * Enqueue aggregate telemetry without awaiting a Redis write on the normal
 * request path. Admission decisions and Prometheus counters remain
 * synchronous; a full queue drops the aggregate and starts one bounded,
 * fire-and-forget durable overflow marker for the report window.
 */
export const enqueueRateLimitAggregate = (input: {
	redis: Redis;
	trafficClass: GraphQLTrafficClass;
	workload: GraphQLWorkload;
	scope: GraphQLRateLimitHeaderScope;
	outcome: RateLimitAggregateOutcome;
	fingerprint: string;
	policyVersion?: GraphQLRateLimitPolicyVersion;
	date?: Date;
	logger: Logger;
}): void => {
	const record = recordShape(input);
	metrics.graphqlRateLimitV3Decisions
		.labels(record.trafficClass, record.workload, record.scope, record.outcome)
		.inc();
	if (pendingTelemetry.length >= RATE_LIMIT_TELEMETRY_MAX_QUEUE_SIZE) {
		metrics.rateLimitTelemetryOverflows.labels(record.policyVersion).inc();
		persistOverflowMarker(record);
		return;
	}
	pendingTelemetry.push(record);
	if (pendingTelemetry.length >= RATE_LIMIT_TELEMETRY_BATCH_SIZE) {
		void startTelemetryFlush();
	} else {
		scheduleTelemetryFlush();
	}
};

/** Flush queued telemetry, bounded for process shutdown. */
export const flushRateLimitAggregateTelemetry = async (
	timeoutMs = RATE_LIMIT_TELEMETRY_SHUTDOWN_TIMEOUT_MS
): Promise<void> => {
	const running = startTelemetryFlush();
	if (timeoutMs <= 0) throw new Error("rate-limit telemetry flush timed out");
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			running,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("rate-limit telemetry flush timed out")),
					timeoutMs
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
};
