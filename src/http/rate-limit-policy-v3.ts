import rawProductionPolicy from "../config/rate-limit/production.json";
import type { GraphQLWorkload } from "../infra/ingress-envelope";

export const GRAPHQL_RATE_LIMIT_MODES = ["legacy", "shadow-v3", "enforce-v3"] as const;
export type GraphQLRateLimitMode = (typeof GRAPHQL_RATE_LIMIT_MODES)[number];

export type TokenBucketPolicy = {
	readonly refillPerSecond: number;
	readonly burst: number;
};

type WorkloadPolicies = Readonly<Record<GraphQLWorkload, TokenBucketPolicy>>;

export type GraphQLRateLimitPolicyV3 = {
	readonly schemaVersion: 3;
	readonly policyVersion: "graphql-v3";
	readonly capacity: {
		readonly validated: boolean;
		readonly sustainableRps: number | null;
		readonly targetConcurrent: number;
		readonly requiredHeadroomRatio: number;
		readonly evidence: string | null;
	};
	readonly legacyV2: {
		readonly windowSeconds: number;
		readonly globalRequest: number;
		readonly sharedPublicWeighted: number;
		readonly browserIngress: number;
		readonly authenticatedWeighted: number;
		readonly anonymousWeighted: number;
	};
	readonly global: TokenBucketPolicy;
	readonly trafficClasses: {
		readonly mini: {
			readonly abuseRequest: TokenBucketPolicy;
			readonly anonymousWeighted: TokenBucketPolicy;
			readonly sessionWeighted: TokenBucketPolicy;
		};
		readonly web_browser: {
			readonly anonymousWeighted: TokenBucketPolicy;
			readonly sessionWeighted: TokenBucketPolicy;
		};
		readonly web_rsc: {
			readonly classRequest: TokenBucketPolicy;
			readonly workloads: WorkloadPolicies;
		};
		readonly service: {
			readonly classRequest: TokenBucketPolicy;
			readonly weighted: TokenBucketPolicy;
		};
		readonly legacy: {
			readonly classRequest: TokenBucketPolicy;
			readonly weighted: TokenBucketPolicy;
		};
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown, path: string): number => {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Error(`${path} must be a positive integer`);
	}
	return Number(value);
};

