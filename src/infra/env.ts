import { parseDatabasePoolMax } from "./database-pool-config";
import { parseBoundedPositiveIntegerEnv, parseFullFieldLiveBoardEnabled } from "./env-value";
import { readRuntimeEnv } from "./runtime-env";
import { parseGraphQLRateLimitMode } from "../http/rate-limit-policy-v3";

type EnvKey =
	| "NODE_ENV"
	| "DATABASE_URL"
	| "DATABASE_POOL_MAX"
	| "DATABASE_STATEMENT_TIMEOUT_MS"
	| "LETLETME_DATA_URL"
	| "LETLETME_DATA_API_KEY"
	| "FULL_FIELD_LIVE_BOARD_ENABLED"
	| "REDIS_URL"
	| "RATE_LIMIT_REDIS_URL"
	| "DEPLOY_SHA"
	| "PORT"
	| "LOG_LEVEL"
	| "BACKEND_PROXY_SECRET"
	| "GRAPHQL_SERVICE_TOKEN"
	| "METRICS_TOKEN"
	| "CORS_ORIGIN"
	| "GRAPHQL_RATE_LIMIT_MODE";

const readEnv = (key: EnvKey): string | undefined => readRuntimeEnv(key);

const requireEnv = (key: EnvKey): string => {
	const value = readEnv(key);
	if (!value) {
		throw new Error(`Missing required env: ${key}`);
	}
	return value;
};

const readNumber = (key: EnvKey, fallback: number): number => {
	const raw = readEnv(key);
	if (!raw) {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid number for env: ${key}`);
	}
	return parsed;
};

type RedisEndpoint = Readonly<{
	url: string;
	identity: string;
}>;

const parseRedisEndpoint = (urlKey: "REDIS_URL" | "RATE_LIMIT_REDIS_URL"): RedisEndpoint => {
	const configuredUrl = readEnv(urlKey)?.trim();
	if (!configuredUrl) {
		throw new Error(`Missing required env: ${urlKey}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(configuredUrl);
	} catch {
		throw new Error(`${urlKey} must be a valid Redis URL`);
	}
	if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
		throw new Error(`${urlKey} must use redis:// or rediss://`);
	}
	const port = parsed.port ? Number(parsed.port) : 6379;
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !parsed.hostname) {
		throw new Error(`${urlKey} must include a valid host and port`);
	}
	return {
		url: configuredUrl,
		// Isolation is about the backing endpoint, not transport. Treating
		// redis:// and rediss:// on the same host/port as different stores
		// would allow an accidental shared Redis to pass the production gate.
		identity: `${parsed.hostname}:${port}`,
	};
};

const NODE_ENV = readEnv("NODE_ENV") ?? "development";
const isProduction = NODE_ENV === "production";
const DEPLOY_SHA = readEnv("DEPLOY_SHA")?.trim() || "unknown";
if (isProduction && !/^[0-9a-f]{40}$/.test(DEPLOY_SHA)) {
	throw new Error("DEPLOY_SHA must be the exact 40-character lowercase Git SHA in production");
}

// These names were accepted by the pre-hard-cut runtime. Keeping them in the
// process environment is an operator error, even when the canonical URL is
// also present: silently ignoring them would make an accidental rollback
// configuration impossible to detect.
const RETIRED_ENV_KEYS = [
	"REDIS_HOST",
	"REDIS_PORT",
	"REDIS_PASSWORD",
	"RATE_LIMIT_REDIS_HOST",
	"RATE_LIMIT_REDIS_PORT",
	"RATE_LIMIT_REDIS_PASSWORD",
	"GRAPHQL_BROWSER_INGRESS_RATE_LIMIT",
	"GRAPHQL_AUTHENTICATED_RATE_LIMIT",
	"GRAPHQL_ANONYMOUS_RATE_LIMIT",
	"MY_FPL_SNAPSHOT_READ_ENABLED",
	"DATA_API_URL",
	"DATA_API_KEY",
	"DATA_URL",
	"DATA_AUTH_HEADER",
	"LETLETME_GRAPHQL_REDIS_HOST",
	"LETLETME_GRAPHQL_REDIS_PORT",
	"LETLETME_GRAPHQL_REDIS_PASSWORD",
	"APP_REVISION",
] as const;
const runtimeEnvironmentKeys = new Set([
	...Object.keys(process.env),
	...(typeof Bun !== "undefined" ? Object.keys(Bun.env) : []),
]);
const configuredRetiredEnvKeys = RETIRED_ENV_KEYS.filter((key) => runtimeEnvironmentKeys.has(key));
if (configuredRetiredEnvKeys.length > 0) {
	throw new Error(
		`Unsupported retired environment variables: ${configuredRetiredEnvKeys.join(", ")}. Use the canonical configuration names.`
	);
}

