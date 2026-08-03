import { describe, expect, it } from "bun:test";
import type { GraphQLIngress } from "../../src/infra/ingress-context";
import {
	graphQLIngressFailure,
	graphQLCompatibilityAdmissionSubject,
	graphQLMethodFailure,
	graphQLWeightedRateLimitSubject,
	requiresCompatibilityAdmission,
} from "../../src/http/graphql-policy";

const ingress = (overrides: Partial<GraphQLIngress>): GraphQLIngress => ({
	class: "anonymous",
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

	it("allows compatibility traffic only before trusted ingress enforcement", () => {
		const anonymous = ingress({});
		expect(graphQLIngressFailure(anonymous, false)).toBeNull();
		expect(graphQLIngressFailure(anonymous, true)).toMatchObject({
			status: 401,
			code: "UNTRUSTED_INGRESS",
		});
	});

	it("accepts signed and service ingress without treating the service as a user", () => {
		expect(
			graphQLIngressFailure(ingress({ class: "signed", trusted: true, subject: "signed" }), true)
		).toBeNull();
		expect(
			graphQLIngressFailure(ingress({ class: "service", trusted: true, subject: "service" }), true)
		).toBeNull();
	});

	it("allows legacy website envelopes only during compatibility mode", () => {
		const legacyWebsite = ingress({ class: "unsigned_user_context" });
		expect(graphQLIngressFailure(legacyWebsite, false)).toBeNull();
		expect(graphQLIngressFailure(legacyWebsite, true)).toMatchObject({
			status: 401,
			code: "INVALID_INGRESS_CONTEXT",
		});
	});

	it("admits untrusted compatibility traffic through a separate request bucket", () => {
		expect(requiresCompatibilityAdmission(ingress({ class: "unsigned_bearer" }))).toBe(true);
		expect(requiresCompatibilityAdmission(ingress({ class: "unsigned_user_context" }))).toBe(true);
		expect(requiresCompatibilityAdmission(ingress({ class: "anonymous" }))).toBe(false);
		expect(requiresCompatibilityAdmission(ingress({ class: "signed", trusted: true }))).toBe(false);
	});

	it("separates compatibility admission without exposing credentials", () => {
		const firstToken = "first-secret-token";
		const secondToken = "second-secret-token";
		const firstSubject = graphQLCompatibilityAdmissionSubject({
			headers: new Headers({ Authorization: `Bearer ${firstToken}` }),
			ingress: ingress({ class: "unsigned_bearer" }),
			principal: null,
			fallbackSubject: "127.0.0.1",
		});
		const secondSubject = graphQLCompatibilityAdmissionSubject({
			headers: new Headers({ Authorization: `Bearer ${secondToken}` }),
			ingress: ingress({ class: "unsigned_bearer" }),
			principal: null,
			fallbackSubject: "127.0.0.1",
		});
		expect(firstSubject).not.toBe(secondSubject);
		expect(firstSubject).not.toContain(firstToken);
		expect(secondSubject).not.toContain(secondToken);
	});

	it("separates validated compatibility users from shared network subjects", () => {
		const unsigned = ingress({ class: "unsigned_bearer" });
		expect(
			graphQLWeightedRateLimitSubject({
				ingress: unsigned,
				principal: {
					userId: "user-1",
					source: "wechat_miniprogram",
					provider: "wechat_miniprogram",
					fplEntryId: 7,
					fplEntryVerifiedAt: "2026-08-03T00:00:00.000Z",
				},
				fallbackSubject: "203.0.113.1",
			})
		).toBe("principal:wechat_miniprogram:user-1");
		expect(
			graphQLWeightedRateLimitSubject({
				ingress: unsigned,
				principal: null,
				fallbackSubject: "203.0.113.1",
			})
		).toBe("203.0.113.1");
	});
});
