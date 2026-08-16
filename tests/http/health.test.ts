import { describe, expect, it } from "bun:test";
import { runHealthChecks } from "../../src/http/health";

describe("health readiness checks", () => {
	it("marks each failed dependency independently and fails readiness closed", async () => {
		for (const dependency of ["redis", "rateLimitRedis", "postgres", "season"] as const) {
			const result = await runHealthChecks({
				redis: async () => {
					if (dependency === "redis") throw new Error("primary Redis down");
				},
				rateLimitRedis: async () => {
					if (dependency === "rateLimitRedis") throw new Error("rate Redis down");
				},
				postgres: async () => {
					if (dependency === "postgres") throw new Error("Postgres down");
				},
				season: async () => {
					if (dependency === "season") throw new Error("season unavailable");
				},
			});
			expect(result.ok).toBe(false);
			expect(result.checks[dependency]).toBe("fail");
			expect(Object.values(result.checks).filter((value) => value === "fail")).toHaveLength(1);
		}
	});

	it("reports both Redis clients independently", async () => {
		const result = await runHealthChecks({
			redis: async () => {},
			rateLimitRedis: async () => {
				throw new Error("rate Redis down");
			},
			postgres: async () => {},
			season: async () => {},
		});
		expect(result).toEqual({
			ok: false,
			checks: { redis: "ok", rateLimitRedis: "fail", postgres: "ok", season: "ok" },
		});
	});

	it("bounds a hanging probe", async () => {
		const result = await runHealthChecks({
			redis: () => new Promise<void>(() => {}),
			rateLimitRedis: async () => {},
			postgres: async () => {},
			season: async () => {},
		});
		expect(result.checks.redis).toBe("fail");
	});
});
