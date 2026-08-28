import { validateDatabaseContract } from "../src/infra/database-contract";
import { database } from "../src/infra/database";
import { closeDbPool } from "../src/infra/db-pool";
import { validateDirectDataSqlContract } from "./lib/validate-direct-data-sql-contract";

try {
	const contract = await validateDatabaseContract(database);
	const directSqlProbeCount = await validateDirectDataSqlContract(database);
	console.log(
		JSON.stringify({
			status: "data_candidate_graphql_contract_passed",
			dataCandidateSha: process.env.DATA_CANDIDATE_SHA?.trim() || null,
			directSqlProbeCount,
			...contract,
		})
	);
} finally {
	await closeDbPool();
}
