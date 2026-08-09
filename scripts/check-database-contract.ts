import { validateDatabaseContract } from "../src/infra/database-contract";
import { database } from "../src/infra/database";
import { closeDbPool } from "../src/infra/db-pool";

try {
	const contract = await validateDatabaseContract(database);
	console.log(JSON.stringify(contract));
} finally {
	await closeDbPool();
}