const BACKEND_PROXY_SECRET = readEnv("BACKEND_PROXY_SECRET") ?? "";
const GRAPHQL_SERVICE_TOKEN = readEnv("GRAPHQL_SERVICE_TOKEN") ?? "";
if (isProduction && Buffer.byteLength(BACKEND_PROXY_SECRET, "utf8") < 32) {
	throw new Error("BACKEND_PROXY_SECRET must contain at least 32 bytes in production");
}
if (isProduction && Buffer.byteLength(GRAPHQL_SERVICE_TOKEN, "utf8") < 32) {
	throw new Error("GRAPHQL_SERVICE_TOKEN must contain at least 32 bytes in production");
}

const CORS_ORIGIN = readEnv("CORS_ORIGIN") ?? (isProduction ? "" : "*");
if (isProduction && !CORS_ORIGIN) {
	throw new Error("Missing required production env: CORS_ORIGIN");
}

const primaryRedis = parseRedisEndpoint("REDIS_URL");

const rateLimitRedis = parseRedisEndpoint("RATE_LIMIT_REDIS_URL");
if (primaryRedis.identity === rateLimitRedis.identity) {
	throw new Error("Primary and rate-limit Redis endpoints must be different");
}

const parseDataServiceUrl = (value: string): string => {
	if (!value) return "";
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("LETLETME_DATA_URL must be a valid HTTP(S) URL");
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		!parsed.hostname ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new Error("LETLETME_DATA_URL must be a valid HTTP(S) URL");
	}
	return value;
};

const LETLETME_DATA_URL = parseDataServiceUrl(readEnv("LETLETME_DATA_URL")?.trim() ?? "");
const LETLETME_DATA_API_KEY = readEnv("LETLETME_DATA_API_KEY")?.trim() ?? "";
if (isProduction && (!LETLETME_DATA_URL || !LETLETME_DATA_API_KEY)) {
	throw new Error("Production LETLETME_DATA_URL and LETLETME_DATA_API_KEY are required");
}

export type DataServiceConfig = Readonly<{
	url: string;
	apiKey: string;
}>;

/**
 * Canonical Data-service configuration boundary. Tests may replace canonical
 * variables between requests; production validity is still enforced once at
 * startup above and no retired alias is read here.
 */
export const getDataServiceConfig = (): DataServiceConfig => ({
	url: parseDataServiceUrl(readEnv("LETLETME_DATA_URL")?.trim() ?? ""),
	apiKey: readEnv("LETLETME_DATA_API_KEY")?.trim() ?? "",
});

export const env = {
	NODE_ENV,
	isProduction,
	DATABASE_URL: requireEnv("DATABASE_URL"),
	DATABASE_POOL_MAX: parseDatabasePoolMax(readEnv("DATABASE_POOL_MAX")),
	DATABASE_STATEMENT_TIMEOUT_MS: parseBoundedPositiveIntegerEnv(
		readEnv("DATABASE_STATEMENT_TIMEOUT_MS"),
		"DATABASE_STATEMENT_TIMEOUT_MS",
		12_000,
		1_000,
		60_000
	),
	REDIS_URL: primaryRedis.url,
	RATE_LIMIT_REDIS_URL: rateLimitRedis.url,
	REDIS_ENDPOINT_IDENTITY: primaryRedis.identity,
	RATE_LIMIT_REDIS_ENDPOINT_IDENTITY: rateLimitRedis.identity,
	DEPLOY_SHA,
	PORT: readNumber("PORT", 4000),
	LOG_LEVEL: readEnv("LOG_LEVEL") ?? "info",

	// Authentication (issued by letletme-web; GraphQL validates only)
	BACKEND_PROXY_SECRET,
	GRAPHQL_SERVICE_TOKEN,
	METRICS_TOKEN: readEnv("METRICS_TOKEN") ?? "",
	LETLETME_DATA_URL,
	LETLETME_DATA_API_KEY,
	FULL_FIELD_LIVE_BOARD_ENABLED: parseFullFieldLiveBoardEnabled(
		readEnv("FULL_FIELD_LIVE_BOARD_ENABLED")
	),

	// CORS
	CORS_ORIGIN,

	// Admission uses only the reviewed versioned profile. Retired overrides are
	// rejected by the hard-cut configuration gate above.
	GRAPHQL_RATE_LIMIT_MODE: parseGraphQLRateLimitMode(readEnv("GRAPHQL_RATE_LIMIT_MODE")),
} as const;
