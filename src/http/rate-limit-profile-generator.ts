import type { GraphQLWorkload } from "../infra/ingress-context";
import {
	parseGraphQLRateLimitPolicyV3,
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
	};
	readonly service: {
		readonly classRequestPerSecond: number;
		readonly weightedPerSecond: number;
	};
};

const finiteNonNegative = (value: number, label: string): number => {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
	return value;
};

const measuredBucket = (perSecond: number): TokenBucketPolicy => {
	const refillPerSecond = Math.max(1, Math.ceil(perSecond * 1.25));
	return { refillPerSecond, burst: refillPerSecond * 10 };
};

export const generateValidatedRateLimitProfile = ({
	base,
	observation,
	evidence,
}: {
	base: GraphQLRateLimitPolicyV3;
	observation: RateLimitTargetObservation;
	evidence: string;
}): GraphQLRateLimitPolicyV3 => {
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
	const workloadPolicies = Object.fromEntries(
		Object.entries(observation.webRsc.workloadWeightedPerSecond).map(([workload, rate]) => [
			workload,
			measuredBucket(finiteNonNegative(rate, `webRsc.workload.${workload}`)),
		])
	);
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
				classRequest: measuredBucket(
					finiteNonNegative(
						observation.webRsc.classRequestPerSecond,
						"webRsc.classRequestPerSecond"
					)
				),
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
				weighted: measuredBucket(
					finiteNonNegative(observation.service.weightedPerSecond, "service.weightedPerSecond")
				),
			},
		},
	};
	return parseGraphQLRateLimitPolicyV3(candidate);
};
