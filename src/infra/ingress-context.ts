import { createHash, createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";
import { hasExactFields } from "./exact-fields";

type IngressEnvelope = {
	aud?: unknown;
	sub?: unknown;
	iat?: unknown;
	exp?: unknown;
};

export type VerifiedIngressContext = { subject: string };

export const GRAPHQL_SERVICE_TOKEN_HEADER = "X-GraphQL-Service-Token";
export const GRAPHQL_SERVICE_RATE_LIMIT_SUBJECT = "service:web-public-rsc";
// Must mirror letletme-web's fixed public RSC ingress purpose. The HMAC keeps
// this shared budget unavailable to arbitrary signed user/client subjects.
export const WEB_PUBLIC_RSC_RATE_LIMIT_SUBJECT = createHmac("sha256", env.BACKEND_PROXY_SECRET)
	.update("rate-limit:web-public-rsc")
	.digest("hex");

export type GraphQLIngressClass = "signed" | "service" | "untrusted";

export type GraphQLIngress = {
	class: GraphQLIngressClass;
	trusted: boolean;
	subject: string | null;
	ingressContext: VerifiedIngressContext | null;
};

const equalBase64Url = (left: string, right: string): boolean => {
	if (!/^[A-Za-z0-9_-]+$/.test(left) || !/^[A-Za-z0-9_-]+$/.test(right)) return false;
	const actual = Buffer.from(left);
	const expected = Buffer.from(right);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const equalSecret = (left: string, right: string): boolean => {
	const actual = createHash("sha256").update(left).digest();
	const expected = createHash("sha256").update(right).digest();
	return timingSafeEqual(actual, expected);
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
		!hasExactFields(envelope, ["aud", "sub", "iat", "exp"]) ||
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

export const verifyGraphQLServiceToken = (
	headers: Headers,
	configuredToken = env.GRAPHQL_SERVICE_TOKEN
): boolean => {
	const provided = headers.get(GRAPHQL_SERVICE_TOKEN_HEADER);
	return Boolean(configuredToken && provided && equalSecret(provided, configuredToken));
};

export const classifyGraphQLIngress = (
	headers: Headers,
	options: {
		ingressContext?: VerifiedIngressContext | null;
		serviceTokenValid?: boolean;
	} = {}
): GraphQLIngress => {
	const ingressContext = options.ingressContext ?? verifyIngressContext(headers);
	if (ingressContext) {
		return {
			class: "signed",
			trusted: true,
			subject: ingressContext.subject,
			ingressContext,
		};
	}
	if (
		headers.has("X-User-Context") ||
		headers.has("X-User-Context-Sig") ||
		/^bearer\s+\S+$/i.test(headers.get("Authorization") ?? "")
	) {
		return {
			class: "untrusted",
			trusted: false,
			subject: null,
			ingressContext: null,
		};
	}

	const serviceTokenValid = options.serviceTokenValid ?? verifyGraphQLServiceToken(headers);
	if (serviceTokenValid) {
		return {
			class: "service",
			trusted: true,
			subject: GRAPHQL_SERVICE_RATE_LIMIT_SUBJECT,
			ingressContext: null,
		};
	}

	return {
		class: "untrusted",
		trusted: false,
		subject: null,
		ingressContext: null,
	};
};
