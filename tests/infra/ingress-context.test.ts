import { createHmac } from "crypto";
import { describe, expect, test } from "bun:test";
import { env } from "../../src/infra/env";
import {
	classifyGraphQLIngress,
	GRAPHQL_SERVICE_RATE_LIMIT_SUBJECT,
	verifyGraphQLServiceToken,
	verifyIngressContext,
} from "../../src/infra/ingress-context";

const subject = "a".repeat(64);

const signed = (envelope: Record<string, unknown>, secret = env.BACKEND_PROXY_SECRET): Headers => {
	const payload = JSON.stringify(envelope);
	return new Headers({
		"X-Ingress-Context": Buffer.from(payload).toString("base64url"),
		"X-Ingress-Context-Sig": createHmac("sha256", secret).update(payload).digest("base64url"),
	});
};

describe("signed web ingress context", () => {
	test("accepts the exact canonical envelope for at most sixty seconds", () => {
		const headers = signed({ aud: "letletme-graphql", sub: subject, iat: 100, exp: 160 });
		expect(verifyIngressContext(headers, 120)).toEqual({ subject });
	});

	test("rejects spoofed, expired, overlong, wrong-audience, and extra-field envelopes", () => {
		const base = { aud: "letletme-graphql", sub: subject, iat: 100, exp: 160 };
		expect(verifyIngressContext(signed(base, "attacker-secret"), 120)).toBeNull();
		expect(verifyIngressContext(signed(base), 161)).toBeNull();
		expect(verifyIngressContext(signed({ ...base, exp: 161 }), 120)).toBeNull();
		expect(verifyIngressContext(signed({ ...base, aud: "other" }), 120)).toBeNull();
		expect(verifyIngressContext(signed({ ...base, unexpectedField: true }), 120)).toBeNull();
	});

	test("classifies signed ingress ahead of forwarded user credentials", () => {
		const headers = signed({ aud: "letletme-graphql", sub: subject, iat: 100, exp: 160 });
		headers.set("Authorization", `Bearer ${"b".repeat(43)}`);
		expect(
			classifyGraphQLIngress(headers, {
				ingressContext: verifyIngressContext(headers, 120),
				serviceTokenValid: true,
			})
		).toMatchObject({ class: "signed", trusted: true, subject });
	});

	test("accepts the server-only service token without creating a user principal", () => {
		const token = "s".repeat(43);
		const headers = new Headers({ "X-GraphQL-Service-Token": token });
		expect(verifyGraphQLServiceToken(headers, token)).toBe(true);
		expect(verifyGraphQLServiceToken(headers, `${token}x`)).toBe(false);
		expect(
			classifyGraphQLIngress(headers, { ingressContext: null, serviceTokenValid: true })
		).toEqual({
			class: "service",
			trusted: true,
			subject: GRAPHQL_SERVICE_RATE_LIMIT_SUBJECT,
			ingressContext: null,
		});
	});

	test("classifies every unsigned request as untrusted", () => {
		for (const headers of [
			new Headers({ Authorization: `Bearer ${"b".repeat(43)}` }),
			new Headers({ "X-User-Context": "spoofed" }),
			new Headers(),
		]) {
			expect(
				classifyGraphQLIngress(headers, { ingressContext: null, serviceTokenValid: false })
			).toMatchObject({ class: "untrusted", trusted: false, subject: null });
		}
	});

	test("does not let a service token carry unsigned user credentials", () => {
		const headers = new Headers({
			Authorization: `Bearer ${"b".repeat(43)}`,
			"X-GraphQL-Service-Token": "s".repeat(43),
		});
		expect(
			classifyGraphQLIngress(headers, { ingressContext: null, serviceTokenValid: true })
		).toMatchObject({ class: "untrusted", trusted: false });
	});
});
