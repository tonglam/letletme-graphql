import { createHash } from "crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";

const databaseUrl = Bun.env.DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationsDir = resolve(
	Bun.env.MIGRATIONS_DIR ??
		process.env.MIGRATIONS_DIR ??
		resolve(import.meta.dir, "../migrations/forward")
);
const statusOnly = process.argv.includes("--status");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

type AppliedMigration = { version: string; checksum: string; applied_at: Date };

const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex");

async function ensureLedger(client: PoolClient): Promise<void> {
	await client.query(`
    CREATE TABLE IF NOT EXISTS public.graphql_schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function main(): Promise<void> {
	const client = await pool.connect();
	try {
		const versionResult = await client.query<{ server_version_num: string }>(
			"SELECT current_setting('server_version_num') AS server_version_num"
		);
		const version = Number(versionResult.rows[0]?.server_version_num);
		if (!Number.isInteger(version) || version < 150000) {
			throw new Error(
				`PostgreSQL 15 or newer is required (server_version_num=${versionResult.rows[0]?.server_version_num ?? "unknown"})`
			);
		}
		await client.query("SELECT pg_advisory_lock(hashtext('letletme_graphql_migrations'))");
		await ensureLedger(client);

		const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
		const appliedResult = await client.query<AppliedMigration>(
			"SELECT version, checksum, applied_at FROM public.graphql_schema_migrations ORDER BY version"
		);
		const applied = new Map(appliedResult.rows.map((row) => [row.version, row] as const));
		const local = new Set(files);
		const missing = [...applied.keys()].filter((version) => !local.has(version));
		const latestApplied = [...applied.keys()].sort().at(-1);
		const backdated = latestApplied
			? files.filter((file) => !applied.has(file) && file < latestApplied)
			: [];
		let pending = 0;
		let invalid = false;

		for (const version of missing) {
			console.log(`missing ${version}`);
			invalid = true;
		}
		for (const version of backdated) {
			console.log(`backdated ${version} (latest applied: ${latestApplied})`);
			invalid = true;
		}

		if (!statusOnly && missing.length > 0) {
			throw new Error(`Ledgered migration files are missing: ${missing.join(", ")}`);
		}
		if (!statusOnly && backdated.length > 0) {
			throw new Error(
				`Pending migrations sort before the applied tail ${latestApplied}: ${backdated.join(", ")}`
			);
		}

		for (const file of files) {
			const sql = await Bun.file(resolve(migrationsDir, file)).text();
			const digest = checksum(sql);
			const previous = applied.get(file);
			if (previous) {
				if (previous.checksum !== digest) {
					throw new Error(`Checksum mismatch for applied migration ${file}`);
				}
				console.log(`applied ${file} ${previous.applied_at.toISOString()}`);
				continue;
			}

			if (statusOnly) {
				console.log(`pending ${file}`);
				pending += 1;
				invalid = true;
				continue;
			}

			await client.query("BEGIN");
			try {
				await client.query(sql);
				await client.query(
					"INSERT INTO public.graphql_schema_migrations (version, checksum) VALUES ($1, $2)",
					[file, digest]
				);
				await client.query("COMMIT");
				console.log(`applied ${file}`);
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
		}
		if (statusOnly && (pending > 0 || invalid)) process.exitCode = 1;
	} finally {
		await client
			.query("SELECT pg_advisory_unlock(hashtext('letletme_graphql_migrations'))")
			.catch(() => undefined);
		client.release();
		await pool.end();
	}
}

await main();
