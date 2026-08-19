import { describe, expect, it } from "bun:test";
import {
	MAX_REQUEST_BODY_BYTES,
	PayloadTooLargeError,
	readRequestBody,
	checkRateLimit,
	checkRateLimits,
	handleRateLimitStorageFailure,
	rateLimitKey,
} from "../../src/http/security";

describe("HTTP security boundaries", () => {
	it("rejects an oversized declared request body", async () => {
		const request = new Request("http://localhost/graphql", {
			method: "POST",
			headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
			body: "{}",
		});

		expect(readRequestBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
	});

	it("rejects an oversized streamed request body", async () => {
		const request = new Request("http://localhost/graphql", {
			method: "POST",
			body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
		});

		expect(readRequestBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
	});

	it("passes operation cost to Redis rate limiting", async () => {
		const calls: unknown[][] = [];
		const redis = {
			eval: async (...args: unknown[]) => {
				calls.push(args);
				return [2, 60];
			},
		} as never;

		const result = await checkRateLimit(redis, "security", 5, 60, 2);
		expect(result.allowed).toBe(true);
		expect(calls[0]?.slice(-2)).toEqual(["60", "2"]);
	});

	it("checks global and weighted subject budgets in one Redis evaluation", async () => {
		const calls: unknown[][] = [];
		const redis = {
			eval: async (...args: unknown[]) => {
				calls.push(args);
				return [1, 60, 7, 60];
			},
		} as never;

		await expect(
			checkRateLimits(redis, [
				{ scope: "global", key: "global-key", limit: 1500, windowSeconds: 60 },
				{ scope: "subject", key: "subject-key", limit: 120, windowSeconds: 60, cost: 7 },
			])
		).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(1)).toEqual([2, "global-key", "subject-key", "60", "1", "60", "7"]);
	});

	it("returns the denied batch scope and longest retry delay", async () => {
		const redis = { eval: async () => [1501, 9, 121, 17] } as never;
		expect(
			await checkRateLimits(redis, [
				{ scope: "global", key: "global-key", limit: 1500, windowSeconds: 60 },
				{ scope: "subject", key: "subject-key", limit: 120, windowSeconds: 60 },
			])
		).toEqual({ allowed: false, retryAfterSeconds: 17, deniedScope: "global" });
	});

	it("returns the Redis window TTL as an accurate retry delay", async () => {
		const redis = { eval: async () => [121, 17] } as never;
		expect(await checkRateLimit(redis, "security", 120, 60, 20)).toEqual({
			allowed: false,
			retryAfterSeconds: 17,
		});
	});

	it("rounds the final partial second up instead of resetting the retry delay", async () => {
		const redis = { eval: async () => [121, 0] } as never;
		expect(await checkRateLimit(redis, "security", 120, 60)).toEqual({
			allowed: false,
			retryAfterSeconds: 1,
		});
	});

	it("keeps signed client and shared service subjects in separate buckets", () => {
		expect(rateLimitKey("graphql", "signed-client")).not.toBe(
			rateLimitKey("graphql", "service:web-public-rsc")
		);
	});

	it("fails closed when limiter storage is unavailable", () => {
		expect(() =>
			handleRateLimitStorageFailure({
				error: new Error("redis unavailable"),
				failClosed: true,
				scope: "graphql",
				logger: { warn: () => undefined } as never,
			})
		).toThrow("redis unavailable");
	});
});
