import { createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";

type IngressEnvelope = {
	v?: unknown;
	aud?: unknown;
	sub?: unknown;
	iat?: unknown;
	exp?: unknown;
};

export type VerifiedIngressContext = { subject: string };

const equalBase64Url = (left: string, right: string): boolean => {
	if (!/^[A-Za-z0-9_-]+$/.test(left) || !/^[A-Za-z0-9_-]+$/.test(right)) return false;
	const actual = Buffer.from(left);
	const expected = Buffer.from(right);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** Verify the short-lived, opaque ingress subject signed by letletme-web. */
export const verifyIngressContext = (
	headers: Headers,
	nowSeconds = Math.floor(Date.now() / 1000)
): VerifiedIngressContext | null => {
	if (!env.BACKEND_PROXY_SECRET) return null;
	const contextHeader = headers.get("X-Ingress-Context");
	const signature = headers.get("X-Ingress-Context-Sig");
	if (!contextHeader || !signature) return null;

	let payload: string;
	let envelope: IngressEnvelope;
	try {
		payload = Buffer.from(contextHeader, "base64url").toString("utf8");
		envelope = JSON.parse(payload) as IngressEnvelope;
	} catch {
		return null;
	}

	const expected = createHmac("sha256", env.BACKEND_PROXY_SECRET)
		.update(payload)
		.digest("base64url");
	if (!equalBase64Url(signature, expected)) return null;

	const issuedAt =
		typeof envelope.iat === "number" && Number.isSafeInteger(envelope.iat) ? envelope.iat : null;
	const expiresAt =
		typeof envelope.exp === "number" && Number.isSafeInteger(envelope.exp) ? envelope.exp : null;
	if (
		envelope.v !== 1 ||
		envelope.aud !== "letletme-graphql" ||
		typeof envelope.sub !== "string" ||
		!/^[a-f0-9]{64}$/.test(envelope.sub) ||
		issuedAt === null ||
		expiresAt === null ||
		issuedAt > nowSeconds + 5 ||
		expiresAt < nowSeconds ||
		expiresAt - issuedAt > 60
	)
		return null;

	return { subject: envelope.sub };
};
