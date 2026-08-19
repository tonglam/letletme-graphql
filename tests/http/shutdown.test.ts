import { describe, expect, it } from "bun:test";
import { createShutdownHandler } from "../../src/http/shutdown";

describe("shutdown coordinator", () => {
	it("drains once, closes dependencies in order, and exits successfully", async () => {
		const calls: string[] = [];
		const shutdown = createShutdownHandler({
			server: {
				stop: async () => {
					calls.push("server");
				},
			},
			stopApollo: async () => void calls.push("apollo"),
			closeRedis: async () => void calls.push("redis"),
			closeDbPool: async () => void calls.push("db"),
			setExitCode: (code) => calls.push(`exit:${code}`),
			exitProcess: (code) => calls.push(`process.exit:${code}`),
		});
		const [first, second] = await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
		expect(first).toEqual({ forced: false, failed: false });
		expect(second).toEqual(first);
		expect(calls).toEqual(["server", "apollo", "redis", "db", "exit:0", "process.exit:0"]);
	});

	it("forces a stalled drain and reports a non-zero exit", async () => {
		const calls: string[] = [];
		const shutdown = createShutdownHandler({
			server: {
				stop: async (force) => {
					calls.push(force ? "force" : "server");
					if (!force) await new Promise<void>(() => {});
				},
			},
			stopApollo: async () => void calls.push("apollo"),
			closeRedis: async () => void calls.push("redis"),
			closeDbPool: async () => void calls.push("db"),
			drainTimeoutMs: 5,
			setExitCode: (code) => calls.push(`exit:${code}`),
			exitProcess: (code) => calls.push(`process.exit:${code}`),
		});
		expect(await shutdown("SIGTERM")).toEqual({ forced: true, failed: true });
		expect(calls).toEqual(["server", "force", "apollo", "redis", "db", "exit:1", "process.exit:1"]);
	});

	it("continues cleanup after a dependency close fails", async () => {
		const calls: string[] = [];
		const shutdown = createShutdownHandler({
			server: { stop: async () => void calls.push("server") },
			stopApollo: async () => {
				calls.push("apollo");
				throw new Error("Apollo close failed");
			},
			closeRedis: async () => void calls.push("redis"),
			closeDbPool: async () => void calls.push("db"),
			setExitCode: (code) => calls.push(`exit:${code}`),
			exitProcess: (code) => calls.push(`process.exit:${code}`),
		});

		expect(await shutdown("SIGTERM")).toEqual({ forced: false, failed: true });
		expect(calls).toEqual(["server", "apollo", "redis", "db", "exit:1", "process.exit:1"]);
	});
});
