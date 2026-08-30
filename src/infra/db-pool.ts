import { Pool } from "pg";
import { env } from "./env";

/**
 * Shared PostgreSQL pool for token validation and resolver queries.
 * Authentication tables are owned and migrated by letletme-web.
 */
export const dbPool = new Pool({
	connectionString: env.DATABASE_URL,
	max: env.DATABASE_POOL_MAX,
	// The live hot path is Redis-first. Do not hold an idle database session;
	// reserve the two-session ceiling for bounded checkpoint/metadata reads.
	min: 0,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 2_000,
	statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
	application_name: "letletme-graphql",
});

export const closeDbPool = async (): Promise<void> => {
	await dbPool.end();
};
