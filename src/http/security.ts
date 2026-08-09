import { createHash } from "crypto";
import { isIP } from "net";
import type Redis from "ioredis";
import type { Logger } from "../infra/logger";
import { metrics } from "../infra/metrics";

export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export class PayloadTooLargeError extends Error {
	readonly code = "PAYLOAD_TOO_LARGE";

	constructor() {
		super(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
		this.name = "PayloadTooLargeError";
	}
}

const normalizeIp = (value: string | null | undefined): string | null => {
	if (!value) return null;
	const candidate = value.trim();
	// Check the complete value first so an IPv6 address ending in digits is not
	// mistaken for an IPv4-style host:port pair.
	if (isIP(candidate)) return candidate;

	const bracketedHost = candidate.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1];
	if (bracketedHost && isIP(bracketedHost)) return bracketedHost;

	const host = candidate.match(/^([^:]+):\d+$/)?.[1];
	return host && isIP(host) ? host : null;
};

/**
 * Resolve the caller from the socket peer and only the explicitly trusted
 * right-most proxy hops. Untrusted left-most forwarding values are ignored.
 */
export const resolveClientIp = (
	headers: Headers,
	peerAddress: string | null | undefined,
	trustedProxyHops: number
): string => {
	const peer = normalizeIp(peerAddress) ?? "unknown";
	if (trustedProxyHops <= 0 || peer === "unknown") return peer;

	const forwarded = (headers.get("x-forwarded-for") ?? "")
		.split(",")
		.map((value) => normalizeIp(value));
	const chain = [...forwarded, peer];
	const clientIndex = chain.length - trustedProxyHops - 1;
	const candidate = clientIndex >= 0 ? chain[clientIndex] : null;
	return candidate ?? peer;
};

export const readRequestBody = async (
	request: Request,
	maxBytes = MAX_REQUEST_BODY_BYTES
): Promise<string> => {
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new PayloadTooLargeError();
	}
	if (!request.body) return "";

	const decoder = new TextDecoder();
	let size = 0;
	let body = "";
	const stream = request.body as unknown as AsyncIterable<Uint8Array>;
	for await (const value of stream) {
		size += value.byteLength;
		if (size > maxBytes) {
			throw new PayloadTooLargeError();
		}
		body += decoder.decode(value, { stream: true });
	}
	return body + decoder.decode();
};

const RATE_LIMIT_SCRIPT = `
local existed = redis.call('EXISTS', KEYS[1])
local count = redis.call('INCRBY', KEYS[1], ARGV[2])
local ttl = redis.call('TTL', KEYS[1])
if existed == 0 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

export type RateLimitResult = {
	allowed: boolean;
	retryAfterSeconds: number;
};

export const checkRateLimit = async (
	redis: Redis,
	key: string,
	limit: number,
	windowSeconds: number,
	cost = 1
): Promise<RateLimitResult> => {
	if (!Number.isInteger(cost) || cost < 1) {
		throw new Error("Rate-limit cost must be a positive integer");
	}
	const result = (await redis.eval(
		RATE_LIMIT_SCRIPT,
		1,
		key,
		String(windowSeconds),
		String(cost)
	)) as [number, number];
	const [count, ttl] = result;
	return {
		allowed: count <= limit,
		retryAfterSeconds: ttl >= 0 ? Math.max(1, ttl) : windowSeconds,
	};
};

export const rateLimitKey = (scope: string, ip: string): string => {
	const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 32);
	return `gql:v2:security:rate:${scope}:${ipHash}`;
};

export const handleRateLimitStorageFailure = ({
	error,
	failClosed,
	scope,
	logger,
}: {
	error: unknown;
	failClosed: boolean;
	scope: string;
	logger: Logger;
}): RateLimitResult => {
	metrics.rateLimitStorageFailures.labels(scope, failClosed ? "closed" : "open").inc();
	logger.warn({ err: error, scope, failClosed }, "Rate-limit storage unavailable");
	if (failClosed) throw error;
	return { allowed: true, retryAfterSeconds: 0 };
};
