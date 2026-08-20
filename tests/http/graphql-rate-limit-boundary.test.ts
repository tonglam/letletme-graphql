import { describe, expect, it } from "bun:test";
import type Redis from "ioredis";
import { graphQLPrincipalAdmission } from "../../src/http/graphql-policy";
import { checkRateLimits } from "../../src/http/security";

const config = {
	windowSeconds: 60,
	globalAdmission: 1_500,
	sharedPublic: 1_200,
	browserIngress: 120,
	authenticated: 300,
	anonymous: 120,
};

describe("authenticated GraphQL weighted boundary", () => {
	it("allows ten cost-30 picker operations and rejects the eleventh with Retry-After", async () => {
		let count = 0;
		const redis = {
			eval: async (...args: unknown[]) => {
				const cost = Number(args.at(-1));
				count += cost;
				return [count, 37];
			},
		} as unknown as Redis;
		const admission = graphQLPrincipalAdmission({
			ingress: {
				class: "signed",
				trusted: true,
				subject: "one-nat",
				abuseSubject: null,
				trafficClass: "legacy",
				workload: "public-other",
				ingressContext: {
					version: 1,
					subject: "one-nat",
					abuseSubject: null,
					trafficClass: "legacy",
					workload: "public-other",
				},
			},
			principal: {
				userId: "user-1",
				source: "website",
				fplEntryId: null,
				fplEntryVerifiedAt: null,
			},
			cost: 30,
			config,
		});

		for (let request = 1; request <= 10; request += 1) {
			await expect(checkRateLimits(redis, [admission.check])).resolves.toEqual({
				allowed: true,
				retryAfterSeconds: 0,
			});
		}
		await expect(checkRateLimits(redis, [admission.check])).resolves.toEqual({
			allowed: false,
			retryAfterSeconds: 37,
			deniedScope: "graphql-authenticated-v2",
			deniedCheckIndex: 0,
		});
	});

	it("admits twenty concurrent cost-41 public renders inside the shared budget", async () => {
		let count = 0;
		const redis = {
			eval: async (...args: unknown[]) => {
				count += Number(args.at(-1));
				return [count, 60];
			},
		} as unknown as Redis;
		const admission = graphQLPrincipalAdmission({
			ingress: {
				class: "service",
				trusted: true,
				subject: "service:web-public-rsc",
				abuseSubject: null,
				trafficClass: "service",
				workload: "public-other",
				ingressContext: null,
			},
			principal: null,
			cost: 41,
			config,
		});

		const results = await Promise.all(
			Array.from({ length: 20 }, () => checkRateLimits(redis, [admission.check]))
		);
		expect(results.every((result) => result.allowed)).toBe(true);
		expect(count).toBe(820);
	});
});
