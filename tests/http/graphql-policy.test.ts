import { describe, expect, it } from "bun:test";
import type { GraphQLIngress } from "../../src/infra/ingress-context";
import {
	graphQLIngressFailure,
	graphQLMethodFailure,
	hasAuthenticationMaterial,
} from "../../src/http/graphql-policy";

const ingress = (overrides: Partial<GraphQLIngress>): GraphQLIngress => ({
	class: "untrusted",
	trusted: false,
	subject: null,
	abuseSubject: null,
	trafficClass: "untrusted",
	workload: "public-other",
	ingressContext: null,
	...overrides,
});

describe("GraphQL transport and trust boundary", () => {
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

	it("detects invalid credential material before weighted admission", () => {
		expect(hasAuthenticationMaterial(new Headers({ Authorization: "Bearer invalid" }))).toBe(true);
		expect(hasAuthenticationMaterial(new Headers({ "X-User-Context": "invalid" }))).toBe(true);
		expect(hasAuthenticationMaterial(new Headers())).toBe(false);
	});
});
