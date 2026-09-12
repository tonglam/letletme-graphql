import { Pool } from "pg";
import { env } from "./env";
import { logger } from "./logger";
import { postgresPoolErrors } from "./metrics";

/**
 * Shared PostgreSQL pool for token validation and resolver queries.
 * Authentication tables are owned and migrated by letletme-web.
 */
export const dbPool = new Pool({
	connectionString: env.DATABASE_URL,
	max: env.DATABASE_POOL_MAX,
	// The live hot path is Redis-first. Do not hold an idle database session;
	// reserve the configured ceiling (1–4, default 4) for bounded reads.
	min: 0,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 2_000,
	statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
	application_name: "letletme-graphql",
});

// pg-pool removes a broken idle client before emitting this event. An
// unhandled pool error would otherwise terminate the entire serving process.
dbPool.on("error", (error) => {
	const code = "code" in error ? error.code : undefined;
	const category =
		code === "57P01" || code === "57P02" || code === "57P03"
			? "server_shutdown"
			: code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT"
				? "connection"
				: "other";
	postgresPoolErrors.labels(category).inc();
	logger.warn({ category }, "PostgreSQL idle connection removed after pool error");
});

export const closeDbPool = async (): Promise<void> => {
	await dbPool.end();
};
