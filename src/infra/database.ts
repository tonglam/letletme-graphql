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

const recordNewlyQueuedPoolWaits = (waitingBefore: number): void => {
	const newlyQueued = Math.max(0, dbPool.waitingCount - waitingBefore);
	if (newlyQueued > 0) postgresPoolWaitEvents.inc(newlyQueued);
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
		const waitingBefore = dbPool.waitingCount;
		const result = dbPool.query<Row>(text, [...values]);
		recordNewlyQueuedPoolWaits(waitingBefore);
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
		const waitingBefore = dbPool.waitingCount;
		const client = dbPool.connect() as unknown as Promise<DatabaseHealthClient>;
		recordNewlyQueuedPoolWaits(waitingBefore);
		return client;
	}, 2_000);
