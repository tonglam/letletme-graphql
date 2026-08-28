export type DataSqlContractResultType = Readonly<{
	relation: string;
	column: string;
	pgType: string;
}>;

/**
 * A production SQL statement and representative bind values used to ask the
 * Data candidate's PostgreSQL planner to validate the exact consumer shape.
 *
 * The SQL text in a probe must be the same exported constant executed by the
 * runtime.  That keeps the scheduled Data-main check from degrading into a
 * second, hand-maintained schema description.  Result type assertions cover
 * columns whose node-postgres value shape is part of the consumer contract;
 * EXPLAIN alone cannot detect a jsonb-to-text drift when no rows are read.
 */
export type DataSqlContractProbe = Readonly<{
	name: string;
	sql: string;
	values: readonly unknown[];
	resultTypes?: readonly DataSqlContractResultType[];
}>;
