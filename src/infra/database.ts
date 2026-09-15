import type { QueryResultRow } from "pg";
import { dbPool, type DatabaseClient, type DatabaseResult } from "./db-pool";
import { env } from "./env";
import {
	postgresCancellationTotal,
	postgresPhaseDurationSeconds,
	postgresPhaseTotal,
	postgresPoolWaitEvents,
} from "./metrics";
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

export type DatabasePhase =
	| "checkout"
	| "begin"
	| "statement_timeout"
	| "sql"
	| "commit"
	| "rollback"
	| "transaction"
	| "connection_retire";

export type DatabasePhaseResult = "ok" | "error" | "timeout" | "client_abort" | "unavailable";

/** Classify only fixed statement families; SQL text never becomes a metric label. */
export const databaseQueryFamily = (text: string): string => {
	let withoutLeadingComments = text.trim();
	for (;;) {
		if (withoutLeadingComments.startsWith("--")) {
			const lineEnd = withoutLeadingComments.indexOf("\n");
			withoutLeadingComments = lineEnd < 0 ? "" : withoutLeadingComments.slice(lineEnd + 1).trim();
			continue;
		}
		if (withoutLeadingComments.startsWith("/*")) {
			const commentEnd = withoutLeadingComments.indexOf("*/", 2);
			withoutLeadingComments =
				commentEnd < 0 ? "" : withoutLeadingComments.slice(commentEnd + 2).trim();
			continue;
		}
		break;
	}
	const normalized = withoutLeadingComments.replace(/\s+/g, " ").toUpperCase();
	if (normalized === "BEGIN READ ONLY") return "transaction_begin";
	if (normalized.startsWith("SELECT SET_CONFIG('STATEMENT_TIMEOUT'")) return "statement_timeout";
	if (normalized === "COMMIT") return "transaction_commit";
	if (normalized === "ROLLBACK") return "transaction_rollback";
	if (normalized === "SELECT 1") return "health";
	if (normalized.startsWith("SELECT ") || normalized.startsWith("WITH ")) return "read";
	return "other";
};

const releaseLabel = (): string => {
	const release = env.DEPLOY_SHA;
	return release === "unknown" ? "unknown" : release.slice(0, 12);
};

