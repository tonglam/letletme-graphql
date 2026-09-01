import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { dbPool } from "./db-pool";
import { env } from "./env";
import { postgresPoolWaitEvents } from "./metrics";

export type DatabaseHealthClient = {
	query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
	release: () => void;
};

export interface QueryExecutor {
	query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[]
	): Promise<QueryResult<Row>>;
}

/**
 * Infer whether this particular checkout had to wait from the synchronous
 * queue transition at the call boundary. `pg-pool` appends exactly one
 * pending item synchronously when a checkout cannot be handed off
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

const connectFromPool = (): Promise<PoolClient> => {
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
export const database: QueryExecutor = {
	query: <Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values: readonly unknown[] = []
	): Promise<QueryResult<Row>> =>
		connectFromPool().then(async (client) => {
			try {
				return await client.query<Row>(text, [...values]);
			} finally {
				client.release();
			}
		}),
};

/**
 * Run the readiness query in a transaction with a server-side timeout. The
 * local setting is scoped to this checked-out client and cannot leak into the
 * pool; PostgreSQL cancels the query instead of leaving an orphaned promise.
 */
export const runDatabaseHealthCheck = async (
	connect: () => Promise<DatabaseHealthClient>,
	statementTimeoutMs = 2_000
): Promise<void> => {
	const client = await connect();
	let inTransaction = false;
	try {
		await client.query("BEGIN");
		inTransaction = true;
		await client.query("SELECT set_config('statement_timeout', $1, true)", [
			`${statementTimeoutMs}ms`,
		]);
		await client.query("SELECT 1");
		await client.query("COMMIT");
		inTransaction = false;
	} catch (error) {
		if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
};

export const databaseHealthCheck = async (): Promise<void> =>
	runDatabaseHealthCheck(() => {
		return connectFromPool() as unknown as Promise<DatabaseHealthClient>;
	}, 2_000);
