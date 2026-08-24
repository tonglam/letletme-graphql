import { describe, expect, it } from "bun:test";
import {
	graphQLV4PreAuthRateLimitChecks,
	graphQLV4PrincipalAdmission,
} from "../../src/http/graphql-policy-v4";
import {
	parseGraphQLRateLimitPolicyV4,
	productionGraphQLRateLimitPolicyV4,
} from "../../src/http/rate-limit-policy-v4";
import {
	generateValidatedRateLimitProfileV4,
	type RateLimitTargetObservationV4,
} from "../../src/http/rate-limit-profile-generator-v4";
import type { GraphQLIngress, GraphQLWorkload } from "../../src/infra/ingress-context";
import type { Principal } from "../../src/infra/principal";

const ingress = (workload: GraphQLWorkload, subject = "device-a"): GraphQLIngress => ({
	class: "signed",
	trusted: true,
	subject,
	abuseSubject: "nat-a",
	trafficClass: "mini",
	workload,
	ingressContext: null,
});

const principal = (userId: string): Principal => ({
	userId,
	source: "wechat_miniprogram",
	fplEntryId: null,
	fplEntryVerifiedAt: null,
});

describe("GraphQL v4 Mini workload policy", () => {
	it("requires exact v4 policy and aggregate capacities equal workload sums", () => {
		expect(productionGraphQLRateLimitPolicyV4.policyVersion).toBe("graphql-v4");
		const anonymous = productionGraphQLRateLimitPolicyV4.trafficClasses.mini.anonymousWorkloads;
		const aggregate =
			productionGraphQLRateLimitPolicyV4.trafficClasses.mini.aggregateAnonymousWeighted;
		expect(aggregate.refillPerSecond).toBe(
			Object.values(anonymous).reduce((sum, bucket) => sum + bucket.refillPerSecond, 0)
		);
		expect(aggregate.burst).toBe(
			Object.values(anonymous).reduce((sum, bucket) => sum + bucket.burst, 0)
		);
		const invalid = JSON.parse(JSON.stringify(productionGraphQLRateLimitPolicyV4)) as unknown as {
			trafficClasses: {
				mini: {
					aggregateAnonymousWeighted: { refillPerSecond: number };
				};
			};
		};
		invalid.trafficClasses.mini.aggregateAnonymousWeighted.refillPerSecond += 1;
		expect(() => parseGraphQLRateLimitPolicyV4(invalid)).toThrow("aggregate ceiling");
	});

	it("keeps one device aggregate protection while isolating workload buckets", () => {
		const playerStats = graphQLV4PrincipalAdmission({
			ingress: ingress("player-stats"),
			principal: null,
			cost: 5,
			policy: productionGraphQLRateLimitPolicyV4,
		});
		const fixtures = graphQLV4PrincipalAdmission({
			ingress: ingress("fixtures"),
			principal: null,
			cost: 5,
			policy: productionGraphQLRateLimitPolicyV4,
		});
		expect(playerStats.checks.map((check) => check.id)).toEqual([
			"v4-global-request",
			"mini-device-aggregate-weighted",
			"mini-device-player-stats-weighted",
		]);
		expect(new Set([playerStats.checks[1]?.key, fixtures.checks[1]?.key]).size).toBe(1);
		expect(playerStats.checks[2]?.key).not.toBe(fixtures.checks[2]?.key);
		expect(playerStats.checks[2]?.scope).toBe("workload");
	});

	it("isolates principals and keeps the IP abuse guard pre-auth", () => {
		const checks = graphQLV4PreAuthRateLimitChecks(
			ingress("market"),
			productionGraphQLRateLimitPolicyV4
		);
		expect(checks[0]).toMatchObject({ id: "mini-v4-ip-abuse-request", scope: "client" });
		const first = graphQLV4PrincipalAdmission({
			ingress: ingress("player-stats", "device-a"),
			principal: principal("one"),
			cost: 5,
			policy: productionGraphQLRateLimitPolicyV4,
		});
		const second = graphQLV4PrincipalAdmission({
			ingress: ingress("player-stats", "device-a"),
			principal: principal("two"),
			cost: 5,
			policy: productionGraphQLRateLimitPolicyV4,
		});
		expect(first.checks[1]?.key).not.toBe(second.checks[1]?.key);
		expect(first.checks[2]?.key).not.toBe(second.checks[2]?.key);
	});

	it("generates v4 workload refill with measured rate plus headroom", () => {
		const workloads = {
			interactive: 0,
			home: 0,
			fixtures: 2,
			market: 0,
			"player-stats": 4,
			gameweek: 0,
			"public-other": 0,
		} satisfies Record<GraphQLWorkload, number>;
		const maxCost = {
			interactive: 0,
			home: 0,
			fixtures: 5,
			market: 0,
			"player-stats": 40,
			gameweek: 0,
			"public-other": 0,
		} satisfies Record<GraphQLWorkload, number>;
		const observation: RateLimitTargetObservationV4 = {
			targetConcurrent: 300,
			sustainableRps: 40,
			totalRequestPerSecond: 20,
			webRsc: {
				classRequestPerSecond: 1,
				workloadWeightedPerSecond: workloads,
				workloadMaxCost: maxCost,
			},
			service: { classRequestPerSecond: 1, weightedPerSecond: 1, maxWeightedCost: 5 },
			mini: {
				anonymousWeightedPerSecond: workloads,
				anonymousMaxCost: maxCost,
				sessionWeightedPerSecond: workloads,
				sessionMaxCost: maxCost,
			},
		};
		const generated = generateValidatedRateLimitProfileV4({
			base: productionGraphQLRateLimitPolicyV4,
			observation,
			evidence: "load-test/v4-run-1",
		});
		expect(generated.trafficClasses.mini.anonymousWorkloads.fixtures.refillPerSecond).toBe(3);
		expect(generated.trafficClasses.mini.anonymousWorkloads["player-stats"].burst).toBe(50);
		expect(generated.capacity.validated).toBe(true);
	});
});
