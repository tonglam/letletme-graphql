import { describe, expect, it } from "bun:test";
import {
	graphQLV3EarlyFailureRateLimitChecks,
	graphQLV3PreAuthRateLimitChecks,
	graphQLV3PrincipalAdmission,
} from "../../src/http/graphql-policy-v3";
import {
	assertGraphQLRateLimitModeCanStart,
	parseGraphQLRateLimitPolicyV3,
	productionGraphQLRateLimitPolicy,
} from "../../src/http/rate-limit-policy-v3";
import { generateValidatedRateLimitProfile } from "../../src/http/rate-limit-profile-generator";
import type {
	GraphQLIngress,
	GraphQLTrafficClass,
	GraphQLWorkload,
} from "../../src/infra/ingress-context";
import type { Principal } from "../../src/infra/principal";

const ingress = ({
	trafficClass,
	subject,
	abuseSubject = null,
	workload = "public-other",
}: {
	trafficClass: GraphQLTrafficClass;
	subject: string;
	abuseSubject?: string | null;
	workload?: GraphQLWorkload;
}): GraphQLIngress => ({
	class: trafficClass === "service" ? "service" : "signed",
	trusted: true,
	subject,
	abuseSubject,
	trafficClass,
	workload,
	ingressContext: null,
});

const principal = (userId: string): Principal => ({
	userId,
	source: "website",
	fplEntryId: null,
	fplEntryVerifiedAt: null,
});

describe("GraphQL v3 production policy", () => {
	it("loads the exact versioned profile and blocks enforce without capacity evidence", () => {
		expect(productionGraphQLRateLimitPolicy.policyVersion).toBe("graphql-v3");
		expect(productionGraphQLRateLimitPolicy.capacity.targetConcurrent).toBe(300);
		expect(() =>
			assertGraphQLRateLimitModeCanStart("enforce-v3", productionGraphQLRateLimitPolicy)
		).toThrow("validated capacity evidence");
		expect(() =>
			assertGraphQLRateLimitModeCanStart("shadow-v3", productionGraphQLRateLimitPolicy)
		).not.toThrow();
	});

	it("rejects unknown policy fields and non-positive bucket values", () => {
		const extra = JSON.parse(JSON.stringify(productionGraphQLRateLimitPolicy)) as Record<
			string,
			unknown
		>;
		extra.unexpected = true;
		expect(() => parseGraphQLRateLimitPolicyV3(extra)).toThrow("must contain exactly");
		const invalid = JSON.parse(JSON.stringify(productionGraphQLRateLimitPolicy)) as {
			global: { refillPerSecond: number };
		};
		invalid.global.refillPerSecond = 0;
		expect(() => parseGraphQLRateLimitPolicyV3(invalid)).toThrow("positive integer");
	});

	it("generates the global gate from S and refuses a target above sixty percent", () => {
		const observation = {
			targetConcurrent: 300 as const,
			sustainableRps: 40,
			totalRequestPerSecond: 20,
			webRsc: {
				classRequestPerSecond: 4,
				workloadWeightedPerSecond: {
					interactive: 1,
					home: 1,
					fixtures: 6,
					market: 6,
					"player-stats": 10,
					gameweek: 2,
					"public-other": 1,
				},
			},
			service: { classRequestPerSecond: 1, weightedPerSecond: 4 },
		};
		const generated = generateValidatedRateLimitProfile({
			base: productionGraphQLRateLimitPolicy,
			observation,
			evidence: "load-test/run-123.json",
		});
		expect(generated.global).toEqual({ refillPerSecond: 24, burst: 240 });
		expect(generated.trafficClasses.web_rsc.workloads["player-stats"]).toEqual({
			refillPerSecond: 13,
			burst: 130,
		});
		const zeroObservation = generateValidatedRateLimitProfile({
			base: productionGraphQLRateLimitPolicy,
			observation: {
				...observation,
				webRsc: {
					...observation.webRsc,
					workloadWeightedPerSecond: {
						...observation.webRsc.workloadWeightedPerSecond,
						home: 0,
					},
				},
			},
			evidence: "load-test/run-zero-workload.json",
		});
		expect(zeroObservation.trafficClasses.web_rsc.workloads.home).toEqual(
			productionGraphQLRateLimitPolicy.trafficClasses.web_rsc.workloads.home
		);
		expect(() =>
			generateValidatedRateLimitProfile({
				base: productionGraphQLRateLimitPolicy,
				observation: {
					...observation,
					webRsc: { ...observation.webRsc, classRequestPerSecond: 0 },
				},
				evidence: "load-test/run-without-rsc-decisions.json",
			})
		).toThrow("must contain Web RSC rate-limit decisions");
		const wrongTarget = JSON.parse(JSON.stringify(generated)) as {
			capacity: { targetConcurrent: number };
		};
		wrongTarget.capacity.targetConcurrent = 100;
		expect(() => parseGraphQLRateLimitPolicyV3(wrongTarget)).toThrow("exactly 300");
		expect(() =>
			generateValidatedRateLimitProfile({
				base: productionGraphQLRateLimitPolicy,
				observation: { ...observation, sustainableRps: 30 },
				evidence: "load-test/run-123.json",
			})
		).toThrow("exceeds the 40% headroom gate");
	});
});

