import { readFileSync } from "fs";
import { describe, expect, it } from "bun:test";

describe("Redis workload isolation", () => {
	it("keeps admission traffic off the publication and query-cache client", () => {
		const indexSource = readFileSync("src/index.ts", "utf8");
		const redisSource = readFileSync("src/infra/redis.ts", "utf8");

		expect(indexSource).toContain("checkTokenBucketStageV3(getRateLimitRedis(), checks)");
		expect(redisSource).toContain("let rateLimitClient: Redis | null = null");
		expect(redisSource).toContain(
			"Promise.all([connectClient(redis), connectClient(getRateLimitRedis())])"
		);
		expect(redisSource).toContain("assertRedisWorkloadIsolation");
		expect(redisSource).toContain('redis.info("replication")');
		expect(redisSource).toContain("clients.map((current) => current.quit())");
	});
});
