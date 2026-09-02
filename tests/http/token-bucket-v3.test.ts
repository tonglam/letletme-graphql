import { describe, expect, it } from "bun:test";
import type Redis from "ioredis";
import {
	TOKEN_BUCKET_V3_SCRIPT,
	TOKEN_BUCKET_SHADOW_STAGE_SCRIPT,
	checkTokenBucketStageV3,
	checkTokenBucketShadowStageV3,
	evaluateTokenBucketStageV3,
	tokenBucketKeyV3,
} from "../../src/http/token-bucket-v3";

const stageChecks = [
	{
		id: "global-request",
		scope: "global" as const,
		key: "global",
		refillPerSecond: 10,
		burst: 10,
		cost: 5,
	},
	{
		id: "client-weighted",
		scope: "client" as const,
		key: "client",
		refillPerSecond: 10,
		burst: 10,
		cost: 5,
	},
];

describe("Redis token bucket v3", () => {
	it("uses Redis TIME and evaluates all stage buckets in one atomic script", async () => {
		const calls: unknown[][] = [];
		const redis = {
			eval: async (...args: unknown[]) => {
				calls.push(args);
				return [1, 0, 0, 5_000, 5_000];
			},
		} as unknown as Redis;
		await expect(checkTokenBucketStageV3(redis, stageChecks)).resolves.toMatchObject({
			allowed: true,
			retryAfterSeconds: 0,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(1)).toEqual([2, "global", "client", "10", "10", "5", "10", "10", "5"]);
		expect(TOKEN_BUCKET_V3_SCRIPT).toContain("redis.call('TIME')");
		expect(TOKEN_BUCKET_V3_SCRIPT).toContain(
			"if allowed then remaining = remaining - state.cost_milli end"
		);
	});

	it("continuously refills milli-tokens and rounds Retry-After up", () => {
		const first = evaluateTokenBucketStageV3({
			checks: [stageChecks[0]!],
			states: {},
			nowMs: 1_000,
		});
		expect(first.result.details[0]?.remainingMilliTokens).toBe(5_000);
		const denied = evaluateTokenBucketStageV3({
			checks: [{ ...stageChecks[0]!, cost: 6 }],
			states: first.states,
			nowMs: 1_050,
		});
		expect(denied.result).toMatchObject({
			allowed: false,
			retryAfterSeconds: 1,
			deniedScope: "global",
		});
		expect(denied.states["global-request"]?.tokensMilli).toBe(5_500);
	});

	it("deducts no bucket when any bucket in the stage is short", () => {
		const evaluated = evaluateTokenBucketStageV3({
			checks: stageChecks,
			states: {
				"global-request": { tokensMilli: 9_000, updatedAtMs: 1_000 },
				"client-weighted": { tokensMilli: 4_000, updatedAtMs: 1_000 },
			},
			nowMs: 1_000,
		});
		expect(evaluated.result.allowed).toBe(false);
		expect(evaluated.states["global-request"]?.tokensMilli).toBe(9_000);
		expect(evaluated.states["client-weighted"]?.tokensMilli).toBe(4_000);
	});

	it("uses a new opaque Redis namespace without exposing the subject", () => {
		const subject = "raw-device-id";
		const key = tokenBucketKeyV3("mini-device-weighted", subject);
		expect(key).toStartWith("llm:gql:security:rate:v3:mini-device-weighted:");
		expect(key).not.toContain(subject);
	});

	it("combines enforcing global and observational buckets in one atomic call", async () => {
		const calls: unknown[][] = [];
		const redis = {
			eval: async (...args: unknown[]) => {
				calls.push(args);
				return [2, 1, 0, 0, 4_000];
			},
		} as unknown as Redis;
		const result = await checkTokenBucketShadowStageV3(redis, [stageChecks[0]!], [stageChecks[1]!]);

		expect(result).toMatchObject({
			allowed: true,
			retryAfterSeconds: 0,
			details: [{ id: "client-weighted", scope: "client", remainingMilliTokens: 4_000 }],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(1)).toEqual([
			2,
			"global",
			"client",
			"1",
			"10",
			"10",
			"5",
			"10",
			"10",
			"5",
		]);
		expect(TOKEN_BUCKET_SHADOW_STAGE_SCRIPT).toContain("if global_denied_index ~= 0 then");
		expect(TOKEN_BUCKET_SHADOW_STAGE_SCRIPT).toContain("for index = observation_start, #KEYS do");
	});

	it("decodes a global denial without returning an observational denial", async () => {
		const redis = {
			eval: async () => [1, 0, 3, 1, 2_000],
		} as unknown as Redis;
		const result = await checkTokenBucketShadowStageV3(redis, [stageChecks[0]!], [stageChecks[1]!]);

		expect(result).toMatchObject({
			allowed: false,
			retryAfterSeconds: 3,
			deniedScope: "global",
			deniedBucketId: "global-request",
			details: [{ id: "global-request", remainingMilliTokens: 2_000 }],
		});
	});
});
