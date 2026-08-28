/**
 * A production SQL statement and representative bind values used to ask the
 * Data candidate's PostgreSQL planner to validate the exact consumer shape.
 *
 * The SQL text in a probe must be the same exported constant executed by the
 * runtime.  That keeps the scheduled Data-main check from degrading into a
 * second, hand-maintained schema description.
 */
export type DataSqlContractProbe = Readonly<{
	name: string;
	sql: string;
	values: readonly unknown[];
}>;
