import { createServer, connect as connectSocket } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { createDatabaseExecutor } from "../../src/infra/database";
import { dbPool, DatabasePool } from "../../src/infra/db-pool";
import { ExecutionScope } from "../../src/infra/execution-scope";

const enabled = process.env.RUN_DATABASE_EXECUTION_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;

suite("real PostgreSQL execution boundary (disposable fixture only)", () => {
	let pool: DatabasePool;
	beforeAll(() => {
		const url = new URL(process.env.DATABASE_URL!);
		if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			throw new Error("Database execution integration requires a loopback fixture");
		// Intentionally omit the startup statement_timeout parameter. The
		// disposable database default is 120 seconds, as on the transaction pooler.
		pool = new DatabasePool({
			connectionString: url.toString(),
			max: 1,
			connectionTimeoutMillis: 1000,
		});
	});
	const poolQuery = async <Row extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		values?: readonly unknown[]
	) => {
		const client = await pool.connect();
		try {
			return await client.query<Row>(text, values);
		} finally {
			await client.release();
		}
	};
	afterAll(async () => {
		await pool?.end();
		await dbPool.end();
	});

	it("applies the local read-only timeout without startup options and does not leak it", async () => {
		const outsideBefore = (await poolQuery<{ statement_timeout: string }>("SHOW statement_timeout"))
			.rows[0].statement_timeout;
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
			(await poolQuery<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]
				.statement_timeout
		).toBe("2min");
		expect(
			(await poolQuery<{ transaction_read_only: string }>("SHOW transaction_read_only")).rows[0]
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
			createDatabaseExecutor(undefined, () => pool.connect(), 80).query("SELECT pg_sleep(2)")
		).rejects.toThrow();
		// Keep enough room for a busy CI runner to deliver CancelRequest and
		// bounded cleanup, while a query that ignores cancellation still exceeds
		// the 1.5s assertion because it sleeps for two seconds.
		expect(performance.now() - started).toBeLessThan(1500);
		expect(
			(await createDatabaseExecutor(undefined, () => pool.connect()).query("SELECT 1 AS value"))
				.rows[0].value
		).toBe(1);
		expect(pool.waitingCount).toBe(0);
	});

	it("does not reuse an actively discarded connection", async () => {
		const before = (await poolQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
		const scope = new ExecutionScope(Date.now() + 300);
		const work = createDatabaseExecutor(scope, () => pool.connect()).query("SELECT pg_sleep(1)");
		const rejection = work.catch((error: unknown) => error);
		await Bun.sleep(25);
		scope.cancel();
		expect(await rejection).toBeInstanceOf(Error);
		const after = (await poolQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
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
		await poolQuery("SELECT pg_terminate_backend($1)", [pid]);
		await observed;
		const recovered = await createDatabaseExecutor().query("SELECT pg_backend_pid() AS pid");
		expect(recovered.rows[0].pid).not.toBe(pid);
	});

	it("handles an error on an owned active connection without exiting", async () => {
		const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
		try {
			const pid = (await poolQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
			const work = createDatabaseExecutor(undefined, () => pool.connect(), 500).query(
				"SELECT pg_sleep(1)"
			);
			const rejection = work.catch((error: unknown) => error);
			await Bun.sleep(25);
			await observer.query("SELECT pg_terminate_backend($1)", [pid]);
			expect(await rejection).toBeInstanceOf(Error);
			const result = await createDatabaseExecutor(undefined, () => pool.connect()).query<{
				value: number;
			}>("SELECT 1 AS value");
			expect(result.rows[0].value).toBe(1);
		} finally {
			await observer.end();
		}
	});
	it("preserves pg codecs and parameter behavior for dates, nulls, JSON and arrays", async () => {
		const legacy = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
		try {
			const text = `SELECT 1::int8 AS small_bigint, '9007199254740995'::int8 AS large_bigint,
				1.25::numeric AS decimal, 1.25::float8 AS float, true AS flag,
				'2026-09-12'::date AS day, '2026-09-12 12:00:00'::timestamp AS local_time,
				'2026-09-12 12:00:00Z'::timestamptz AS instant,
				'{1,2}'::int8[] AS integers, '{1.2,2.3}'::numeric[] AS decimals,
				$1::text[] AS strings, $2::jsonb AS document, $3::timestamptz AS parameter_date,
				$4::bytea AS bytes, $5::text AS empty`;
			const args = [
				['a"b', "c\\d", null, "NULL"],
				{ ok: true, nested: [1, null] },
				new Date("2026-09-12T12:00:00Z"),
				Buffer.from([0, 255, 3]),
				null,
			];
			const before = await legacy.query(text, args);
			const after = await createDatabaseExecutor(undefined, () => pool.connect()).query(text, args);
			expect(after.rows).toEqual(before.rows);
			expect(after.rowCount).toBe(before.rowCount);
		} finally {
			await legacy.end();
		}
	});

	it("observes a failed public CancelRequest promise without an unhandled rejection", async () => {
		const target = new URL(process.env.DATABASE_URL!);
		const targetPort = Number(target.port || 5432);
		const proxy = createServer((socket) => {
			const upstream = connectSocket({ host: target.hostname, port: targetPort });
			socket.on("error", () => upstream.destroy());
			upstream.on("error", () => socket.destroy());
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("No fixture proxy address");
		target.port = String(address.port);
		const sql = postgres(target.toString(), {
			max: 1,
			prepare: false,
			connect_timeout: 0.2,
			fetch_types: false,
		});
		try {
			await sql.unsafe("BEGIN READ ONLY");
			await sql.unsafe("SELECT set_config('statement_timeout','300ms',true)");
			const query = sql.unsafe("SELECT pg_sleep(1)");
			const settled = query.catch((error: unknown) => error);
			await Bun.sleep(30);
			proxy.close(); // refuse only new cancellation connections, keep active socket
			const cancellation = query.cancel();
			expect(cancellation).toBeInstanceOf(Promise);
			await expect(cancellation).rejects.toThrow();
			expect(await settled).toBeInstanceOf(Error);
		} finally {
			await sql.end({ timeout: 0 });
			proxy.close();
		}
	});
});
