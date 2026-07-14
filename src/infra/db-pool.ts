import { Pool } from "pg";
import { env } from "./env";

/**
 * Shared PostgreSQL pool for Better Auth, device auth, WeChat sessions,
 * and resolver queries. Prefer this over creating per-module pools.
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
