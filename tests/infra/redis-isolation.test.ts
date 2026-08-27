import { describe, expect, it } from "bun:test";
import { RedisClientRegistry } from "../../src/infra/redis-client-registry";

type FakeRedis = {
	status: string;
	connect: () => Promise<void>;
	quit: () => Promise<void>;
};

describe("Redis workload isolation", () => {
	it("constructs, connects, and closes independent primary and admission clients", async () => {
		const calls: string[] = [];
		const registry = new RedisClientRegistry<FakeRedis>(
			{ primary: "redis://primary:6379", rateLimit: "redis://admission:6379" },
			(url, role) => {
				const client: FakeRedis = {
					status: "wait",
					connect: async () => {
						calls.push(`connect:${role}:${url}`);
						client.status = "ready";
					},
					quit: async () => {
						calls.push(`quit:${role}:${url}`);
						client.status = "end";
					},
				};
				return client;
			}
		);

		const primary = registry.getPrimary();
		const admission = registry.getRateLimit();
		expect(primary).not.toBe(admission);
		expect(registry.getPrimary()).toBe(primary);
		expect(registry.getRateLimit()).toBe(admission);

		await expect(registry.connectAll()).resolves.toBe(primary);
		expect(calls).toEqual([
			"connect:primary:redis://primary:6379",
			"connect:rate-limit:redis://admission:6379",
		]);

		await registry.closeAll();
		expect(calls.slice(2).sort()).toEqual([
			"quit:primary:redis://primary:6379",
			"quit:rate-limit:redis://admission:6379",
		]);
	});

	it("propagates admission-store failure without falling back to primary", async () => {
		const calls: string[] = [];
		const registry = new RedisClientRegistry<FakeRedis>(
			{ primary: "redis://primary:6379", rateLimit: "redis://admission:6379" },
			(_url, role) => ({
				status: "wait",
				connect: async () => {
					calls.push(role);
					if (role === "rate-limit") throw new Error("admission unavailable");
				},
				quit: async () => {},
			})
		);

		await expect(registry.connectAll()).rejects.toThrow("admission unavailable");
		expect(calls.sort()).toEqual(["primary", "rate-limit"]);
		expect(registry.getRateLimit()).not.toBe(registry.getPrimary());
	});
});
