import type { GraphQLWorkload } from "../infra/ingress-context";
import {
	parseGraphQLRateLimitPolicyBody,
	type GraphQLRateLimitPolicyBody,
	type GraphQLRateLimitPolicyV3,
	type TokenBucketPolicy,
} from "./rate-limit-policy-v3";

export type RateLimitTargetObservation = {
	readonly targetConcurrent: 300;
	readonly sustainableRps: number;
	readonly totalRequestPerSecond: number;
	readonly webRsc: {
		readonly classRequestPerSecond: number;
		readonly workloadWeightedPerSecond: Readonly<Record<GraphQLWorkload, number>>;
		readonly workloadMaxCost: Readonly<Record<GraphQLWorkload, number>>;
	};
	readonly service: {
		readonly classRequestPerSecond: number;
		readonly weightedPerSecond: number;
		readonly maxWeightedCost: number;
	};
};

const finiteNonNegative = (value: number, label: string): number => {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
	return value;
};

const measuredBucket = (perSecond: number, maximumRequestCost = 1): TokenBucketPolicy => {
	const refillPerSecond = Math.max(1, Math.ceil(perSecond * 1.25));
	return {
		refillPerSecond,
		burst: Math.max(refillPerSecond * 10, Math.ceil(maximumRequestCost)),
	};
};

export const generateValidatedRateLimitPolicyBody = ({
	base,
	observation,
	evidence,
}: {
	base: GraphQLRateLimitPolicyBody;
	observation: RateLimitTargetObservation;
	evidence: string;
}): GraphQLRateLimitPolicyBody => {
	const sustainableRps = observation.sustainableRps;
	if (!Number.isSafeInteger(sustainableRps) || sustainableRps < 2) {
		throw new Error("sustainableRps must be an integer of at least 2");
	}
	if (observation.targetConcurrent !== 300) {
		throw new Error("Capacity evidence must use the 300-concurrent target model");
	}
	if (!evidence.trim()) throw new Error("Capacity evidence reference is required");
	const globalRefill = Math.floor(0.6 * sustainableRps);
	const targetRps = finiteNonNegative(
		observation.totalRequestPerSecond,
		"observation.totalRequestPerSecond"
	);
	if (targetRps > globalRefill) {
		throw new Error(
			`Target traffic ${targetRps} RPS exceeds the 40% headroom gate of ${globalRefill} RPS`
		);
	}
	const webRscClassRequestPerSecond = finiteNonNegative(
		observation.webRsc.classRequestPerSecond,
		"webRsc.classRequestPerSecond"
	);
	if (webRscClassRequestPerSecond === 0) {
		throw new Error("Capacity evidence must contain Web RSC rate-limit decisions");
	}
	const workloadPolicies = Object.fromEntries(
		Object.entries(base.trafficClasses.web_rsc.workloads).map(([workload, basePolicy]) => {
			const rate = finiteNonNegative(
				observation.webRsc.workloadWeightedPerSecond[workload as GraphQLWorkload],
				`webRsc.workload.${workload}`
			);
			const maximumRequestCost = finiteNonNegative(
				observation.webRsc.workloadMaxCost[workload as GraphQLWorkload],
				`webRsc.workloadMaxCost.${workload}`
			);
			if (rate > 0 && (!Number.isSafeInteger(maximumRequestCost) || maximumRequestCost < 1)) {
				throw new Error(`webRsc.workloadMaxCost.${workload} must cover an observed request`);
			}
			// The target load model intentionally exercises only the public RSC
			// workloads it can render. A zero observation is not evidence that an
			// unobserved workload can safely be reduced to a one-token bucket.
			return [workload, rate === 0 ? basePolicy : measuredBucket(rate, maximumRequestCost)];
		})
	);
	const serviceWeightedPerSecond = finiteNonNegative(
		observation.service.weightedPerSecond,
		"service.weightedPerSecond"
	);
	const serviceMaxWeightedCost = finiteNonNegative(
		observation.service.maxWeightedCost,
		"service.maxWeightedCost"
	);
	if (
		serviceWeightedPerSecond > 0 &&
		(!Number.isSafeInteger(serviceMaxWeightedCost) || serviceMaxWeightedCost < 1)
	) {
		throw new Error("service.maxWeightedCost must cover an observed request");
	}
	const candidate = {
		...base,
		capacity: {
			validated: true,
			sustainableRps,
			targetConcurrent: 300,
			requiredHeadroomRatio: 0.4,
			evidence: evidence.trim(),
		},
		global: { refillPerSecond: globalRefill, burst: globalRefill * 10 },
		trafficClasses: {
			...base.trafficClasses,
			web_rsc: {
				...base.trafficClasses.web_rsc,
				classRequest: measuredBucket(webRscClassRequestPerSecond),
				workloads: workloadPolicies,
			},
			service: {
				...base.trafficClasses.service,
				classRequest: measuredBucket(
					finiteNonNegative(
						observation.service.classRequestPerSecond,
						"service.classRequestPerSecond"
					)
				),
				weighted: measuredBucket(serviceWeightedPerSecond, serviceMaxWeightedCost),
			},
		},
	};
	return parseGraphQLRateLimitPolicyBody(candidate);
};

export const generateValidatedRateLimitProfile = ({
	base,
	observation,
	evidence,
}: {
	base: GraphQLRateLimitPolicyV3;
	observation: RateLimitTargetObservation;
	evidence: string;
}): GraphQLRateLimitPolicyV3 => ({
	schemaVersion: 3,
	policyVersion: "graphql-v3",
	...generateValidatedRateLimitPolicyBody({
		base: {
			capacity: base.capacity,
			global: base.global,
			trafficClasses: base.trafficClasses,
		},
		observation,
		evidence,
	}),
});