const bucket = (value: unknown, path: string): TokenBucketPolicy => {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const keys = Object.keys(value).sort();
	if (keys.join(",") !== "burst,refillPerSecond") {
		throw new Error(`${path} must contain only burst and refillPerSecond`);
	}
	return {
		refillPerSecond: positiveInteger(value.refillPerSecond, `${path}.refillPerSecond`),
		burst: positiveInteger(value.burst, `${path}.burst`),
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

const WORKLOADS = [
	"interactive",
	"home",
	"fixtures",
	"market",
	"player-stats",
	"gameweek",
	"public-other",
] as const satisfies readonly GraphQLWorkload[];

export const parseGraphQLRateLimitPolicyV3 = (value: unknown): GraphQLRateLimitPolicyV3 => {
	if (!isRecord(value)) throw new Error("GraphQL rate-limit policy must be an object");
	exactKeys(
		value,
		["schemaVersion", "policyVersion", "capacity", "legacyV2", "global", "trafficClasses"],
		"policy"
	);
	if (value.schemaVersion !== 3 || value.policyVersion !== "graphql-v3") {
		throw new Error("GraphQL rate-limit policy version must be graphql-v3/schema 3");
	}

	if (!isRecord(value.capacity)) throw new Error("policy.capacity must be an object");
	exactKeys(
		value.capacity,
		["validated", "sustainableRps", "targetConcurrent", "requiredHeadroomRatio", "evidence"],
		"policy.capacity"
	);
	if (typeof value.capacity.validated !== "boolean") {
		throw new Error("policy.capacity.validated must be boolean");
	}
	const sustainableRps =
		value.capacity.sustainableRps === null
			? null
			: positiveInteger(value.capacity.sustainableRps, "policy.capacity.sustainableRps");
	const requiredHeadroomRatio = Number(value.capacity.requiredHeadroomRatio);
	if (
		!Number.isFinite(requiredHeadroomRatio) ||
		requiredHeadroomRatio < 0.4 ||
		requiredHeadroomRatio >= 1
	) {
		throw new Error("policy.capacity.requiredHeadroomRatio must be at least 0.4 and below 1");
	}
	if (value.capacity.evidence !== null && typeof value.capacity.evidence !== "string") {
		throw new Error("policy.capacity.evidence must be a string or null");
	}

	if (!isRecord(value.legacyV2)) throw new Error("policy.legacyV2 must be an object");
	exactKeys(
		value.legacyV2,
		[
			"windowSeconds",
			"globalRequest",
			"sharedPublicWeighted",
			"browserIngress",
			"authenticatedWeighted",
			"anonymousWeighted",
		],
		"policy.legacyV2"
	);

	if (!isRecord(value.trafficClasses)) {
		throw new Error("policy.trafficClasses must be an object");
	}
	exactKeys(
		value.trafficClasses,
		["mini", "web_browser", "web_rsc", "service", "legacy"],
		"policy.trafficClasses"
	);
	const classes = value.trafficClasses;
	const mini = classes.mini;
	const webBrowser = classes.web_browser;
	const webRsc = classes.web_rsc;
	const service = classes.service;
	const legacy = classes.legacy;
	if (!isRecord(mini)) throw new Error("policy.trafficClasses.mini must be an object");
	if (!isRecord(webBrowser)) {
		throw new Error("policy.trafficClasses.web_browser must be an object");
	}
	if (!isRecord(webRsc)) throw new Error("policy.trafficClasses.web_rsc must be an object");
	if (!isRecord(service)) throw new Error("policy.trafficClasses.service must be an object");
	if (!isRecord(legacy)) throw new Error("policy.trafficClasses.legacy must be an object");
	exactKeys(
		mini,
		["abuseRequest", "anonymousWeighted", "sessionWeighted"],
		"policy.trafficClasses.mini"
	);
	exactKeys(
		webBrowser,
		["anonymousWeighted", "sessionWeighted"],
		"policy.trafficClasses.web_browser"
	);
	exactKeys(webRsc, ["classRequest", "workloads"], "policy.trafficClasses.web_rsc");
	exactKeys(service, ["classRequest", "weighted"], "policy.trafficClasses.service");
	exactKeys(legacy, ["classRequest", "weighted"], "policy.trafficClasses.legacy");
	if (!isRecord(webRsc.workloads)) {
		throw new Error("policy.trafficClasses.web_rsc.workloads must be an object");
	}
	const workloadPolicies = webRsc.workloads;
	exactKeys(workloadPolicies, WORKLOADS, "policy.trafficClasses.web_rsc.workloads");

	const parsed: GraphQLRateLimitPolicyV3 = {
		schemaVersion: 3,
		policyVersion: "graphql-v3",
		capacity: {
			validated: value.capacity.validated,
			sustainableRps,
			targetConcurrent: positiveInteger(
				value.capacity.targetConcurrent,
				"policy.capacity.targetConcurrent"
			),
			requiredHeadroomRatio,
			evidence: value.capacity.evidence as string | null,
		},
		legacyV2: {
			windowSeconds: positiveInteger(value.legacyV2.windowSeconds, "policy.legacyV2.windowSeconds"),
			globalRequest: positiveInteger(value.legacyV2.globalRequest, "policy.legacyV2.globalRequest"),
			sharedPublicWeighted: positiveInteger(
				value.legacyV2.sharedPublicWeighted,
				"policy.legacyV2.sharedPublicWeighted"
			),
			browserIngress: positiveInteger(
				value.legacyV2.browserIngress,
				"policy.legacyV2.browserIngress"
			),
			authenticatedWeighted: positiveInteger(
				value.legacyV2.authenticatedWeighted,
				"policy.legacyV2.authenticatedWeighted"
			),
			anonymousWeighted: positiveInteger(
				value.legacyV2.anonymousWeighted,
				"policy.legacyV2.anonymousWeighted"
			),
		},
		global: bucket(value.global, "policy.global"),
		trafficClasses: {
			mini: {
				abuseRequest: bucket(mini.abuseRequest, "policy.trafficClasses.mini.abuseRequest"),
				anonymousWeighted: bucket(
					mini.anonymousWeighted,
					"policy.trafficClasses.mini.anonymousWeighted"
				),
				sessionWeighted: bucket(mini.sessionWeighted, "policy.trafficClasses.mini.sessionWeighted"),
			},
			web_browser: {
				anonymousWeighted: bucket(
					webBrowser.anonymousWeighted,
					"policy.trafficClasses.web_browser.anonymousWeighted"
				),
				sessionWeighted: bucket(
					webBrowser.sessionWeighted,
					"policy.trafficClasses.web_browser.sessionWeighted"
				),
			},
			web_rsc: {
				classRequest: bucket(webRsc.classRequest, "policy.trafficClasses.web_rsc.classRequest"),
				workloads: Object.fromEntries(
					WORKLOADS.map((workload) => [
						workload,
						bucket(
							workloadPolicies[workload],
							`policy.trafficClasses.web_rsc.workloads.${workload}`
						),
					])
				) as WorkloadPolicies,
			},
			service: {
				classRequest: bucket(service.classRequest, "policy.trafficClasses.service.classRequest"),
				weighted: bucket(service.weighted, "policy.trafficClasses.service.weighted"),
			},
			legacy: {
				classRequest: bucket(legacy.classRequest, "policy.trafficClasses.legacy.classRequest"),
				weighted: bucket(legacy.weighted, "policy.trafficClasses.legacy.weighted"),
			},
		},
	};

	if (parsed.capacity.validated) {
		if (!parsed.capacity.sustainableRps || !parsed.capacity.evidence) {
			throw new Error("Validated capacity requires sustainableRps and evidence");
		}
		if (parsed.capacity.targetConcurrent !== 300) {
			throw new Error("Validated capacity must target exactly 300 concurrent clients");
		}
		const expectedRefill = Math.floor(
			(1 - parsed.capacity.requiredHeadroomRatio) * parsed.capacity.sustainableRps
		);
		if (parsed.global.refillPerSecond !== expectedRefill) {
			throw new Error(`Validated global refill must equal floor(0.6 x S): ${expectedRefill}`);
		}
		if (parsed.global.burst !== parsed.global.refillPerSecond * 10) {
			throw new Error("Validated global burst must equal ten seconds of refill");
		}
	}

	return parsed;
};

export const parseGraphQLRateLimitMode = (value: string | undefined): GraphQLRateLimitMode => {
	const mode = value ?? "legacy";
	if (!GRAPHQL_RATE_LIMIT_MODES.includes(mode as GraphQLRateLimitMode)) {
		throw new Error(
			`GRAPHQL_RATE_LIMIT_MODE must be one of ${GRAPHQL_RATE_LIMIT_MODES.join(", ")}`
		);
	}
	return mode as GraphQLRateLimitMode;
};

export const productionGraphQLRateLimitPolicy = parseGraphQLRateLimitPolicyV3(rawProductionPolicy);

export const assertGraphQLRateLimitModeCanStart = (
	mode: GraphQLRateLimitMode,
	policy: GraphQLRateLimitPolicyV3
): void => {
	if (mode === "enforce-v3" && !policy.capacity.validated) {
		throw new Error(
			"enforce-v3 is blocked until the production profile contains validated capacity evidence"
		);
	}
};
