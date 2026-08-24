import { createHmac } from "crypto";
import type Redis from "ioredis";
import type { Logger } from "./logger";
import type { GraphQLTrafficClass, GraphQLWorkload } from "./ingress-context";
import type { GraphQLRateLimitHeaderScope } from "../http/token-bucket-v3";
import { env } from "./env";
import { metrics } from "./metrics";

export const RATE_LIMIT_AGGREGATE_RETENTION_SECONDS = 14 * 24 * 60 * 60;
export const RATE_LIMIT_RECENT_RETENTION_SECONDS = 2 * 60 * 60;

export type RateLimitAggregateOutcome =
	"allowed" | "denied" | "would_allow" | "would_deny" | "legacy_allowed" | "legacy_denied";

export type GraphQLRateLimitPolicyVersion = "graphql-v3" | "graphql-v4";

const deniedOutcomes = new Set<RateLimitAggregateOutcome>([
	"denied",
	"would_deny",
	"legacy_denied",
]);

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
		if (interactive && (outcome === "allowed" || outcome === "legacy_allowed")) {
			interactiveAllowed += count;
		}
		if (interactive && (outcome === "denied" || outcome === "legacy_denied")) {
			interactiveDenied += count;
		}
		if (interactive && outcome === "would_allow") shadowInteractiveAllowed += count;
		if (interactive && outcome === "would_deny") shadowInteractiveDenied += count;
		if (scope === "global" && (outcome === "denied" || outcome === "legacy_denied")) {
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

export const recordRateLimitAggregate = async ({
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
}): Promise<void> => {
	metrics.graphqlRateLimitV3Decisions.labels(trafficClass, workload, scope, outcome).inc();
	const day = rateLimitAggregateDate(date);
	const aggregateKey = rateLimitAggregateKey(day, policyVersion);
	const recentKey = rateLimitRecentAggregateKey(rateLimitAggregateMinute(date), policyVersion);
	const field = [trafficClass, workload, scope, outcome].join("|");
	try {
		const pipeline = redis.pipeline();
		pipeline.hincrby(aggregateKey, field, 1);
		pipeline.expire(aggregateKey, RATE_LIMIT_AGGREGATE_RETENTION_SECONDS);
		pipeline.hincrby(recentKey, field, 1);
		pipeline.expire(recentKey, RATE_LIMIT_RECENT_RETENTION_SECONDS);
		if (deniedOutcomes.has(outcome)) {
			const rankingKey = rateLimitDeniedRankingKey(day, policyVersion);
			pipeline.zincrby(
				rankingKey,
				1,
				[trafficClass, workload, scope, outcome, fingerprint].join("|")
			);
			pipeline.expire(rankingKey, RATE_LIMIT_AGGREGATE_RETENTION_SECONDS);
		}
		const results = await pipeline.exec();
		const failure = results?.find(([error]) => error);
		if (failure?.[0]) throw failure[0];
	} catch (error) {
		metrics.rateLimitStorageFailures.labels(`${policyVersion}-aggregate`, "open").inc();
		logger.warn(
			{ err: error, trafficClass, workload, scope, outcome },
			"Rate-limit aggregate persistence unavailable"
		);
	}
};
