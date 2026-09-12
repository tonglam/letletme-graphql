import { Pool } from "pg";
import { createDatabaseExecutor } from "../src/infra/database";
import { env } from "../src/infra/env";
import { ExecutionScope } from "../src/infra/execution-scope";

// Explicit, bounded read-only probe. It does not terminate database sessions
// or change roles, data, routing, or the serving process's pool.
if (!process.argv.includes("--bounded-probe")) {
	throw new Error("Pass --bounded-probe to run the single-concurrency database probe");
}

const workPool = new Pool({
	connectionString: env.DATABASE_URL,
	max: 1,
	connectionTimeoutMillis: 2000,
});
const observerPool = new Pool({
	connectionString: env.DATABASE_URL,
	max: 1,
	connectionTimeoutMillis: 2000,
});
workPool.on("error", () => {});
observerPool.on("error", () => {});
const record: Record<string, unknown> = { at: new Date().toISOString(), passed: false };
let scope: ExecutionScope | undefined;

try {
	const settings = (
		await createDatabaseExecutor(undefined, () => workPool.connect()).query<{
			timeout_ms: number;
			read_only: string;
		}>(
			"SELECT EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000 AS timeout_ms, current_setting('transaction_read_only') AS read_only"
		)
	).rows[0];
	const timeoutMs = Number(settings.timeout_ms);
	const localSettingPassed =
		timeoutMs > 0 && timeoutMs <= env.DATABASE_STATEMENT_TIMEOUT_MS && settings.read_only === "on";
	record.localSetting = {
		configuredMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
		effectiveMs: timeoutMs,
		readOnly: settings.read_only,
		passed: localSettingPassed,
	};
	if (!localSettingPassed) throw new Error("Transaction-local setting check failed");

	const marker = `graphql_execution_probe_${crypto.randomUUID().replaceAll("-", "")}`;
	scope = new ExecutionScope(Date.now() + 900);
	const started = performance.now();
	const work = createDatabaseExecutor(scope, () => workPool.connect(), 900)
		.query(`SELECT pg_sleep(1.5) /* ${marker} */`)
		.then(
			() => "completed",
			() => "rejected"
		);
	const observer = createDatabaseExecutor(undefined, () => observerPool.connect(), 1000);
	let identity: { pid: number; started: string } | undefined;
	for (let i = 0; i < 10; i++) {
		const found = await observer.query<{ pid: number; started: string }>(
			"SELECT pid, query_start::text AS started FROM pg_stat_activity WHERE state='active' AND query LIKE $1 AND pid <> pg_backend_pid()",
			[`%${marker}%`]
		);
		identity = found.rows[0];
		if (identity) break;
		await Bun.sleep(20);
	}
	const cancelledAt = performance.now();
	scope.cancel();
	let stoppedAt: number | undefined;
	if (identity) {
		for (let i = 0; i < 50; i++) {
			const state = await observer.query<{ active: boolean }>(
				"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND query_start=$2::timestamptz AND state='active' AND query LIKE $3) AS active",
				[identity.pid, identity.started, `%${marker}%`]
			);
			if (!state.rows[0].active) {
				stoppedAt = performance.now();
				break;
			}
			await Bun.sleep(20);
		}
	}
	const outcome = await work;
	const stopDelay = stoppedAt === undefined ? null : Math.round(stoppedAt - cancelledAt);
	const total = stoppedAt === undefined ? null : Math.round(stoppedAt - started);
	// Stopping only at the local SQL timeout does not prove active cancellation.
	const cancellationPassed =
		Boolean(identity) &&
		cancelledAt - started < 300 &&
		stopDelay !== null &&
		stopDelay < 400 &&
		total !== null &&
		total < 700;
	record.cancellation = {
		observedActiveQuery: Boolean(identity),
		cancelledAfterMs: Math.round(cancelledAt - started),
		stoppedAfterCancelMs: stopDelay,
		totalMs: total,
		clientOutcome: outcome,
		passed: cancellationPassed,
	};
	record.passed = cancellationPassed;
	if (!cancellationPassed) process.exitCode = 1;
} catch (error) {
	record.failure =
		error instanceof Error && error.name === "ExecutionExpiredError"
			? "execution_expired"
			: "probe_failed";
	process.exitCode = 1;
} finally {
	scope?.dispose();
	await Promise.all([workPool.end(), observerPool.end()]);
	console.log(JSON.stringify(record));
}
