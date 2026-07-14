type EnvKey =
	| "NODE_ENV"
	| "SUPABASE_URL"
	| "SUPABASE_KEY"
	| "DATABASE_URL"
	| "REDIS_HOST"
	| "REDIS_PORT"
	| "REDIS_PASSWORD"
	| "PORT"
	| "LOG_LEVEL"
	| "CACHE_TTL_SECONDS"
	| "JWT_SECRET"
	| "JWT_ACCESS_EXPIRY"
	| "JWT_REFRESH_EXPIRY"
	| "BETTER_AUTH_SECRET"
	| "BETTER_AUTH_URL"
	| "BACKEND_PROXY_SECRET"
	| "GRAPHQL_AUTH_MODE"
	| "METRICS_TOKEN"
	| "GOOGLE_CLIENT_ID"
	| "GOOGLE_CLIENT_SECRET"
	| "APPLE_CLIENT_ID"
	| "APPLE_CLIENT_SECRET"
	| "APP_URL"
	| "CORS_ORIGIN"
	| "CORS_CREDENTIALS"
	| "WECHAT_APPID"
	| "WECHAT_APPSECRET"
	| "WECHAT_API_SESSION_TTL_SECONDS";

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

const NODE_ENV = readEnv("NODE_ENV") ?? "development";
const isProduction = NODE_ENV === "production";

const requireInProduction = (key: EnvKey): string => {
	const value = readEnv(key) ?? "";
	if (isProduction && value.length === 0) {
		throw new Error(`Missing required production env: ${key}`);
	}
	return value;
};

const GRAPHQL_AUTH_MODE = readEnv("GRAPHQL_AUTH_MODE") ?? "enforce";
if (isProduction && GRAPHQL_AUTH_MODE === "report") {
	throw new Error(
		"GRAPHQL_AUTH_MODE=report is not allowed in production (fails open)",
	);
}

const CORS_ORIGIN = readEnv("CORS_ORIGIN") ?? (isProduction ? "" : "*");
const CORS_CREDENTIALS = readEnv("CORS_CREDENTIALS") === "true";
if (isProduction && CORS_CREDENTIALS && (CORS_ORIGIN === "*" || !CORS_ORIGIN)) {
	throw new Error(
		"CORS_ORIGIN must be an explicit allowlist when CORS_CREDENTIALS=true in production",
	);
}
if (isProduction && !CORS_ORIGIN) {
	throw new Error("Missing required production env: CORS_ORIGIN");
}

const JWT_SECRET = isProduction
	? requireInProduction("JWT_SECRET")
	: (readEnv("JWT_SECRET") ?? "dev-secret-change-in-production");

if (isProduction && JWT_SECRET === "dev-secret-change-in-production") {
	throw new Error("JWT_SECRET must not use the development default in production");
}

const BETTER_AUTH_SECRET = isProduction
	? requireInProduction("BETTER_AUTH_SECRET")
	: (readEnv("BETTER_AUTH_SECRET") ?? "dev-better-auth-secret-change-me");

export const env = {
	NODE_ENV,
	isProduction,
	SUPABASE_URL: requireEnv("SUPABASE_URL"),
	SUPABASE_KEY: requireEnv("SUPABASE_KEY"),
	DATABASE_URL: requireEnv("DATABASE_URL"),
	REDIS_HOST: requireEnv("REDIS_HOST"),
	REDIS_PORT: readNumber("REDIS_PORT", 6379),
	REDIS_PASSWORD: readEnv("REDIS_PASSWORD") ?? "",
	PORT: readNumber("PORT", 4000),
	LOG_LEVEL: readEnv("LOG_LEVEL") ?? "info",
	CACHE_TTL_SECONDS: readNumber("CACHE_TTL_SECONDS", 60),

	// Authentication
	JWT_SECRET,
	JWT_ACCESS_EXPIRY: readEnv("JWT_ACCESS_EXPIRY") ?? "15m",
	JWT_REFRESH_EXPIRY: readEnv("JWT_REFRESH_EXPIRY") ?? "7d",
	BETTER_AUTH_SECRET,
	BETTER_AUTH_URL: readEnv("BETTER_AUTH_URL") ?? readEnv("APP_URL") ?? "http://localhost:4000",
	BACKEND_PROXY_SECRET: readEnv("BACKEND_PROXY_SECRET") ?? "",
	GRAPHQL_AUTH_MODE,
	METRICS_TOKEN: readEnv("METRICS_TOKEN") ?? "",

	// OAuth Providers (optional)
	GOOGLE_CLIENT_ID: readEnv("GOOGLE_CLIENT_ID") ?? "",
	GOOGLE_CLIENT_SECRET: readEnv("GOOGLE_CLIENT_SECRET") ?? "",
	APPLE_CLIENT_ID: readEnv("APPLE_CLIENT_ID") ?? "",
	APPLE_CLIENT_SECRET: readEnv("APPLE_CLIENT_SECRET") ?? "",
	APP_URL: readEnv("APP_URL") ?? "http://localhost:3000",

	// CORS
	CORS_ORIGIN,
	CORS_CREDENTIALS,

	// WeChat Mini Program
	WECHAT_APPID: readEnv("WECHAT_APPID") ?? "",
	WECHAT_APPSECRET: readEnv("WECHAT_APPSECRET") ?? "",
	WECHAT_API_SESSION_TTL_SECONDS: readNumber(
		"WECHAT_API_SESSION_TTL_SECONDS",
		60 * 60 * 24 * 30,
	),
} as const;
