import { createHash } from "crypto";
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
local results = {}
local offset = 1
for index, key in ipairs(KEYS) do
  local window = ARGV[offset]
  local cost = ARGV[offset + 1]
  local existed = redis.call('EXISTS', key)
  local count = redis.call('INCRBY', key, cost)
  local ttl = redis.call('TTL', key)
  if existed == 0 or ttl < 0 then
    redis.call('EXPIRE', key, window)
  end
  ttl = redis.call('TTL', key)
  table.insert(results, count)
  table.insert(results, ttl)
  offset = offset + 2
end
return results
`;

export type RateLimitResult = {
	allowed: boolean;
	retryAfterSeconds: number;
};

export type RateLimitCheck = {
	scope: string;
	key: string;
	limit: number;
	windowSeconds: number;
	cost?: number;
};

export type RateLimitBatchResult = RateLimitResult & {
	deniedScope?: string;
};

export const checkRateLimits = async (
	redis: Redis,
	checks: readonly RateLimitCheck[]
): Promise<RateLimitBatchResult> => {
	if (checks.length === 0) {
		throw new Error("At least one rate-limit check is required");
	}

	for (const check of checks) {
		const cost = check.cost ?? 1;
		if (!Number.isInteger(cost) || cost < 1) {
			throw new Error("Rate-limit cost must be a positive integer");
		}
		if (!Number.isInteger(check.limit) || check.limit < 1) {
			throw new Error("Rate-limit limit must be a positive integer");
		}
		if (!Number.isInteger(check.windowSeconds) || check.windowSeconds < 1) {
			throw new Error("Rate-limit window must be a positive integer");
		}
	}

	const result = (await redis.eval(
		RATE_LIMIT_SCRIPT,
		checks.length,
		...checks.map((check) => check.key),
		...checks.flatMap((check) => [String(check.windowSeconds), String(check.cost ?? 1)])
	)) as number[];

	const decisions = checks.map((check, index) => {
		const count = Number(result[index * 2]);
		const ttl = Number(result[index * 2 + 1]);
		return {
			scope: check.scope,
			allowed: count <= check.limit,
			retryAfterSeconds: Number.isFinite(ttl) && ttl >= 0 ? Math.max(1, ttl) : check.windowSeconds,
		};
	});
	const denied = decisions.filter((decision) => !decision.allowed);
	return {
		allowed: denied.length === 0,
		retryAfterSeconds:
			denied.length > 0 ? Math.max(...denied.map((decision) => decision.retryAfterSeconds)) : 0,
		...(denied[0] ? { deniedScope: denied[0].scope } : {}),
	};
};

export const checkRateLimit = async (
	redis: Redis,
	key: string,
	limit: number,
	windowSeconds: number,
	cost = 1
): Promise<RateLimitResult> => {
	const { allowed, retryAfterSeconds } = await checkRateLimits(redis, [
		{ scope: key, key, limit, windowSeconds, cost },
	]);
	return { allowed, retryAfterSeconds };
};

export const rateLimitKey = (scope: string, ip: string): string => {
	const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 32);
	return `llm:gql:security:rate:${scope}:${ipHash}`;
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
