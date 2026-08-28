import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "fs/promises";
import {
	GRAPHQL_RATE_LIMIT_MODES,
	parseGraphQLRateLimitMode,
} from "../../src/http/rate-limit-policy-v3";

const retiredEnvironmentNames = [
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
	"LETLETME_GRAPHQL_REDIS_HOST",
	"LETLETME_GRAPHQL_REDIS_PORT",
	"LETLETME_GRAPHQL_REDIS_PASSWORD",
] as const;
const retiredEnvironmentPattern = new RegExp(`\\b(?:${retiredEnvironmentNames.join("|")})\\b`, "g");

const canonicalTestEnvironment = (): NodeJS.ProcessEnv => ({
	...process.env,
	NODE_ENV: "test",
	DATABASE_URL: "postgresql://test",
	REDIS_URL: "redis://127.0.0.1:6379",
	RATE_LIMIT_REDIS_URL: "redis://127.0.0.1:6380",
	APP_REVISION: "a".repeat(40),
	LETLETME_DATA_URL: "http://data.test",
	LETLETME_DATA_API_KEY: "test",
	BACKEND_PROXY_SECRET: "a".repeat(32),
	GRAPHQL_SERVICE_TOKEN: "b".repeat(32),
	CORS_ORIGIN: "*",
});

const importEnvInChild = (overrides: Record<string, string | undefined>) => {
	const childEnvironment = canonicalTestEnvironment();
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete childEnvironment[key];
		else childEnvironment[key] = value;
	}
	return spawnSync(process.execPath, ["-e", 'import("./src/infra/env.ts")'], {
		cwd: process.cwd(),
		env: childEnvironment,
		encoding: "utf8",
	});
};

describe("hard-cut runtime configuration", () => {
	test("accepts only versioned rate-limit modes and rejects the retired mode", () => {
		expect(GRAPHQL_RATE_LIMIT_MODES).toEqual([
			"shadow-v3",
			"enforce-v3",
			"shadow-v4",
			"enforce-v4",
		]);
		expect(parseGraphQLRateLimitMode(undefined)).toBe("shadow-v3");
		expect(() => parseGraphQLRateLimitMode("legacy")).toThrow(
			/GRAPHQL_RATE_LIMIT_MODE must be one of/
		);
	});

	test("does not publish retired variables in operator-facing examples", async () => {
		const examples = await Promise.all([
			readFile(".env.example", "utf8"),
			readFile(".env.deploy.example", "utf8"),
		]);
		for (const source of examples) {
			for (const name of retiredEnvironmentNames) {
				expect(source).not.toMatch(new RegExp(`^${name}=`, "m"));
			}
		}
	});

	test("keeps retired names only in explicit startup and deployment rejection gates", async () => {
		const sources = new Map<string, string>();
		const patterns = [
			"src/**/*.ts",
			"scripts/**/*.{ts,sh}",
			".github/**/*.yml",
			"documentation/**/*.md",
		];
		for (const pattern of patterns) {
			for await (const path of new Bun.Glob(pattern).scan(".")) {
				sources.set(path, await Bun.file(path).text());
			}
		}
		for (const path of [
			".env.example",
			".env.deploy.example",
			"README.md",
			"Dockerfile",
			"docker-compose.yml",
		]) {
			sources.set(path, await Bun.file(path).text());
		}

		const unexpected = [...sources]
			.filter(([path]) => !["src/infra/env.ts", "scripts/deploy-remote.sh"].includes(path))
			.flatMap(([path, source]) =>
				[...source.matchAll(retiredEnvironmentPattern)].map((match) => `${path}:${match[0]}`)
			);
		expect(unexpected).toEqual([]);

		const envSource = sources.get("src/infra/env.ts") ?? "";
		for (const name of retiredEnvironmentNames) {
			expect(envSource).toContain(`"${name}"`);
			expect(envSource).not.toContain(`readEnv("${name}")`);
			expect(envSource).not.toContain(`readRuntimeEnv("${name}")`);
		}
	});

	test("keeps direct runtime-environment reads inside the typed configuration boundary", async () => {
		const unexpected: string[] = [];
		for await (const path of new Bun.Glob("src/**/*.ts").scan(".")) {
			if (["src/infra/env.ts", "src/infra/runtime-env.ts"].includes(path)) continue;
			const source = await Bun.file(path).text();
			if (/\b(?:process\.env|Bun\.env|readRuntimeEnv)\b/u.test(source)) unexpected.push(path);
		}
		expect(unexpected).toEqual([]);
	});

	test("rejects retired variables before accepting a canonical environment", () => {
		const result = importEnvInChild({ REDIS_HOST: "127.0.0.1" });
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"Unsupported retired environment variables: REDIS_HOST"
		);
	});

	test("requires both canonical Redis endpoints and rejects the retired rate mode", () => {
		const missingRateLimitRedis = importEnvInChild({ RATE_LIMIT_REDIS_URL: undefined });
		expect(missingRateLimitRedis.status).not.toBe(0);
		expect(`${missingRateLimitRedis.stdout}${missingRateLimitRedis.stderr}`).toContain(
			"Missing required env: RATE_LIMIT_REDIS_URL"
		);

		const retiredMode = importEnvInChild({ GRAPHQL_RATE_LIMIT_MODE: "legacy" });
		expect(retiredMode.status).not.toBe(0);
		expect(`${retiredMode.stdout}${retiredMode.stderr}`).toContain(
			"GRAPHQL_RATE_LIMIT_MODE must be one of shadow-v3, enforce-v3, shadow-v4, enforce-v4"
		);
	});

	test("requires canonical Data service settings in production", () => {
		const missingDataKey = importEnvInChild({
			NODE_ENV: "production",
			LETLETME_DATA_API_KEY: undefined,
		});
		expect(missingDataKey.status).not.toBe(0);
		expect(`${missingDataKey.stdout}${missingDataKey.stderr}`).toContain(
			"Production LETLETME_DATA_URL and LETLETME_DATA_API_KEY are required"
		);

		for (const invalidUrl of ["not-a-url", "redis://data.internal:6379"]) {
			const invalidDataUrl = importEnvInChild({
				NODE_ENV: "production",
				LETLETME_DATA_URL: invalidUrl,
			});
			expect(invalidDataUrl.status).not.toBe(0);
			expect(`${invalidDataUrl.stdout}${invalidDataUrl.stderr}`).toContain(
				"LETLETME_DATA_URL must be a valid HTTP(S) URL"
			);
		}
	});

	test("requires an exact immutable image revision in production", () => {
		const unknownRevision = importEnvInChild({
			NODE_ENV: "production",
			APP_REVISION: "unknown",
		});
		expect(unknownRevision.status).not.toBe(0);
		expect(`${unknownRevision.stdout}${unknownRevision.stderr}`).toContain(
			"APP_REVISION must be the exact 40-character lowercase Git SHA in production"
		);
	});
});
