import { describe, expect, test } from "bun:test";

import { parseDatabasePoolMax } from "../../src/infra/database-pool-config";

describe("GraphQL database pool configuration", () => {
	test("keeps an isolated process alive after idle pool errors, including shutdown", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"--env-file=/dev/null",
				"-e",
				`
				const { dbPool, closeDbPool } = await import('./src/infra/db-pool');
				if (dbPool.listenerCount('error') !== 1) process.exit(2);
				dbPool.emit('error', Object.assign(new Error('secret must not be logged'), { code: 'ECONNRESET' }));
				await closeDbPool();
				dbPool.emit('error', new Error('secret must not be logged'));
				console.log('survived');
			`,
			],
			{
				env: {
					PATH: process.env.PATH,
					DATABASE_URL: "postgres://test:test@localhost/test",
					REDIS_URL: "redis://localhost:6379",
					RATE_LIMIT_REDIS_URL: "redis://localhost:6380",
				},
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const output = await new Response(child.stdout).text();
		const errors = await new Response(child.stderr).text();
		expect(await child.exited).toBe(0);
		expect(output).toContain("survived");
		expect(output + errors).not.toContain("secret must not be logged");
	});
	test("wires the validated limit into the shared PostgreSQL pool", async () => {
		const source = await Bun.file("src/infra/db-pool.ts").text();
		expect(source).toContain("max: env.DATABASE_POOL_MAX");
		expect(source).toContain("min: 0");
		expect(source).toContain("idleTimeoutMillis: 30_000");
		expect(source).toContain("statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS");
		expect(source).not.toContain("max: 20");
	});

	test("defaults production and development pools to four connections", () => {
		expect(parseDatabasePoolMax(undefined)).toBe(4);
		expect(parseDatabasePoolMax("")).toBe(4);
	});

	test("accepts only integer limits from one through four", () => {
		for (const value of [1, 2, 3, 4]) {
			expect(parseDatabasePoolMax(String(value))).toBe(value);
		}
		for (const value of ["0", "5", "1.5", "not-a-number"]) {
			expect(() => parseDatabasePoolMax(value)).toThrow(
				"DATABASE_POOL_MAX must be an integer between 1 and 4"
			);
		}
	});
});
