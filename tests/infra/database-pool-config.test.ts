import { describe, expect, test } from "bun:test";

import { parseDatabasePoolMax } from "../../src/infra/database-pool-config";

describe("GraphQL database pool configuration", () => {
	test("wires the validated limit into the shared PostgreSQL pool", async () => {
		const source = await Bun.file("src/infra/db-pool.ts").text();
		expect(source).toContain("max: env.DATABASE_POOL_MAX");
		expect(source).toContain("min: 1");
		expect(source).toContain("idleTimeoutMillis: 30_000");
		expect(source).toContain("statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS");
		expect(source).not.toContain("max: 20");
	});

	test("defaults production and development pools to five connections", () => {
		expect(parseDatabasePoolMax(undefined)).toBe(5);
		expect(parseDatabasePoolMax("")).toBe(5);
	});

	test("accepts only integer limits from one through ten", () => {
		for (const value of [1, 5, 10]) {
			expect(parseDatabasePoolMax(String(value))).toBe(value);
		}
		for (const value of ["0", "11", "1.5", "not-a-number"]) {
			expect(() => parseDatabasePoolMax(value)).toThrow(
				"DATABASE_POOL_MAX must be an integer between 1 and 10"
			);
		}
	});
});
