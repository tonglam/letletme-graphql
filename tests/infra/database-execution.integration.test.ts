import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { createDatabaseExecutor } from "../../src/infra/database";
import { dbPool } from "../../src/infra/db-pool";
import { ExecutionScope } from "../../src/infra/execution-scope";

const enabled = process.env.RUN_DATABASE_EXECUTION_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;

suite("real PostgreSQL execution boundary (disposable fixture only)", () => {
	let pool: Pool;
	beforeAll(() => {
		const url = new URL(process.env.DATABASE_URL!);
		if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			throw new Error("Database execution integration requires a loopback fixture");
		// Intentionally omit the startup statement_timeout parameter. The
		// disposable database default is 120 seconds, as on the transaction pooler.
		pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 1000 });
	});
	afterAll(async () => {
		await pool?.end();
		await dbPool.end();
	});

	it("applies the local read-only timeout without startup options and does not leak it", async () => {
		const outsideBefore = (
			await pool.query<{ statement_timeout: string }>("SHOW statement_timeout")
		).rows[0].statement_timeout;
		expect(outsideBefore).toBe("2min");
		const result = await createDatabaseExecutor(undefined, () => pool.connect()).query(
			"SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS read_only"
		);
		const timeout = result.rows[0].timeout as string;
		const milliseconds = timeout.endsWith("ms") ? parseFloat(timeout) : parseFloat(timeout) * 1000;
		expect(milliseconds).toBeGreaterThan(0);
		expect(milliseconds).toBeLessThanOrEqual(12000);
		expect(result.rows[0].read_only).toBe("on");
		expect(
			(await pool.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]
				.statement_timeout
		).toBe("2min");
		expect(
			(await pool.query<{ transaction_read_only: string }>("SHOW transaction_read_only")).rows[0]
				.transaction_read_only
		).toBe("off");
	});

	it("rolls back an ordinary SQL error and reuses the same healthy backend", async () => {
		const executor = createDatabaseExecutor(undefined, () => pool.connect());
		const before = (await executor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
			.pid;
		await expect(executor.query("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
		const after = (await executor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
			.pid;
		expect(after).toBe(before);
		expect(pool.waitingCount).toBe(0);
	});

	it("bounds a slow query and restores pool capacity", async () => {
		const started = performance.now();
		await expect(
			createDatabaseExecutor(undefined, () => pool.connect(), 80).query("SELECT pg_sleep(1)")
		).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(1000);
		expect(
			(await createDatabaseExecutor(undefined, () => pool.connect()).query("SELECT 1 AS value"))
				.rows[0].value
		).toBe(1);
		expect(pool.waitingCount).toBe(0);
	});

	it("does not reuse an actively discarded connection", async () => {
		const before = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
			.pid;
		const scope = new ExecutionScope(Date.now() + 300);
		const work = createDatabaseExecutor(scope, () => pool.connect()).query("SELECT pg_sleep(1)");
		const rejection = expect(work).rejects.toThrow("no longer available");
		await Bun.sleep(25);
		scope.cancel();
		await rejection;
		const after = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
		expect(after).not.toBe(before);
		scope.dispose();
	});

	it("survives termination of its own idle fixture backend and recovers queries", async () => {
		const client = await dbPool.connect();
		const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
		const observed = new Promise<void>((resolve) => dbPool.once("error", () => resolve()));
		client.release();
		// This suite rejects non-loopback endpoints. Only its own idle backend
		// is terminated; the application handler must keep the process alive.
		await pool.query("SELECT pg_terminate_backend($1)", [pid]);
		await observed;
		const recovered = await createDatabaseExecutor().query("SELECT pg_backend_pid() AS pid");
		expect(recovered.rows[0].pid).not.toBe(pid);
	});

	it("handles an error on an owned active connection without exiting", async () => {
		const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
		try {
			const pid = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
			const work = createDatabaseExecutor(undefined, () => pool.connect(), 500).query(
				"SELECT pg_sleep(1)"
			);
			const rejection = expect(work).rejects.toThrow();
			await Bun.sleep(25);
			await observer.query("SELECT pg_terminate_backend($1)", [pid]);
			await rejection;
			const result = await createDatabaseExecutor(undefined, () => pool.connect()).query<{
				value: number;
			}>("SELECT 1 AS value");
			expect(result.rows[0].value).toBe(1);
		} finally {
			await observer.end();
		}
	});
});
