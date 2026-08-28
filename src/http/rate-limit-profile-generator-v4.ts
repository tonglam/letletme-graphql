import type { GraphQLWorkload } from "../infra/ingress-context";
import {
	generateValidatedRateLimitPolicyBody,
	type RateLimitTargetObservation,
} from "./rate-limit-profile-generator";
import { parseGraphQLRateLimitPolicyBody, type TokenBucketPolicy } from "./rate-limit-policy-v3";
import {
	parseGraphQLRateLimitPolicyV4,
	type GraphQLRateLimitPolicyV4,
} from "./rate-limit-policy-v4";

export type MiniRateLimitObservation = {
	readonly anonymousWeightedPerSecond: Readonly<Record<GraphQLWorkload, number>>;
	readonly anonymousMaxCost: Readonly<Record<GraphQLWorkload, number>>;
	readonly sessionWeightedPerSecond: Readonly<Record<GraphQLWorkload, number>>;
	readonly sessionMaxCost: Readonly<Record<GraphQLWorkload, number>>;
};

export type RateLimitTargetObservationV4 = RateLimitTargetObservation & {
	readonly mini: MiniRateLimitObservation;
};

const WORKLOADS = [
	"interactive",
	"home",
	"fixtures",
	"market",
	"player-stats",
	"gameweek",
	"public-other",
] as const satisfies readonly GraphQLWorkload[];

const measuredBucket = (perSecond: number, maximumRequestCost: number): TokenBucketPolicy => {
	const refillPerSecond = Math.max(1, Math.ceil(perSecond * 1.25));
	return {
		refillPerSecond,
		burst: Math.max(refillPerSecond * 10, Math.ceil(maximumRequestCost)),
	};
};

const finiteNonNegative = (value: number, label: string): number => {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
	return value;
};

const generateWorkloads = (
	base: Readonly<Record<GraphQLWorkload, TokenBucketPolicy>>,
	rate: Readonly<Record<GraphQLWorkload, number>>,
	maxCost: Readonly<Record<GraphQLWorkload, number>>,
	prefix: string
): Readonly<Record<GraphQLWorkload, TokenBucketPolicy>> =>
	Object.fromEntries(
		WORKLOADS.map((workload) => {
			const measuredRate = finiteNonNegative(rate[workload], `${prefix}.${workload}.perSecond`);
			const maximumRequestCost = finiteNonNegative(
				maxCost[workload],
				`${prefix}.${workload}.maxCost`
			);
			if (measuredRate === 0) return [workload, base[workload]];
			if (!Number.isSafeInteger(maximumRequestCost) || maximumRequestCost < 1) {
				throw new Error(`${prefix}.${workload}.maxCost must cover an observed request`);
			}
			return [workload, measuredBucket(measuredRate, maximumRequestCost)];
		})
	) as Readonly<Record<GraphQLWorkload, TokenBucketPolicy>>;

const aggregate = (
	workloads: Readonly<Record<GraphQLWorkload, TokenBucketPolicy>>
): TokenBucketPolicy => ({
	refillPerSecond: WORKLOADS.reduce(
		(sum, workload) => sum + workloads[workload].refillPerSecond,
		0
	),
	burst: WORKLOADS.reduce((sum, workload) => sum + workloads[workload].burst, 0),
});

export const generateValidatedRateLimitProfileV4 = ({
	base,
	observation,
	evidence,
}: {
	base: GraphQLRateLimitPolicyV4;
	observation: RateLimitTargetObservationV4;
	evidence: string;
}): GraphQLRateLimitPolicyV4 => {
	const anonymousWorkloads = generateWorkloads(
		base.trafficClasses.mini.anonymousWorkloads,
		observation.mini.anonymousWeightedPerSecond,
		observation.mini.anonymousMaxCost,
		"mini.anonymous"
	);
	const sessionWorkloads = generateWorkloads(
		base.trafficClasses.mini.sessionWorkloads,
		observation.mini.sessionWeightedPerSecond,
		observation.mini.sessionMaxCost,
		"mini.session"
	);

	const sharedBase = parseGraphQLRateLimitPolicyBody({
		capacity: base.capacity,
		global: base.global,
		trafficClasses: {
			...base.trafficClasses,
			mini: {
				abuseRequest: base.trafficClasses.mini.abuseRequest,
				anonymousWeighted: base.trafficClasses.mini.aggregateAnonymousWeighted,
				sessionWeighted: base.trafficClasses.mini.aggregateSessionWeighted,
			},
		},
	});
	const generatedBody = generateValidatedRateLimitPolicyBody({
		base: sharedBase,
		observation,
		evidence,
	});
	return parseGraphQLRateLimitPolicyV4({
		...generatedBody,
		schemaVersion: 4,
		policyVersion: "graphql-v4",
		trafficClasses: {
			...generatedBody.trafficClasses,
			mini: {
				abuseRequest: base.trafficClasses.mini.abuseRequest,
				aggregateAnonymousWeighted: aggregate(anonymousWorkloads),
				aggregateSessionWeighted: aggregate(sessionWorkloads),
				anonymousWorkloads,
				sessionWorkloads,
			},
		},
	});
};
