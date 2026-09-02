import { createHash } from "crypto";
import type Redis from "ioredis";
import type { TokenBucketPolicy } from "./rate-limit-policy-v3";

export type GraphQLRateLimitHeaderScope = "global" | "client" | "workload";

export type TokenBucketCheckV3 = TokenBucketPolicy & {
	readonly id: string;
	readonly scope: GraphQLRateLimitHeaderScope;
	readonly key: string;
	readonly cost?: number;
};

export type TokenBucketDetailV3 = {
	readonly id: string;
	readonly scope: GraphQLRateLimitHeaderScope;
	readonly cost: number;
	readonly refillPerSecond: number;
	readonly burst: number;
	readonly remainingMilliTokens: number;
};

export type TokenBucketStageResultV3 = {
	readonly allowed: boolean;
	readonly retryAfterSeconds: number;
	readonly deniedScope?: GraphQLRateLimitHeaderScope;
	readonly deniedBucketId?: string;
	readonly details: readonly TokenBucketDetailV3[];
};

/**
 * Continuous token bucket using Redis server time. All keys in one stage are
 * evaluated first; a denial updates refill timestamps but deducts no tokens.
 */
export const TOKEN_BUCKET_V3_SCRIPT = `
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local states = {}
local denied_index = 0
local retry_after = 0
local offset = 1

for index, key in ipairs(KEYS) do
  local refill_per_second = tonumber(ARGV[offset])
  local burst = tonumber(ARGV[offset + 1])
  local cost = tonumber(ARGV[offset + 2])
  local burst_milli = burst * 1000
  local cost_milli = cost * 1000
  local stored = redis.call('HMGET', key, 'tokens', 'updated_ms')
  local tokens = tonumber(stored[1]) or burst_milli
  local updated_ms = tonumber(stored[2]) or now_ms
  local elapsed_ms = math.max(0, now_ms - updated_ms)
  tokens = math.min(burst_milli, tokens + math.floor(elapsed_ms * refill_per_second))
  states[index] = {
    tokens = tokens,
    cost_milli = cost_milli,
    refill_per_second = refill_per_second,
    burst = burst
  }
  if tokens < cost_milli then
    local deficit = cost_milli - tokens
    local wait_seconds = math.max(1, math.ceil(deficit / (refill_per_second * 1000)))
    if denied_index == 0 then denied_index = index end
    retry_after = math.max(retry_after, wait_seconds)
  end
  offset = offset + 3
end

local allowed = denied_index == 0
local result = { allowed and 1 or 0, retry_after, denied_index }
for index, key in ipairs(KEYS) do
  local state = states[index]
  local remaining = state.tokens
  if allowed then remaining = remaining - state.cost_milli end
  redis.call('HSET', key, 'tokens', remaining, 'updated_ms', now_ms)
  local ttl_seconds = math.max(120, math.ceil((2 * state.burst) / state.refill_per_second))
  redis.call('EXPIRE', key, ttl_seconds)
  table.insert(result, remaining)
end
return result
`;

/**
 * Shadow-mode admission keeps the global emergency valve enforcing while the
 * remaining buckets are observational.  Evaluating those two stages in one
 * script preserves the ordering and debit rules without putting two Redis
 * round trips on every trusted request.
 *
 * Return shape:
 *   [selected_stage, allowed, retry_after, denied_index, remaining...]
 * where selected_stage is 1 for global and 2 for observational checks.
 * A global denial deliberately returns before touching observational keys.
 */