const isConnectionFailure = (error: unknown): boolean => {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return (
		typeof code === "string" &&
		(code.startsWith("08") ||
			code.startsWith("CONNECTION_") ||
			["57P01", "57P02", "57P03", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND"].includes(code))
	);
};

export const databasePhaseResult = (
	error: unknown,
	scope: ExecutionScope,
	parentSignal?: AbortSignal
): DatabasePhaseResult => {
	if (error instanceof ExecutionExpiredError) {
		if (error.reason === "deadline") return "timeout";
		if (parentSignal?.aborted) {
			const parentReason: unknown = parentSignal.reason;
			if (parentReason instanceof ExecutionExpiredError && parentReason.reason === "deadline") {
				return "timeout";
			}
			if (error.reason === "cancelled") return "client_abort";
		}
		return "unavailable";
	}
	if (scope.signal.aborted) {
		const reason: unknown = scope.signal.reason;
		if (reason instanceof ExecutionExpiredError && reason.reason === "deadline") return "timeout";
		if (parentSignal?.aborted) {
			const parentReason: unknown = parentSignal.reason;
			if (parentReason instanceof ExecutionExpiredError && parentReason.reason === "deadline") {
				return "timeout";
			}
			return "client_abort";
		}
		return "unavailable";
	}
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	if (code === "57014" || code === "QUERY_TIMEOUT" || code === "POOL_TIMEOUT") return "timeout";
	if (code === "POOL_UNAVAILABLE") return "unavailable";
	if (isConnectionFailure(error)) return "unavailable";
	return "error";
};

/** The bounded local pool rejects a queued checkout with this controlled error. */
export const isPoolCheckoutTimeout = (error: unknown): boolean => {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	return (
		code === "ETIMEDOUT" ||
		code === "POOL_TIMEOUT" ||
		message.includes("database connection acquisition timed out")
	);
};

/** The pool deliberately hides driver connection details behind this stable error. */
export const isPoolCheckoutUnavailable = (error: unknown): boolean => {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	return code === "POOL_UNAVAILABLE" || message.includes("database connection unavailable");
};

const observeDatabasePhase = (
	queryFamily: string,
	phase: DatabasePhase,
	result: DatabasePhaseResult,
	startedAt: number
): void => {
	const labels = ["graphql", queryFamily, phase, result, releaseLabel()] as const;
	postgresPhaseTotal.labels(...labels).inc();
	postgresPhaseDurationSeconds
		.labels(...labels)
		.observe(Math.max(0, Date.now() - startedAt) / 1000);
};

const observeCancellation = (
	queryFamily: string,
	phase: "requested" | "settled" | "failed",
	reason: "deadline" | "client_abort",
	result: "ok" | "error"
): void => {
	postgresCancellationTotal
		.labels("graphql", queryFamily, phase, reason, result, releaseLabel())
		.inc();
};

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
		const queryFamily = databaseQueryFamily(text);
		const observePhase = (
			phase: DatabasePhase,
			result: DatabasePhaseResult,
			startedAt: number
		): void => observeDatabasePhase(queryFamily, phase, result, startedAt);
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
		let transactionStartedAt: number | undefined;
		let transactionResult: DatabasePhaseResult | undefined;
		let failureResult: DatabasePhaseResult | undefined;
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
			const expired = scope.signal.reason instanceof ExecutionExpiredError;
			const parentDeadline =
				execution?.signal.reason instanceof ExecutionExpiredError &&
				execution.signal.reason.reason === "deadline";
			const reason =
				expired && scope.signal.reason.reason === "deadline"
					? "deadline"
					: parentDeadline
						? "deadline"
						: execution?.signal.aborted
							? "client_abort"
							: undefined;
			if (!reason) {
				release(true);
				return;
			}
			if (client?.cancel) {
				observeCancellation(queryFamily, "requested", reason, "ok");
				cancellation = Promise.resolve()
					.then(() => client!.cancel!())
					.then(
						() => observeCancellation(queryFamily, "settled", reason, "ok"),
						() => observeCancellation(queryFamily, "failed", reason, "error")
					);
			} else {
				observeCancellation(queryFamily, "requested", reason, "error");
				release(true);
			}
		};
		const execute = async (sql: string, args?: readonly unknown[]): Promise<unknown> => {
			const phase =
				sql === "BEGIN READ ONLY"
					? "begin"
					: sql === "COMMIT"
						? "commit"
						: sql === "ROLLBACK"
							? "rollback"
							: sql.startsWith("SELECT set_config('statement_timeout'")
								? "statement_timeout"
								: "sql";
			const startedAt = Date.now();
			try {
				scope.remainingMs();
				pending = client!.query(sql, args);
				const result = await scope.wait(pending);
				observePhase(phase, "ok", startedAt);
				return result;
			} catch (error) {
				observePhase(phase, databasePhaseResult(error, scope, execution?.signal), startedAt);
				throw error;
			}
		};
		try {
			scope.remainingMs();
			// Own the pool checkout even after its caller stops waiting. Own late arrivals and never run
			// SQL on a connection acquired after this operation has expired.
			const checkoutStartedAt = Date.now();
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
			try {
				await scope.wait(checkout);
				observePhase("checkout", "ok", checkoutStartedAt);
			} catch (error) {
				observePhase(
					"checkout",
					isPoolCheckoutTimeout(error)
						? "timeout"
						: isPoolCheckoutUnavailable(error)
							? "unavailable"
							: databasePhaseResult(error, scope, execution?.signal),
					checkoutStartedAt
				);
				throw error;
			}
			scope.signal.addEventListener("abort", abort, { once: true });
			scope.remainingMs();
			transactionStartedAt = Date.now();
			await execute("BEGIN READ ONLY");
			inTransaction = true;
			await execute("SELECT set_config('statement_timeout', $1, true)", [
				`${scope.remainingMs()}ms`,
			]);
			const result = await execute(text, [...values]);
			await execute("COMMIT");
			inTransaction = false;
			transactionResult = "ok";
			if (transactionStartedAt !== undefined) {
				observePhase("transaction", "ok", transactionStartedAt);
				transactionStartedAt = undefined;
			}
			reusable = true;
			return result as DatabaseResult<Row>;
		} catch (error) {
			failureResult = databasePhaseResult(error, scope, execution?.signal);
			const connectionFailure = isConnectionFailure(error);
			if (inTransaction && !scope.signal.aborted && !released && !connectionFailure) {
				try {
					await execute("ROLLBACK");
					reusable = true;
					transactionResult = databasePhaseResult(error, scope, execution?.signal);
				} catch {
					/* discard below */
				}
			}
			if (transactionStartedAt !== undefined) {
				observePhase(
					"transaction",
					transactionResult ??
						failureResult ??
						databasePhaseResult(new Error("transaction failed"), scope),
					transactionStartedAt
				);
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
			const shouldDestroy = !reusable;
			const retireStartedAt = shouldDestroy && client ? Date.now() : undefined;
			release(shouldDestroy);
			await releaseWork;
			if (retireStartedAt !== undefined) {
				observePhase(
					"connection_retire",
					failureResult ?? databasePhaseResult(new Error("connection retired"), scope),
					retireStartedAt
				);
			}
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
