import { Pool } from "pg";
import Redis from "ioredis";

const databaseUrl = Bun.env.DATABASE_URL ?? process.env.DATABASE_URL;
const redisHost = Bun.env.REDIS_HOST ?? process.env.REDIS_HOST;
if (!databaseUrl || !redisHost) {
	throw new Error("DATABASE_URL and REDIS_HOST are required");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const redis = new Redis({
	host: redisHost,
	port: Number(Bun.env.REDIS_PORT ?? process.env.REDIS_PORT ?? 6379),
	password: Bun.env.REDIS_PASSWORD ?? process.env.REDIS_PASSWORD ?? undefined,
	lazyConnect: true,
});

async function tableExists(name: string): Promise<boolean> {
	const result = await pool.query<{ exists: boolean }>(
		"SELECT to_regclass($1) IS NOT NULL AS exists",
		[name]
	);
	return result.rows[0]?.exists ?? false;
}

async function countIfPresent(table: string, predicate = "TRUE"): Promise<number | null> {
	if (!(await tableExists(table))) return null;
	const result = await pool.query<{ count: string }>(
		`SELECT COUNT(*)::text AS count FROM ${table} WHERE ${predicate}`
	);
	return Number(result.rows[0]?.count ?? 0);
}

async function columnExists(schema: string, table: string, column: string): Promise<boolean> {
	const result = await pool.query<{ exists: boolean }>(
		`SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
     ) AS exists`,
		[schema, table, column]
	);
	return result.rows[0]?.exists ?? false;
}

await redis.connect();
const schema = await pool.query<{
	table_schema: string;
	table_name: string;
	column_name: string;
	data_type: string;
}>(`SELECT table_schema, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema IN ('public', 'bauth')
    ORDER BY table_schema, table_name, ordinal_position`);

const duplicateBindings = (await tableExists('bauth."user"'))
	? await pool.query(
			`SELECT fpl_entry_id, COUNT(*)::int AS owners
       FROM bauth."user"
       WHERE fpl_entry_id IS NOT NULL
       GROUP BY fpl_entry_id HAVING COUNT(*) > 1
       ORDER BY fpl_entry_id`
		)
	: { rows: [] };

const duplicateVerifiedBindings =
	(await tableExists('bauth."user"')) &&
	(await columnExists("bauth", "user", "fpl_entry_verified_at"))
		? await pool.query(
				`SELECT fpl_entry_id, COUNT(*)::int AS owners
         FROM bauth."user"
         WHERE fpl_entry_id IS NOT NULL AND fpl_entry_verified_at IS NOT NULL
         GROUP BY fpl_entry_id HAVING COUNT(*) > 1
         ORDER BY fpl_entry_id`
			)
		: { rows: [] };

const duplicateOpenIds =
	(await tableExists('bauth."user"')) && (await columnExists("bauth", "user", "openid"))
		? await pool.query(
				`SELECT openid, COUNT(*)::int AS owners
         FROM bauth."user"
         WHERE openid IS NOT NULL
         GROUP BY openid HAVING COUNT(*) > 1
         ORDER BY openid`
			)
		: { rows: [] };

const transferCounts = (await tableExists("public.entry_event_transfers"))
	? await pool.query(
			`SELECT event_id, COUNT(*)::int AS rows
       FROM public.entry_event_transfers
       GROUP BY event_id ORDER BY event_id`
		)
	: { rows: [] };

const keyPatterns = [
	"Season:active",
	"event:current",
	"Player:*",
	"Team:*",
	"Fixture:*",
	"Fixtures:*",
	"EventLive:*",
	"LiveBonus:*",
	"LiveBonusV2:*",
	"PlayerValue:*",
	"PlayerValueMissing:*",
	"EntryInfo:*",
	"EventOverallResult:*",
];
const redisTypes: Record<string, Record<string, number>> = {};
for (const pattern of keyPatterns) {
	let cursor = "0";
	const counts: Record<string, number> = {};
	do {
		const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 250);
		cursor = next;
		for (const key of keys) {
			const type = await redis.type(key);
			counts[type] = (counts[type] ?? 0) + 1;
		}
	} while (cursor !== "0");
	redisTypes[pattern] = counts;
}

console.log(
	JSON.stringify(
		{
			capturedAt: new Date().toISOString(),
			currentImage: Bun.env.APP_IMAGE ?? process.env.APP_IMAGE ?? null,
			schema: schema.rows,
			duplicateFplBindings: duplicateBindings.rows,
			duplicateVerifiedFplBindings: duplicateVerifiedBindings.rows,
			duplicateOpenIds: duplicateOpenIds.rows,
			pendingMiniProgramEmailCodes: await countIfPresent(
				"bauth.mini_program_email_code",
				"consumed_at IS NULL AND expires_at > NOW()"
			),
			activeMiniProgramSessions: await countIfPresent(
				"bauth.mini_program_session",
				"revoked_at IS NULL AND expires_at > NOW()"
			),
			activeLegacyWechatSessions: await countIfPresent(
				"bauth.api_sessions",
				"revoked_at IS NULL AND expires_at > NOW()"
			),
			activeDeviceSessions: await countIfPresent("public.device_sessions", "expires_at > NOW()"),
			legacyDataApiKeyRows: await countIfPresent("bauth.apikey"),
			configuredDataOperatorHashCount: (
				Bun.env.DATA_ADMIN_API_KEY_HASHES ??
				process.env.DATA_ADMIN_API_KEY_HASHES ??
				""
			)
				.split(",")
				.map((value) => value.trim())
				.filter((value) => /^[a-f0-9]{64}$/.test(value)).length,
			transferRowsByEvent: transferCounts.rows,
			currentSeason: await redis.get("Season:active"),
			currentEvent: await redis.get("event:current"),
			redisTypes,
		},
		null,
		2
	)
);

await Promise.all([pool.end(), redis.quit()]);
