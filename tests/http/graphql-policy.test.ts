import { describe, expect, it } from "bun:test";
import {
	type GraphQLIngress,
	WEB_PUBLIC_RSC_RATE_LIMIT_SUBJECT,
} from "../../src/infra/ingress-context";
import type { Principal } from "../../src/infra/principal";
import {
	GRAPHQL_GLOBAL_ADMISSION_RATE_LIMIT,
	GRAPHQL_RATE_LIMIT_SCOPES,
	GRAPHQL_SHARED_PUBLIC_RATE_LIMIT,
	graphQLIngressFailure,
	graphQLMethodFailure,
	graphQLPreAuthRateLimitChecks,
	graphQLPrincipalAdmission,
	graphQLUsesSharedPublicBudget,
	hasAuthenticationMaterial,
	type GraphQLRateLimitConfig,
} from "../../src/http/graphql-policy";

const config: GraphQLRateLimitConfig = {
	browserIngress: 120,
	authenticated: 300,
	anonymous: 120,
};

const ingress = (overrides: Partial<GraphQLIngress>): GraphQLIngress => ({
	class: "untrusted",
	trusted: false,
	subject: null,
	ingressContext: null,
	...overrides,
});

const principal = (userId: string): Principal => ({
	userId,
	source: "website",
	provider: "better_auth",
	fplEntryId: null,
	fplEntryVerifiedAt: null,
});

describe("GraphQL transport and two-stage admission policy", () => {
	it("accepts POST and preflight but rejects GET", () => {
		expect(graphQLMethodFailure("POST")).toBeNull();
		expect(graphQLMethodFailure("OPTIONS")).toBeNull();
		expect(graphQLMethodFailure("GET")).toMatchObject({
			status: 405,
			code: "METHOD_NOT_ALLOWED",
		});
	});

	it("rejects untrusted requests while accepting signed and service ingress", () => {
		expect(graphQLIngressFailure(ingress({}))).toMatchObject({
			status: 401,
			code: "UNTRUSTED_INGRESS",
		});
		expect(
			graphQLIngressFailure(ingress({ class: "signed", trusted: true, subject: "signed" }))
		).toBeNull();
		expect(
			graphQLIngressFailure(ingress({ class: "service", trusted: true, subject: "service" }))
		).toBeNull();
	});

	it("uses fixed-cost global and browser ingress buckets before authentication", () => {
		const checks = graphQLPreAuthRateLimitChecks(
			ingress({ class: "signed", trusted: true, subject: "one-nat" }),
			config
		);

		expect(checks).toHaveLength(2);
		expect(checks.map(({ scope, limit, cost }) => ({ scope, limit, cost }))).toEqual([
			{
				scope: GRAPHQL_RATE_LIMIT_SCOPES.ingress,
				limit: GRAPHQL_GLOBAL_ADMISSION_RATE_LIMIT,
				cost: 1,
			},
			{ scope: GRAPHQL_RATE_LIMIT_SCOPES.ingress, limit: 120, cost: 1 },
		]);
		expect(checks[0]?.key).not.toBe(checks[1]?.key);
	});

	it("isolates authenticated weighted budgets behind the same NAT ingress gate", () => {
		const signed = ingress({ class: "signed", trusted: true, subject: "one-nat" });
		const firstPreAuth = graphQLPreAuthRateLimitChecks(signed, config);
		const secondPreAuth = graphQLPreAuthRateLimitChecks(signed, config);
		const first = graphQLPrincipalAdmission({
			ingress: signed,
			principal: principal("user-1"),
			cost: 30,
			config,
		});
		const second = graphQLPrincipalAdmission({
			ingress: signed,
			principal: principal("user-2"),
			cost: 30,
			config,
		});

		expect(firstPreAuth[1]?.key).toBe(secondPreAuth[1]?.key);
		expect(first.audience).toBe("authenticated");
		expect(first.check).toMatchObject({
			scope: GRAPHQL_RATE_LIMIT_SCOPES.authenticated,
			limit: 300,
			cost: 30,
		});
		expect(first.check.key).not.toBe(second.check.key);
	});

	it("keeps anonymous requests on the signed ingress subject", () => {
		const signed = ingress({ class: "signed", trusted: true, subject: "one-nat" });
		const first = graphQLPrincipalAdmission({ ingress: signed, principal: null, cost: 30, config });
		const second = graphQLPrincipalAdmission({ ingress: signed, principal: null, cost: 1, config });
		expect(first.audience).toBe("anonymous");
		expect(first.check).toMatchObject({
			scope: GRAPHQL_RATE_LIMIT_SCOPES.anonymous,
			limit: 120,
			cost: 30,
		});
		expect(first.check.key).toBe(second.check.key);
	});

	it("assigns one shared 1200-unit budget to public RSC and service ingress", () => {
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

		const serviceAdmission = graphQLPrincipalAdmission({
			ingress: service,
			principal: null,
			cost: 41,
			config,
		});
		const rscAdmission = graphQLPrincipalAdmission({
			ingress: publicRsc,
			principal: null,
			cost: 41,
			config,
		});
		expect(serviceAdmission.check.key).toBe(rscAdmission.check.key);
		expect(serviceAdmission.check).toMatchObject({
			scope: GRAPHQL_RATE_LIMIT_SCOPES.sharedPublic,
			limit: GRAPHQL_SHARED_PUBLIC_RATE_LIMIT,
			cost: 41,
		});
		expect(GRAPHQL_SHARED_PUBLIC_RATE_LIMIT).toBeGreaterThanOrEqual(41 * 20);
	});

	it("uses only the four versioned Redis scopes", () => {
		expect(GRAPHQL_RATE_LIMIT_SCOPES).toEqual({
			ingress: "graphql-ingress-v2",
			authenticated: "graphql-authenticated-v2",
			anonymous: "graphql-anonymous-v2",
			sharedPublic: "graphql-shared-public-v2",
		});
	});

	it("detects invalid credential material before weighted admission", () => {
		expect(hasAuthenticationMaterial(new Headers({ Authorization: "Bearer invalid" }))).toBe(true);
		expect(hasAuthenticationMaterial(new Headers({ "X-User-Context": "invalid" }))).toBe(true);
		expect(hasAuthenticationMaterial(new Headers())).toBe(false);
	});
});