export const TOKEN_BUCKET_SHADOW_STAGE_SCRIPT = `
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local global_count = tonumber(ARGV[1])
local states = {}
local offset = 2

local load_state = function(index, key)
  local refill_per_second = tonumber(ARGV[offset])
  local burst = tonumber(ARGV[offset + 1])
  local cost = tonumber(ARGV[offset + 2])
  local burst_milli = burst * 1000
  local cost_milli = cost * 1000
  local stored = redis.call('HMGET', key, 'tokens', 'updated_ms')
  local tokens = tonumber(stored[1]) or burst_milli
  local updated_ms = tonumber(stored[2]) or now_ms
  local elapsed_ms = math.max(0, now_ms - updated_ms)
  tokens = math.min(burst_milli, tokens + math.floor(elapsed_ms * refill_per_second))
  states[index] = {
    tokens = tokens,
    cost_milli = cost_milli,
    refill_per_second = refill_per_second,
    burst = burst
  }
  offset = offset + 3
end

for index = 1, global_count do
  load_state(index, KEYS[index])
end

local global_denied_index = 0
local global_retry_after = 0
for index = 1, global_count do
  local state = states[index]
  if state.tokens < state.cost_milli then
    local deficit = state.cost_milli - state.tokens
    local wait_seconds = math.max(1, math.ceil(deficit / (state.refill_per_second * 1000)))
    if global_denied_index == 0 then global_denied_index = index end
    global_retry_after = math.max(global_retry_after, wait_seconds)
  end
end

local persist_state = function(index, deduct)
  local key = KEYS[index]
  local state = states[index]
  local remaining = state.tokens
  if deduct then remaining = remaining - state.cost_milli end
  redis.call('HSET', key, 'tokens', remaining, 'updated_ms', now_ms)
  local ttl_seconds = math.max(120, math.ceil((2 * state.burst) / state.refill_per_second))
  redis.call('EXPIRE', key, ttl_seconds)
  return remaining
end

if global_denied_index ~= 0 then
  local result = { 1, 0, global_retry_after, global_denied_index }
  for index = 1, global_count do
    table.insert(result, persist_state(index, false))
  end
  return result
end

for index = 1, global_count do
  persist_state(index, true)
end

local observation_start = global_count + 1
local observation_denied_index = 0
local observation_retry_after = 0
for index = observation_start, #KEYS do
  load_state(index, KEYS[index])
  local state = states[index]
  if state.tokens < state.cost_milli then
    local deficit = state.cost_milli - state.tokens
    local wait_seconds = math.max(1, math.ceil(deficit / (state.refill_per_second * 1000)))
    local relative_index = index - global_count
    if observation_denied_index == 0 then observation_denied_index = relative_index end
    observation_retry_after = math.max(observation_retry_after, wait_seconds)
  end
end

local observation_allowed = observation_denied_index == 0
local result = { 2, observation_allowed and 1 or 0, observation_retry_after, observation_denied_index }
for index = observation_start, #KEYS do
  table.insert(result, persist_state(index, observation_allowed))
end
return result
`;

const positiveInteger = (value: number, label: string): void => {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
};

const validateChecks = (checks: readonly TokenBucketCheckV3[]): void => {
	for (const check of checks) {
		positiveInteger(check.refillPerSecond, `${check.id}.refillPerSecond`);
		positiveInteger(check.burst, `${check.id}.burst`);
		positiveInteger(check.cost ?? 1, `${check.id}.cost`);
	}
};

export const tokenBucketKeyV3 = (id: string, subject: string): string => {
	if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error("Invalid token-bucket id");
	const subjectHash = createHash("sha256").update(subject).digest("hex").slice(0, 32);
	return `llm:gql:security:rate:v3:${id}:${subjectHash}`;
};

/** v4 uses a distinct keyspace so shadow traffic cannot mutate v3 state. */
export const tokenBucketKeyV4 = (id: string, subject: string): string => {
	if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error("Invalid token-bucket id");
	const subjectHash = createHash("sha256").update(subject).digest("hex").slice(0, 32);
	return `llm:gql:security:rate:v4:${id}:${subjectHash}`;
};

export const checkTokenBucketStageV3 = async (
	redis: Redis,
	checks: readonly TokenBucketCheckV3[]
): Promise<TokenBucketStageResultV3> => {
	if (checks.length === 0) throw new Error("At least one v3 token bucket is required");
	validateChecks(checks);

	const raw = (await redis.eval(
		TOKEN_BUCKET_V3_SCRIPT,
		checks.length,
		...checks.map((check) => check.key),
		...checks.flatMap((check) => [
			String(check.refillPerSecond),
			String(check.burst),
			String(check.cost ?? 1),
		])
	)) as Array<number | string>;
	const allowed = Number(raw[0]) === 1;
	const retryAfterSeconds = Math.max(0, Number(raw[1]) || 0);
	const deniedIndex = Number(raw[2]) || 0;
	const details = checks.map((check, index): TokenBucketDetailV3 => ({
		id: check.id,
		scope: check.scope,
		cost: check.cost ?? 1,
		refillPerSecond: check.refillPerSecond,
		burst: check.burst,
		remainingMilliTokens: Number(raw[index + 3]) || 0,
	}));
	const denied = deniedIndex > 0 ? details[deniedIndex - 1] : undefined;
	return {
		allowed,
		retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds),
		...(denied ? { deniedScope: denied.scope, deniedBucketId: denied.id } : {}),
		details,
	};
};

