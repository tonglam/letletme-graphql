import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");

function job(name: string, nextName?: string): string {
	const start = workflow.indexOf(`\n  ${name}:`);
	if (start < 0) throw new Error(`Missing workflow job ${name}`);
	const end = nextName ? workflow.indexOf(`\n  ${nextName}:`, start + 1) : workflow.length;
	if (end < 0) throw new Error(`Missing workflow job ${nextName}`);
	return workflow.slice(start, end);
}

function runtimeEnvPython(): string {
	const marker = `            python3 - .env.deploy "$env_tmp" <<'PY'\n`;
	const start = workflow.indexOf(marker);
	if (start < 0) throw new Error("Missing runtime env Python start marker");
	const bodyStart = start + marker.length;
	const end = workflow.indexOf("\n            PY", bodyStart);
	if (end < 0) throw new Error("Missing runtime env Python end marker");
	return workflow
		.slice(bodyStart, end)
		.split("\n")
		.map((line) => (line.startsWith("            ") ? line.slice(12) : line))
		.join("\n");
}

describe("v3 GraphQL production hard-cut workflow", () => {
	it("keeps the standard deploy environment file private", () => {
		const deploy = job("deploy", "v3_publish_image");
		const umask = deploy.indexOf("umask 077");
		const write = deploy.indexOf(`printf '%s' "$GRAPHQL_ENV" > .env.deploy`);
		const chmod = deploy.indexOf("chmod 600 .env.deploy");
		expect(umask).toBeGreaterThan(0);
		expect(write).toBeGreaterThan(umask);
		expect(chmod).toBeGreaterThan(write);
	});

	it("keeps read-only inspection separate from stop and start", () => {
		const preflight = job("v3_preflight", "v3_stop");
		const status = job("v3_status");
		for (const contents of [preflight, status]) {
			expect(contents).toContain("script_stop: false");
			expect(contents).toContain("set -euo pipefail");
			for (const mutation of [
				"git fetch",
				"git reset",
				"docker compose pull",
				"docker compose run",
				"docker compose up",
				"docker compose stop",
			]) {
				expect(contents).not.toContain(mutation);
			}
		}
	});

	it("requires the exact activation token before stopping GraphQL", () => {
		const stop = job("v3_stop", "v3_start");
		expect(stop).toContain("APPROVE_V3_ACTIVATION $V3_CUTOVER_RUN_ID");
		expect(stop).toContain("docker compose stop -t 30 graphql");
		expect(stop).not.toContain("git reset");
		expect(stop).not.toContain(".env.deploy.before-v3");
	});

	it("gates the exact image before changing checkout or runtime config", () => {
		const start = job("v3_start", "v3_status");
		const dataHealth = start.indexOf("http://127.0.0.1:3000/health");
		const releaseGate = start.indexOf("bun scripts/v3-release-gate.ts");
		const configBackup = start.indexOf("env.deploy.before-v3");
		const conflictGuard = start.indexOf("comm -12");
		const reset = start.indexOf("git reset --hard");
		const contract = start.indexOf("bun run contract:check");
		const serviceStart = start.indexOf("docker compose up -d --no-deps --no-build graphql");

		expect(dataHealth).toBeGreaterThan(0);
		expect(releaseGate).toBeGreaterThan(dataHealth);
		expect(configBackup).toBeGreaterThan(releaseGate);
		expect(conflictGuard).toBeGreaterThan(configBackup);
		expect(reset).toBeGreaterThan(conflictGuard);
		expect(contract).toBeGreaterThan(reset);
		expect(serviceStart).toBeGreaterThan(contract);
		expect(start).toContain("V3_GRAPHQL_DB_PASSWORD: ${{ secrets.V3_GRAPHQL_DB_PASSWORD }}");
		expect(start).toContain("actual_manifest_sha");
		expect(start).toContain("plan_version");
		expect(start).toContain("3.2.5-r3");
		expect(start).toContain('jq \'.planVersion = "3.2.5"\'');
		expect(start).toContain("V3_GRAPHQL_RELEASE_PLAN=3.2.5-r3-normalized-to-3.2.5");
		expect(start).toContain('V3_RELEASE_MANIFEST_BASE64="$GATE_MANIFEST_BASE64"');
		expect(start).toContain('V3_RELEASE_MANIFEST_SHA256="$GATE_MANIFEST_SHA256"');
		expect(start).not.toContain("GRAPHQL_ENV");
		expect(start).not.toContain("git clean");
	});

	it.each(["postgres", "letletme_graphql_runtime"])(
		"rewrites a quoted %s pooler URL idempotently",
		(sourceRole) => {
			const directory = mkdtempSync(join(tmpdir(), "letletme-v3-graphql-env-"));
			try {
				const source = join(directory, ".env.deploy");
				const target = join(directory, ".env.deploy.next");
				const projectRef = "abcdefghijklmnopqrst";
				const password = "g".repeat(64);
				writeFileSync(
					source,
					[
						`DATABASE_URL="postgresql://${sourceRole}.${projectRef}:old@pooler.example.com:6543/postgres?pgbouncer=true"`,
						"REDIS_HOST=cache.example.com",
						"REDIS_PORT=6379",
						"GRAPHQL_AUTH_MODE=enforce",
					].join("\n")
				);
				writeFileSync(target, "");

				execFileSync("python3", ["-", source, target], {
					input: runtimeEnvPython(),
					env: { ...process.env, V3_GRAPHQL_DB_PASSWORD: password },
					encoding: "utf8",
				});

				const output = readFileSync(target, "utf8");
				expect(output).toContain(
					`DATABASE_URL=postgresql://letletme_graphql_runtime.${projectRef}:${password}@pooler.example.com:6543/postgres?pgbouncer=true`
				);
				expect(output).toContain("GRAPHQL_AUTH_MODE=enforce");
				expect(output.match(/^DATABASE_URL=/gm)).toHaveLength(1);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

	it("does not expose legacy cleanup as a GraphQL operation", () => {
		const operations = workflow.slice(
			workflow.indexOf("      operation:"),
			workflow.indexOf("      sha:")
		);
		expect(operations).not.toContain("cleanup");
		expect(workflow).not.toContain("APPROVE_V3_LEGACY_DROP");
	});
});
