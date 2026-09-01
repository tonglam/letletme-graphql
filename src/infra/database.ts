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

type PoolCapacityState = Readonly<{
	totalCount: number;
	idleCount: number;
	options: Readonly<{ max?: number }>;
}>;

/**
 * pg-pool can briefly expose an idle checkout through waitingCount while its
 * next-tick pulse is running. Only a pool with no idle client and a reached
 * max can make the request wait for another checkout.
 */
export const poolHasNoImmediateCapacity = (pool: PoolCapacityState): boolean => {
	const max = pool.options.max;
	return (
		typeof max === "number" &&
		Number.isSafeInteger(max) &&
		max > 0 &&
		pool.totalCount >= max &&
		pool.idleCount === 0
	);
};

const recordPoolWaitIfAtCapacity = (pool: PoolCapacityState): void => {
	if (poolHasNoImmediateCapacity(pool)) postgresPoolWaitEvents.inc();
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
		recordPoolWaitIfAtCapacity(dbPool);
		const result = dbPool.query<Row>(text, [...values]);
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
		recordPoolWaitIfAtCapacity(dbPool);
		const client = dbPool.connect() as unknown as Promise<DatabaseHealthClient>;
		return client;
	}, 2_000);
