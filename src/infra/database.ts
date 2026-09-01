import type { QueryResult, QueryResultRow } from "pg";
import { dbPool } from "./db-pool";
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

type PoolQueueState = Readonly<{
	waitingCount: number;
}>;

/**
 * A checkout with an idle client is briefly represented in pg-pool's pending
 * queue until its next-tick pulse hands that client over. Observe the queue in
 * the following check phase; only a request still queued after that handoff is
 * a real pool wait.
 */
export const poolHasPendingCheckout = (waitingCount: number): boolean =>
	Number.isSafeInteger(waitingCount) && waitingCount > 0;

const recordPoolWaitAfterPulse = (pool: PoolQueueState): void => {
	if (!poolHasPendingCheckout(pool.waitingCount)) return;
	setImmediate(() => {
		if (poolHasPendingCheckout(pool.waitingCount)) postgresPoolWaitEvents.inc();
	});
};

/**
 * The only PostgreSQL capability exposed to GraphQL application code.
 * It deliberately has no transaction or mutation helper surface.
 */
export const database: QueryExecutor = {
	query: <Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values: readonly unknown[] = []
	): Promise<QueryResult<Row>> => {
		const result = dbPool.query<Row>(text, [...values]);
		recordPoolWaitAfterPulse(dbPool);
		return result;
	},
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
		const client = dbPool.connect() as unknown as Promise<DatabaseHealthClient>;
		recordPoolWaitAfterPulse(dbPool);
		return client;
	}, 2_000);
