import rawProductionPolicy from "../config/rate-limit/production-v4.json";
import { isPlainRecord } from "../contracts/guards";
import type { GraphQLWorkload } from "../infra/ingress-envelope";
import {
	parseGraphQLRateLimitPolicyBody,
	type GraphQLRateLimitPolicyV3,
	type TokenBucketPolicy,
} from "./rate-limit-policy-v3";

const WORKLOADS = [
	"interactive",
	"home",
	"fixtures",
	"market",
	"player-stats",
	"gameweek",
	"public-other",
] as const satisfies readonly GraphQLWorkload[];

type WorkloadPolicies = Readonly<Record<GraphQLWorkload, TokenBucketPolicy>>;
type V3TrafficClasses = GraphQLRateLimitPolicyV3["trafficClasses"];

export type GraphQLRateLimitPolicyV4 = Omit<
	GraphQLRateLimitPolicyV3,
	"schemaVersion" | "policyVersion" | "trafficClasses"
> & {
	readonly schemaVersion: 4;
	readonly policyVersion: "graphql-v4";
	readonly trafficClasses: Omit<V3TrafficClasses, "mini"> & {
		readonly mini: {
			readonly abuseRequest: TokenBucketPolicy;
			readonly aggregateAnonymousWeighted: TokenBucketPolicy;
			readonly aggregateSessionWeighted: TokenBucketPolicy;
			readonly anonymousWorkloads: WorkloadPolicies;
			readonly sessionWorkloads: WorkloadPolicies;
		};
	};
};

const exactKeys = (
	value: Record<string, unknown>,
	expected: readonly string[],
	path: string
): void => {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.join(",") !== wanted.join(",")) {
		throw new Error(`${path} must contain exactly: ${wanted.join(", ")}`);
	}
};

const positiveInteger = (value: unknown, path: string): number => {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Error(`${path} must be a positive integer`);
	}
	return Number(value);
};

const bucket = (value: unknown, path: string): TokenBucketPolicy => {
	if (!isPlainRecord(value)) throw new Error(`${path} must be an object`);
	exactKeys(value, ["burst", "refillPerSecond"], path);
	return {
		refillPerSecond: positiveInteger(value.refillPerSecond, `${path}.refillPerSecond`),
		burst: positiveInteger(value.burst, `${path}.burst`),
	};
};

const workloadBuckets = (value: unknown, path: string): WorkloadPolicies => {
	if (!isPlainRecord(value)) throw new Error(`${path} must be an object`);
	exactKeys(value, WORKLOADS, path);
	return Object.fromEntries(
		WORKLOADS.map((workload) => [workload, bucket(value[workload], `${path}.${workload}`)])
	) as WorkloadPolicies;
};

const sumBucket = (buckets: WorkloadPolicies): TokenBucketPolicy => ({
	refillPerSecond: WORKLOADS.reduce((sum, workload) => sum + buckets[workload].refillPerSecond, 0),
	burst: WORKLOADS.reduce((sum, workload) => sum + buckets[workload].burst, 0),
});

export const parseGraphQLRateLimitPolicyV4 = (value: unknown): GraphQLRateLimitPolicyV4 => {
	if (!isPlainRecord(value)) throw new Error("GraphQL rate-limit policy must be an object");
	exactKeys(
		value,
		["schemaVersion", "policyVersion", "capacity", "global", "trafficClasses"],
		"policy"
	);
	if (value.schemaVersion !== 4 || value.policyVersion !== "graphql-v4") {
		throw new Error("GraphQL rate-limit policy version must be graphql-v4/schema 4");
	}
	if (!isPlainRecord(value.trafficClasses))
		throw new Error("policy.trafficClasses must be an object");
	exactKeys(
		value.trafficClasses,
		["mini", "web_browser", "web_rsc", "service"],
		"policy.trafficClasses"
	);
	const mini = value.trafficClasses.mini;
	if (!isPlainRecord(mini)) throw new Error("policy.trafficClasses.mini must be an object");
	exactKeys(
		mini,
		[
			"abuseRequest",
			"aggregateAnonymousWeighted",
			"aggregateSessionWeighted",
			"anonymousWorkloads",
			"sessionWorkloads",
		],
		"policy.trafficClasses.mini"
	);
	const anonymousWorkloads = workloadBuckets(
		mini.anonymousWorkloads,
		"policy.trafficClasses.mini.anonymousWorkloads"
	);
	const sessionWorkloads = workloadBuckets(
		mini.sessionWorkloads,
		"policy.trafficClasses.mini.sessionWorkloads"
	);
	const aggregateAnonymousWeighted = bucket(
		mini.aggregateAnonymousWeighted,
		"policy.trafficClasses.mini.aggregateAnonymousWeighted"
	);
	const aggregateSessionWeighted = bucket(
		mini.aggregateSessionWeighted,
		"policy.trafficClasses.mini.aggregateSessionWeighted"
	);
	const expectedAnonymous = sumBucket(anonymousWorkloads);
	const expectedSession = sumBucket(sessionWorkloads);
	if (
		aggregateAnonymousWeighted.refillPerSecond !== expectedAnonymous.refillPerSecond ||
		aggregateAnonymousWeighted.burst !== expectedAnonymous.burst
	) {
		throw new Error("Mini anonymous aggregate ceiling must equal the sum of workload capacities");
	}
	if (
		aggregateSessionWeighted.refillPerSecond !== expectedSession.refillPerSecond ||
		aggregateSessionWeighted.burst !== expectedSession.burst
	) {
		throw new Error("Mini session aggregate ceiling must equal the sum of workload capacities");
	}

	const sharedPolicy = parseGraphQLRateLimitPolicyBody({
		capacity: value.capacity,
		global: value.global,
		trafficClasses: {
			...value.trafficClasses,
			mini: {
				abuseRequest: mini.abuseRequest,
				anonymousWeighted: mini.aggregateAnonymousWeighted,
				sessionWeighted: mini.aggregateSessionWeighted,
			},
		},
	});

	return {
		...sharedPolicy,
		schemaVersion: 4,
		policyVersion: "graphql-v4",
		trafficClasses: {
			...sharedPolicy.trafficClasses,
			mini: {
				abuseRequest: bucket(mini.abuseRequest, "policy.trafficClasses.mini.abuseRequest"),
				aggregateAnonymousWeighted,
				aggregateSessionWeighted,
				anonymousWorkloads,
				sessionWorkloads,
			},
		},
	};
};

export const productionGraphQLRateLimitPolicyV4 =
	parseGraphQLRateLimitPolicyV4(rawProductionPolicy);

export const assertGraphQLRateLimitV4ModeCanStart = (
	mode: "shadow-v4" | "enforce-v4",
	policy: GraphQLRateLimitPolicyV4
): void => {
	if (mode === "enforce-v4" && !policy.capacity.validated) {
		throw new Error(
			"enforce-v4 is blocked until the production profile contains validated capacity evidence"
		);
	}
};
