import { Pool } from "pg";
import { env } from "./env";

/**
 * Shared PostgreSQL pool for token validation and resolver queries.
 * Authentication tables are owned and migrated by letletme-web.
 */
export const dbPool = new Pool({
	connectionString: env.DATABASE_URL,
	max: 20,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 2_000,
});

export const closeDbPool = async (): Promise<void> => {
	await dbPool.end();
};
