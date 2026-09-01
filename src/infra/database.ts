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
 * Infer whether this particular checkout must wait from the pool state at the
 * call boundary. Sampling `waitingCount` after `connect()` is not sufficient:
 * a busy client can be released before that sample and make the queue appear
 * empty again. A checkout waits when an existing waiter is ahead of it, or
 * when every pool slot is busy and no idle client is available for its queue
 * position. A pool with room and no idle client opens a new connection
 * immediately, so that case is explicitly excluded.
 */
export const poolCheckoutNeedsWaitMetric = (
	waitingCountBefore: number,
	idleCountBefore: number,
	totalCountBefore: number,
	poolMax: number
): boolean =>
	Number.isSafeInteger(waitingCountBefore) &&
	Number.isSafeInteger(idleCountBefore) &&
	Number.isSafeInteger(totalCountBefore) &&
	Number.isSafeInteger(poolMax) &&
	waitingCountBefore >= 0 &&
	idleCountBefore >= 0 &&
	totalCountBefore >= 0 &&
	poolMax > 0 &&
	!(idleCountBefore === 0 && totalCountBefore < poolMax) &&
	idleCountBefore <= waitingCountBefore;

const connectFromPool = (): Promise<PoolClient> => {
	const waitingCountBefore = dbPool.waitingCount;
	const idleCountBefore = dbPool.idleCount;
	const totalCountBefore = dbPool.totalCount;
	const checkout = dbPool.connect();
	if (
		poolCheckoutNeedsWaitMetric(
			waitingCountBefore,
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