/**
 * Evaluate the enforcing global stage and observational stage atomically.
 * Global denial never evaluates or mutates observational buckets. When the
 * global stage allows, its debit is retained even if an observational bucket
 * would deny, matching the existing sequential shadow-mode behavior.
 */
export const checkTokenBucketShadowStageV3 = async (
	redis: Redis,
	globalChecks: readonly TokenBucketCheckV3[],
	observationalChecks: readonly TokenBucketCheckV3[]
): Promise<TokenBucketStageResultV3> => {
	if (globalChecks.length === 0) throw new Error("At least one global token bucket is required");
	if (observationalChecks.length === 0)
		throw new Error("At least one observational token bucket is required");
	const checks = [...globalChecks, ...observationalChecks];
	validateChecks(checks);
	const raw = (await redis.eval(
		TOKEN_BUCKET_SHADOW_STAGE_SCRIPT,
		checks.length,
		...checks.map((check) => check.key),
		String(globalChecks.length),
		...checks.flatMap((check) => [
			String(check.refillPerSecond),
			String(check.burst),
			String(check.cost ?? 1),
		])
	)) as Array<number | string>;
	const selectedChecks = Number(raw[0]) === 1 ? globalChecks : observationalChecks;
	const allowed = Number(raw[1]) === 1;
	const retryAfterSeconds = Math.max(0, Number(raw[2]) || 0);
	const deniedIndex = Number(raw[3]) || 0;
	const details = selectedChecks.map((check, index): TokenBucketDetailV3 => ({
		id: check.id,
		scope: check.scope,
		cost: check.cost ?? 1,
		refillPerSecond: check.refillPerSecond,
		burst: check.burst,
		remainingMilliTokens: Number(raw[index + 4]) || 0,
	}));
	const denied = deniedIndex > 0 ? details[deniedIndex - 1] : undefined;
	return {
		allowed,
		retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds),
		...(denied ? { deniedScope: denied.scope, deniedBucketId: denied.id } : {}),
		details,
	};
};

export type TokenBucketState = {
	readonly tokensMilli: number;
	readonly updatedAtMs: number;
};

/** Deterministic reference model used to verify refill and no-deduction semantics. */
export const evaluateTokenBucketStageV3 = ({
	checks,
	states,
	nowMs,
}: {
	checks: readonly Pick<
		TokenBucketCheckV3,
		"id" | "scope" | "cost" | "burst" | "refillPerSecond"
	>[];
	states: Readonly<Record<string, TokenBucketState | undefined>>;
	nowMs: number;
}): { result: TokenBucketStageResultV3; states: Record<string, TokenBucketState> } => {
	const replenished = checks.map((check) => {
		const current = states[check.id] ?? {
			tokensMilli: check.burst * 1000,
			updatedAtMs: nowMs,
		};
		return Math.min(
			check.burst * 1000,
			current.tokensMilli + Math.max(0, nowMs - current.updatedAtMs) * check.refillPerSecond
		);
	});
	const deniedIndexes = checks
		.map((check, index) => ({ index, deficit: (check.cost ?? 1) * 1000 - replenished[index]! }))
		.filter(({ deficit }) => deficit > 0);
	const allowed = deniedIndexes.length === 0;
	const nextStates: Record<string, TokenBucketState> = {};
	const details = checks.map((check, index): TokenBucketDetailV3 => {
		const remaining = replenished[index]! - (allowed ? (check.cost ?? 1) * 1000 : 0);
		nextStates[check.id] = { tokensMilli: remaining, updatedAtMs: nowMs };
		return {
			id: check.id,
			scope: check.scope,
			cost: check.cost ?? 1,
			refillPerSecond: check.refillPerSecond,
			burst: check.burst,
			remainingMilliTokens: remaining,
		};
	});
	const firstDenied = deniedIndexes[0];
	const retryAfterSeconds = deniedIndexes.reduce((maximum, denied) => {
		const check = checks[denied.index]!;
		return Math.max(maximum, Math.ceil(denied.deficit / (check.refillPerSecond * 1000)));
	}, 0);
	return {
		result: {
			allowed,
			retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds),
			...(firstDenied
				? {
						deniedScope: checks[firstDenied.index]!.scope,
						deniedBucketId: checks[firstDenied.index]!.id,
					}
				: {}),
			details,
		},
		states: nextStates,
	};
};
