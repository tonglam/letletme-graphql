import { Pool } from "pg";
import { env } from "./env";

/**
 * Shared PostgreSQL pool for token validation and resolver queries.
 * Authentication tables are owned and migrated by letletme-web.
 */
export const dbPool = new Pool({
	connectionString: env.DATABASE_URL,
	max: env.DATABASE_POOL_MAX,
	// Keep one cross-region pooler connection available for low-frequency reads.
	// Additional connections still retire after idleTimeoutMillis.
	min: 1,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 2_000,
});

export const closeDbPool = async (): Promise<void> => {
	await dbPool.end();
};
