import type { PoolClient, QueryResult, QueryResultRow } from "pg";
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

/**
 * pg-pool briefly puts every checkout behind an idle client into its pending
 * queue before the next-tick pulse hands that client over. Compare the queue
 * before and after this specific connect call, and use the pre-call idle count
 * to exclude that normal handoff. A checkout added while no idle client exists
 * is a real pool wait even if the busy client is released before a later event
 * loop phase can observe the queue.
 */
export const poolCheckoutNeedsWaitMetric = (
	waitingCountBefore: number,
	waitingCountAfter: number,
	idleCountBefore: number,
	idleHandoffReservationsBefore: number
): boolean =>
	Number.isSafeInteger(waitingCountBefore) &&
	Number.isSafeInteger(waitingCountAfter) &&
	Number.isSafeInteger(idleCountBefore) &&
	Number.isSafeInteger(idleHandoffReservationsBefore) &&
	waitingCountBefore >= 0 &&
	waitingCountAfter >= 0 &&
	idleCountBefore >= 0 &&
	idleHandoffReservationsBefore >= 0 &&
	waitingCountAfter > waitingCountBefore &&
	idleCountBefore <= idleHandoffReservationsBefore;

let idleHandoffReservations = 0;

const connectFromPool = (): Promise<PoolClient> => {
	const waitingCountBefore = dbPool.waitingCount;
	const idleCountBefore = dbPool.idleCount;
	const checkout = dbPool.connect();
	if (
		poolCheckoutNeedsWaitMetric(
			waitingCountBefore,
			dbPool.waitingCount,
			idleCountBefore,
			idleHandoffReservations
		)
	) {
		postgresPoolWaitEvents.inc();
	}
	if (dbPool.waitingCount > waitingCountBefore && idleCountBefore > idleHandoffReservations) {
		idleHandoffReservations += 1;
		const releaseIdleHandoffReservation = (): void => {
			idleHandoffReservations = Math.max(0, idleHandoffReservations - 1);
		};
		void checkout.then(releaseIdleHandoffReservation, releaseIdleHandoffReservation);
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
