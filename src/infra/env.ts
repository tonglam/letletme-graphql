import { parseDatabasePoolMax } from "./database-pool-config";
import { parsePositiveIntegerEnv } from "./env-value";

type EnvKey =
	| "NODE_ENV"
	| "DATABASE_URL"
	| "DATABASE_POOL_MAX"
	| "REDIS_HOST"
	| "REDIS_PORT"
	| "REDIS_PASSWORD"
	| "PORT"
	| "LOG_LEVEL"
	| "BACKEND_PROXY_SECRET"
	| "GRAPHQL_SERVICE_TOKEN"
	| "METRICS_TOKEN"
	| "CORS_ORIGIN"
	| "CORS_CREDENTIALS"
	| "TRUSTED_PROXY_HOPS"
	| "GRAPHQL_BROWSER_INGRESS_RATE_LIMIT"
	| "GRAPHQL_AUTHENTICATED_RATE_LIMIT"
	| "GRAPHQL_ANONYMOUS_RATE_LIMIT";

const readEnv = (key: EnvKey): string | undefined => {
	const value = Bun.env[key];
	if (value !== undefined) {
		return value;
	}
	return process.env[key];
};

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

const readPositiveInteger = (key: EnvKey, fallback: number): number => {
	return parsePositiveIntegerEnv(readEnv(key), key, fallback);
};

const NODE_ENV = readEnv("NODE_ENV") ?? "development";
const isProduction = NODE_ENV === "production";

const BACKEND_PROXY_SECRET = readEnv("BACKEND_PROXY_SECRET") ?? "";
const GRAPHQL_SERVICE_TOKEN = readEnv("GRAPHQL_SERVICE_TOKEN") ?? "";
if (isProduction && Buffer.byteLength(BACKEND_PROXY_SECRET, "utf8") < 32) {
	throw new Error("BACKEND_PROXY_SECRET must contain at least 32 bytes in production");
}
if (isProduction && Buffer.byteLength(GRAPHQL_SERVICE_TOKEN, "utf8") < 32) {
	throw new Error("GRAPHQL_SERVICE_TOKEN must contain at least 32 bytes in production");
}

const CORS_ORIGIN = readEnv("CORS_ORIGIN") ?? (isProduction ? "" : "*");
const CORS_CREDENTIALS = readEnv("CORS_CREDENTIALS") === "true";
const CORS_ORIGINS = CORS_ORIGIN.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);
if (isProduction && CORS_CREDENTIALS && (CORS_ORIGINS.includes("*") || CORS_ORIGINS.length === 0)) {
	throw new Error(
		"CORS_ORIGIN must be an explicit allowlist when CORS_CREDENTIALS=true in production"
	);
}
if (isProduction && !CORS_ORIGIN) {
	throw new Error("Missing required production env: CORS_ORIGIN");
}

const TRUSTED_PROXY_HOPS = readNumber("TRUSTED_PROXY_HOPS", 0);
if (!Number.isInteger(TRUSTED_PROXY_HOPS) || TRUSTED_PROXY_HOPS < 0) {
	throw new Error("TRUSTED_PROXY_HOPS must be a non-negative integer");
}

export const env = {
	NODE_ENV,
	isProduction,
	DATABASE_URL: requireEnv("DATABASE_URL"),
	DATABASE_POOL_MAX: parseDatabasePoolMax(readEnv("DATABASE_POOL_MAX")),
	REDIS_HOST: requireEnv("REDIS_HOST"),
	REDIS_PORT: readNumber("REDIS_PORT", 6379),
	REDIS_PASSWORD: readEnv("REDIS_PASSWORD") ?? "",
	PORT: readNumber("PORT", 4000),
	LOG_LEVEL: readEnv("LOG_LEVEL") ?? "info",

	// Authentication (issued by letletme-web; GraphQL validates only)
	BACKEND_PROXY_SECRET,
	GRAPHQL_SERVICE_TOKEN,
	METRICS_TOKEN: readEnv("METRICS_TOKEN") ?? "",

	// CORS
	CORS_ORIGIN,
	CORS_CREDENTIALS,
	TRUSTED_PROXY_HOPS,

	// Two-stage GraphQL admission. The global and shared-public ceilings remain
	// fixed operational safety contracts; these three are deploy-tunable.
	GRAPHQL_BROWSER_INGRESS_RATE_LIMIT: readPositiveInteger(
		"GRAPHQL_BROWSER_INGRESS_RATE_LIMIT",
		120
	),
	GRAPHQL_AUTHENTICATED_RATE_LIMIT: readPositiveInteger("GRAPHQL_AUTHENTICATED_RATE_LIMIT", 300),
	GRAPHQL_ANONYMOUS_RATE_LIMIT: readPositiveInteger("GRAPHQL_ANONYMOUS_RATE_LIMIT", 120),
} as const;
