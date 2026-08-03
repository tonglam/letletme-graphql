import { describe, expect, it } from "bun:test";
import type { GraphQLIngress } from "../../src/infra/ingress-context";
import { graphQLIngressFailure, graphQLMethodFailure } from "../../src/http/graphql-policy";

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

	it("rejects an unsigned user envelope even in compatibility mode", () => {
		expect(graphQLIngressFailure(ingress({ class: "unsigned_user_context" }), false)).toMatchObject(
			{ status: 401, code: "INVALID_INGRESS_CONTEXT" }
		);
	});
});
