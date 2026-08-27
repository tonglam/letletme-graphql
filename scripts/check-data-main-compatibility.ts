import { validateDatabaseContract } from "../src/infra/database-contract";
import { database } from "../src/infra/database";
import { closeDbPool } from "../src/infra/db-pool";

try {
	const contract = await validateDatabaseContract(database);
	console.log(
		JSON.stringify({
			status: "data_candidate_graphql_contract_passed",
			dataCandidateSha: process.env.DATA_CANDIDATE_SHA?.trim() || null,
			...contract,
		})
	);
} finally {
	await closeDbPool();
}
