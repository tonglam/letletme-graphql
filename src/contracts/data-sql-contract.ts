export type DataSqlContractResultType = Readonly<{
	relation: string;
	column: string;
	pgType: string;
	/** Additional PostgreSQL types with the same node-postgres decoded shape. */
	acceptedPgTypes?: readonly string[];
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
 * A small allowlist is available for PostgreSQL types such as json/jsonb
 * that are decoded to the same JavaScript shape by node-postgres.
 */
export type DataSqlContractProbe = Readonly<{
	name: string;
	sql: string;
	values: readonly unknown[];
	resultTypes?: readonly DataSqlContractResultType[];
	/** Execute the statement with the runtime reader role and assert its fixture-backed result shape. */
	runtime?:
		| "must-return-row"
		| "must-return-entry-search"
		| "must-return-publication"
		| "must-return-snapshot-entry"
		| "must-return-briefing"
		| "must-return-core"
		| "must-return-competition-aggregate"
		| "must-return-price-change"
		| "must-return-trends-personal"
		| "must-return-board"
		| "must-return-season-path"
		| "must-return-briefing-metadata"
		| "must-return-live"
		| "must-return-live-lifecycle"
		| "must-return-market"
		| "must-return-market-authority"
		| "must-return-player-state-revision"
		| "must-return-player-state-current-peers"
		| "must-return-player-state-gameweeks"
		| "must-return-historical-team"
		| "must-return-setup-status"
		| "must-return-tournament"
		| "must-return-selection-row"
		| "must-return-player-picker"
		| "must-return-player-state-row";
}>;
