import { parseDatabasePoolMax } from "./database-pool-config";
import { parseBoundedPositiveIntegerEnv, parsePositiveIntegerEnv } from "./env-value";
import {
	GRAPHQL_ANONYMOUS_RATE_LIMIT_DEFAULT,
	GRAPHQL_AUTHENTICATED_RATE_LIMIT_DEFAULT,
	GRAPHQL_BROWSER_INGRESS_RATE_LIMIT_DEFAULT,
} from "../http/rate-limit-defaults";

type EnvKey =
	| "NODE_ENV"
	| "DATABASE_URL"
	| "DATABASE_POOL_MAX"
	| "DATABASE_STATEMENT_TIMEOUT_MS"
	| "REDIS_HOST"
	| "REDIS_PORT"
	| "REDIS_PASSWORD"
	| "PORT"
	| "LOG_LEVEL"
	| "BACKEND_PROXY_SECRET"
	| "GRAPHQL_SERVICE_TOKEN"
	| "METRICS_TOKEN"
	| "CORS_ORIGIN"
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
if (isProduction && !CORS_ORIGIN) {
	throw new Error("Missing required production env: CORS_ORIGIN");
}

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

	// Two-stage GraphQL admission. The global and shared-public ceilings remain
	// fixed operational safety contracts; these three are deploy-tunable.
	GRAPHQL_BROWSER_INGRESS_RATE_LIMIT: readPositiveInteger(
		"GRAPHQL_BROWSER_INGRESS_RATE_LIMIT",
		GRAPHQL_BROWSER_INGRESS_RATE_LIMIT_DEFAULT
	),
	GRAPHQL_AUTHENTICATED_RATE_LIMIT: readPositiveInteger(
		"GRAPHQL_AUTHENTICATED_RATE_LIMIT",
		GRAPHQL_AUTHENTICATED_RATE_LIMIT_DEFAULT
	),
	GRAPHQL_ANONYMOUS_RATE_LIMIT: readPositiveInteger(
		"GRAPHQL_ANONYMOUS_RATE_LIMIT",
		GRAPHQL_ANONYMOUS_RATE_LIMIT_DEFAULT
	),
} as const;