describe("GraphQL v3 identity and workload isolation", () => {
	it("isolates one hundred Mini devices behind one NAT", () => {
		const abuseSubject = "same-nat";
		const devices = Array.from({ length: 100 }, (_, index) =>
			ingress({
				trafficClass: "mini",
				subject: `device-${index}`,
				abuseSubject,
				workload: "market",
			})
		);
		const abuseKeys = devices.map(
			(device) =>
				graphQLV3PreAuthRateLimitChecks(device, productionGraphQLRateLimitPolicy).find(
					(candidate) => candidate.id === "mini-ip-abuse-request"
				)?.key
		);
		expect(new Set(abuseKeys).size).toBe(1);
		const weightedKeys = devices.map(
			(device) =>
				graphQLV3PrincipalAdmission({
					ingress: device,
					principal: null,
					cost: 30,
					policy: productionGraphQLRateLimitPolicy,
				}).checks.find((candidate) => candidate.id === "mini-device-weighted")?.key
		);
		expect(new Set(weightedKeys).size).toBe(100);
		expect(
			graphQLV3PreAuthRateLimitChecks(devices[0]!, productionGraphQLRateLimitPolicy).find(
				(candidate) => candidate.id === "mini-ip-abuse-request"
			)
		).toMatchObject({ refillPerSecond: 100, burst: 1_200 });
	});

	it("keeps authenticated Mini users isolated from anonymous device buckets", () => {
		const device = ingress({ trafficClass: "mini", subject: "device", abuseSubject: "nat" });
		const anonymous = graphQLV3PrincipalAdmission({
			ingress: device,
			principal: null,
			cost: 1,
			policy: productionGraphQLRateLimitPolicy,
		});
		const firstUser = graphQLV3PrincipalAdmission({
			ingress: device,
			principal: principal("one"),
			cost: 1,
			policy: productionGraphQLRateLimitPolicy,
		});
		const secondUser = graphQLV3PrincipalAdmission({
			ingress: device,
			principal: principal("two"),
			cost: 1,
			policy: productionGraphQLRateLimitPolicy,
		});
		const anonymousWeighted = anonymous.checks.find(
			(candidate) => candidate.id === "mini-device-weighted"
		);
		const firstUserWeighted = firstUser.checks.find(
			(candidate) => candidate.id === "mini-session-weighted"
		);
		const secondUserWeighted = secondUser.checks.find(
			(candidate) => candidate.id === "mini-session-weighted"
		);
		expect(anonymousWeighted).toMatchObject({ refillPerSecond: 10, burst: 600 });
		expect(firstUserWeighted).toMatchObject({ refillPerSecond: 15, burst: 900 });
		expect(firstUserWeighted?.key).not.toBe(secondUserWeighted?.key);
		expect(firstUserWeighted?.key).not.toBe(anonymousWeighted?.key);
	});

	it("keeps Player Stats, Market, Fixtures, and service budgets separate", () => {
		const rsc = (workload: GraphQLWorkload) =>
			graphQLV3PrincipalAdmission({
				ingress: ingress({ trafficClass: "web_rsc", subject: "rsc", workload }),
				principal: null,
				cost: 20,
				policy: productionGraphQLRateLimitPolicy,
			}).checks.find((candidate) => candidate.id === `web-rsc-${workload}-weighted`)!;
		const playerStats = rsc("player-stats");
		const market = rsc("market");
		const fixtures = rsc("fixtures");
		const service = graphQLV3PrincipalAdmission({
			ingress: ingress({ trafficClass: "service", subject: "service" }),
			principal: null,
			cost: 20,
			policy: productionGraphQLRateLimitPolicy,
		}).checks.find((candidate) => candidate.id === "service-weighted")!;
		expect(new Set([playerStats.key, market.key, fixtures.key, service.key]).size).toBe(4);
		expect(playerStats.scope).toBe("workload");
		expect(service.id).toBe("service-weighted");
	});

	it("bounds Mini ingress before auth and keeps global with weighted admission", () => {
		expect(graphQLV3EarlyFailureRateLimitChecks(productionGraphQLRateLimitPolicy)).toEqual([
			expect.objectContaining({ id: "global-request", scope: "global", cost: 1 }),
		]);
		const miniChecks = graphQLV3PrincipalAdmission({
			ingress: ingress({
				trafficClass: "mini",
				subject: "one-device",
				abuseSubject: "shared-nat",
				workload: "market",
			}),
			principal: null,
			cost: 30,
			policy: productionGraphQLRateLimitPolicy,
		}).checks;
		expect(miniChecks.map((candidate) => candidate.id)).toEqual([
			"global-request",
			"mini-device-weighted",
		]);
		expect(
			graphQLV3PreAuthRateLimitChecks(
				ingress({
					trafficClass: "mini",
					subject: "one-device",
					abuseSubject: "shared-nat",
					workload: "market",
				}),
				productionGraphQLRateLimitPolicy
			).map((candidate) => candidate.id)
		).toEqual(["mini-ip-abuse-request"]);

		const rscChecks = graphQLV3PrincipalAdmission({
			ingress: ingress({
				trafficClass: "web_rsc",
				subject: "rsc",
				workload: "player-stats",
			}),
			principal: null,
			cost: 30,
			policy: productionGraphQLRateLimitPolicy,
		}).checks;
		expect(rscChecks.map((candidate) => candidate.id)).toEqual([
			"global-request",
			"web-rsc-class-request",
			"web-rsc-player-stats-weighted",
		]);
	});
});
