import type { QueryResultRow } from "pg";
import { dbPool, type DatabaseClient, type DatabaseResult } from "./db-pool";
import { env } from "./env";
import { postgresPoolWaitEvents } from "./metrics";
import {
	DATABASE_CLEANUP_BUDGET_MS,
	ExecutionExpiredError,
	ExecutionScope,
} from "./execution-scope";

export type DatabaseHealthClient = {
	query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
	release: (destroy?: boolean) => void | Promise<void>;
	cancel?: () => Promise<void>;
	on?: (event: "error", listener: (error: Error) => void) => unknown;
	removeListener?: (event: "error", listener: (error: Error) => void) => unknown;
};

export interface QueryExecutor {
	query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[]
	): Promise<DatabaseResult<Row>>;
}

/**
 * Infer whether this particular checkout had to wait from the synchronous
 * queue transition at the call boundary. The bounded GraphQL pool appends
 * exactly one pending item synchronously when a checkout cannot be handed off
 * immediately; observing the delta on this call avoids losing a short wait
 * when another client is released before a later pool-wide sample. An idle
 * handoff with a spare pool slot is deliberately not counted as contention.
 */
export const poolCheckoutNeedsWaitMetric = (
	waitingCountBefore: number,
	waitingCountAfter: number,
	idleCountBefore: number,
	totalCountBefore: number,
	poolMax: number
): boolean =>
	Number.isSafeInteger(waitingCountBefore) &&
	Number.isSafeInteger(waitingCountAfter) &&
	Number.isSafeInteger(idleCountBefore) &&
	Number.isSafeInteger(totalCountBefore) &&
	Number.isSafeInteger(poolMax) &&
	waitingCountBefore >= 0 &&
	waitingCountAfter === waitingCountBefore + 1 &&
	idleCountBefore >= 0 &&
	totalCountBefore >= 0 &&
	poolMax > 0 &&
	totalCountBefore >= poolMax &&
	idleCountBefore <= waitingCountBefore;

const connectFromPool = (): Promise<DatabaseClient> => {
	const waitingCountBefore = dbPool.waitingCount;
	const idleCountBefore = dbPool.idleCount;
	const totalCountBefore = dbPool.totalCount;
	const checkout = dbPool.connect();
	const waitingCountAfter = dbPool.waitingCount;
	if (
		poolCheckoutNeedsWaitMetric(
			waitingCountBefore,
			waitingCountAfter,
			idleCountBefore,
			totalCountBefore,
			env.DATABASE_POOL_MAX
		)
	) {
		postgresPoolWaitEvents.inc();
	}
	return checkout;
};

/**
 * The only PostgreSQL capability exposed to GraphQL application code.
 * It deliberately has no transaction or mutation helper surface.
 */
export const createDatabaseExecutor = (
	requestScope?: ExecutionScope,
	connect: () => Promise<DatabaseHealthClient> = connectFromPool,
	statementTimeoutMs = env.DATABASE_STATEMENT_TIMEOUT_MS
): QueryExecutor => ({
	async query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values: readonly unknown[] = []
	): Promise<DatabaseResult<Row>> {
		const execution = requestScope ?? ExecutionScope.current();
		execution?.remainingMs();
		const scope = new ExecutionScope(
			Math.min(execution?.deadlineAt ?? Infinity, Date.now() + statementTimeoutMs),
			execution?.signal
		);
		const propagateDeadline = (): void => {
			if (
				execution &&
				scope.signal.reason instanceof ExecutionExpiredError &&
				scope.signal.reason.reason === "deadline"
			) {
				execution.cancel("deadline");
			}
		};
		scope.signal.addEventListener("abort", propagateDeadline, { once: true });
		let completed!: () => void;
		execution?.track(
			new Promise<void>((resolve) => {
				completed = resolve;
			})
		);
		let client: DatabaseHealthClient | undefined;
		let released = false;
		let inTransaction = false;
		let reusable = false;
		let pending: Promise<unknown> | undefined;
		let cancellation: Promise<unknown> | undefined;
		let releaseWork: Promise<unknown> | undefined;
		const connectionError = (): void => scope.cancel("cancelled");
		const release = (destroy: boolean): void => {
			if (client && !released) {
				released = true;
				releaseWork = Promise.resolve(client.release(destroy)).catch(() => undefined);
				// Keep the handler on a discarded client through asynchronous socket
				// teardown; a reusable client is handed back to the pool's listener.
				if (!destroy) client.removeListener?.("error", connectionError);
			}
		};
		const abort = (): void => {
			if (client?.cancel) cancellation = client.cancel().catch(() => undefined);
			else release(true);
		};
		const execute = async (sql: string, args?: readonly unknown[]): Promise<unknown> => {
			scope.remainingMs();
			pending = client!.query(sql, args);
			return scope.wait(pending);
		};
		try {
			scope.remainingMs();
			// Own the pool checkout even after its caller stops waiting. Own late arrivals and never run
			// SQL on a connection acquired after this operation has expired.
			const checkout = connect().then((acquired) => {
				try {
					scope.remainingMs();
				} catch (error) {
					void Promise.resolve(acquired.release()).catch(() => undefined);
					throw error;
				}
				client = acquired;
				client.on?.("error", connectionError);
				return acquired;
			});
			await scope.wait(checkout);
			scope.signal.addEventListener("abort", abort, { once: true });
			scope.remainingMs();
			await execute("BEGIN READ ONLY");
			inTransaction = true;
			await execute("SELECT set_config('statement_timeout', $1, true)", [
				`${scope.remainingMs()}ms`,
			]);
			const result = await execute(text, [...values]);
			await execute("COMMIT");
			inTransaction = false;
			reusable = true;
			return result as DatabaseResult<Row>;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			const connectionFailure =
				typeof code === "string" &&
				(code.startsWith("08") ||
					code.startsWith("CONNECTION_") ||
					["57P01", "57P02", "57P03", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND"].includes(
						code
					));
			if (inTransaction && !scope.signal.aborted && !released && !connectionFailure) {
				try {
					await execute("ROLLBACK");
					reusable = true;
				} catch {
					/* discard below */
				}
			}
			throw error;
		} finally {
			scope.signal.removeEventListener("abort", abort);
			if (pending && !reusable) {
				// Discarded connections cannot be reused. Give the driver a bounded
				// cleanup window and observe a later rejection even if it exceeds it.
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					Promise.all([pending.catch(() => undefined), cancellation]),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, DATABASE_CLEANUP_BUDGET_MS);
					}),
				]);
				clearTimeout(timer);
			}
			release(!reusable);
			await releaseWork;
			scope.signal.removeEventListener("abort", propagateDeadline);
			scope.dispose();
			completed?.();
		}
	},
});

export const database: QueryExecutor = createDatabaseExecutor();

/**
 * Run the readiness query in a transaction with a server-side timeout. The
 * local setting is scoped to this checked-out client and cannot leak into the
 * pool; PostgreSQL cancels the query instead of leaving an orphaned promise.
 */
export const runDatabaseHealthCheck = async (
	connect: () => Promise<DatabaseHealthClient>,
	statementTimeoutMs = 2_000
): Promise<void> => {
	await createDatabaseExecutor(undefined, connect, statementTimeoutMs).query("SELECT 1");
};

export const databaseHealthCheck = async (): Promise<void> =>
	runDatabaseHealthCheck(() => {
		return connectFromPool() as unknown as Promise<DatabaseHealthClient>;
	}, 2_000);
