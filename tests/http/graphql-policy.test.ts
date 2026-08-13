import { describe, expect, it } from "bun:test";
import {
	type GraphQLIngress,
	WEB_PUBLIC_RSC_RATE_LIMIT_SUBJECT,
} from "../../src/infra/ingress-context";
import {
	graphQLAdmissionSubjects,
	GRAPHQL_SHARED_PUBLIC_RATE_LIMIT,
	graphQLIngressFailure,
	graphQLMethodFailure,
	graphQLUsesSharedPublicBudget,
	graphQLWeightedRateLimitSubject,
	shouldPrechargeResolvedPrincipal,
} from "../../src/http/graphql-policy";

const ingress = (overrides: Partial<GraphQLIngress>): GraphQLIngress => ({
	class: "untrusted",
	trusted: false,
	subject: null,
	ingressContext: null,
	...overrides,
});

describe("GraphQL transport and ingress policy", () => {
	it("accepts POST and preflight but rejects GET", () => {
		expect(graphQLMethodFailure("POST")).toBeNull();
		expect(graphQLMethodFailure("OPTIONS")).toBeNull();
		expect(graphQLMethodFailure("GET")).toMatchObject({
			status: 405,
			code: "METHOD_NOT_ALLOWED",
		});
	});

	it("rejects every untrusted request", () => {
		expect(graphQLIngressFailure(ingress({}))).toMatchObject({
			status: 401,
			code: "UNTRUSTED_INGRESS",
		});
	});

	it("accepts signed and service ingress", () => {
		expect(
			graphQLIngressFailure(ingress({ class: "signed", trusted: true, subject: "signed" }))
		).toBeNull();
		expect(
			graphQLIngressFailure(ingress({ class: "service", trusted: true, subject: "service" }))
		).toBeNull();
	});

	it("uses the trusted ingress subject for admission and weighted limits", () => {
		const signed = ingress({ class: "signed", trusted: true, subject: "signed-client" });
		expect(graphQLAdmissionSubjects({ ingress: signed, principal: null })).toEqual({
			global: "all-graphql-traffic",
			ingress: "signed-client",
			prechargesWeightedBudget: true,
		});
		expect(graphQLWeightedRateLimitSubject({ ingress: signed, principal: null })).toBe(
			"signed-client"
		);
	});

	it("precharges a principal only when the ingress did not already consume a unit", () => {
		const principal = {
			userId: "user-1",
			source: "wechat_miniprogram" as const,
			provider: "wechat_miniprogram" as const,
			fplEntryId: 7,
			fplEntryVerifiedAt: "2026-08-03T00:00:00.000Z",
		};
		expect(shouldPrechargeResolvedPrincipal(principal, false)).toBe(true);
		expect(shouldPrechargeResolvedPrincipal(principal, true)).toBe(false);
		expect(shouldPrechargeResolvedPrincipal(null, false)).toBe(false);
	});

	it("assigns the larger shared-public budget only to trusted Web public ingress", () => {
		const service = ingress({ class: "service", trusted: true, subject: "service-public" });
		const publicRsc = ingress({
			class: "signed",
			trusted: true,
			subject: WEB_PUBLIC_RSC_RATE_LIMIT_SUBJECT,
		});
		const otherSigned = ingress({ class: "signed", trusted: true, subject: "signed-client" });
		expect(graphQLUsesSharedPublicBudget(service)).toBe(true);
		expect(graphQLUsesSharedPublicBudget(publicRsc)).toBe(true);
		expect(graphQLUsesSharedPublicBudget(otherSigned)).toBe(false);
	});

	it("keeps enough bounded shared-public budget for twenty uncached Home renders", () => {
		const homeWeightedCost = 41;
		expect(GRAPHQL_SHARED_PUBLIC_RATE_LIMIT).toBeGreaterThanOrEqual(homeWeightedCost * 20);
		expect(GRAPHQL_SHARED_PUBLIC_RATE_LIMIT).toBe(1_200);
	});
});
