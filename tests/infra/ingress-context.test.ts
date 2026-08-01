import { createHmac } from "crypto";
import { describe, expect, test } from "bun:test";
import { env } from "../../src/infra/env";
import { verifyIngressContext } from "../../src/infra/ingress-context";

const subject = "a".repeat(64);

const signed = (envelope: Record<string, unknown>, secret = env.BACKEND_PROXY_SECRET): Headers => {
	const payload = JSON.stringify(envelope);
	return new Headers({
		"X-Ingress-Context": Buffer.from(payload).toString("base64url"),
		"X-Ingress-Context-Sig": createHmac("sha256", secret).update(payload).digest("base64url"),
	});
};

describe("signed web ingress context", () => {
	test("accepts an opaque subject for at most sixty seconds", () => {
		const headers = signed({ v: 1, aud: "letletme-graphql", sub: subject, iat: 100, exp: 160 });
		expect(verifyIngressContext(headers, 120)).toEqual({ subject });
	});

	test("rejects spoofed, expired, overlong, and wrong-audience envelopes", () => {
		const base = { v: 1, aud: "letletme-graphql", sub: subject, iat: 100, exp: 160 };
		expect(verifyIngressContext(signed(base, "attacker-secret"), 120)).toBeNull();
		expect(verifyIngressContext(signed(base), 161)).toBeNull();
		expect(verifyIngressContext(signed({ ...base, exp: 161 }), 120)).toBeNull();
		expect(verifyIngressContext(signed({ ...base, aud: "other" }), 120)).toBeNull();
	});
});
