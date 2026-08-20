import { describe, expect, test } from "bun:test";
import { validateGraphQLRequestLimits } from "../../src/graphql/limits";

const workflow = await Bun.file(".github/workflows/deploy.yml").text();
const dockerfile = await Bun.file("Dockerfile").text();
const p0Probe = await Bun.file("scripts/rate-limit-p0-probe.ts").text();

describe("production deployment workflow", () => {
	test("bootstraps a missing VPS checkout before resolving the exact main commit", () => {
		expect(workflow).toContain(
			'git clone https://github.com/tonglam/letletme-graphql.git "$VPS_WORKDIR"'
		);
		expect(
			workflow.indexOf("git clone https://github.com/tonglam/letletme-graphql.git")
		).toBeLessThan(workflow.indexOf("git fetch origin main"));
		expect(workflow).toContain('test "$(git rev-parse origin/main)" = "$DEPLOY_SHA"');
		expect(workflow).not.toContain("letletme-vps-ops");
		expect(workflow).not.toContain("flock -w 300 9");
		expect(workflow).not.toContain("/usr/local/libexec/vps-maintenance");
	});

	test("manual deploys require a successful exact-head CI push run", () => {
		expect(workflow).toContain("actions: read");
		expect(workflow).toContain(
			"actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$main_sha"
		);
		expect(workflow).toContain('.status == "completed"');
		expect(workflow).toContain('.conclusion == "success"');
		expect(workflow).toContain("No completed successful ci.yml push run found for exact main SHA");
		expect(workflow.indexOf("No completed successful ci.yml push run found")).toBeLessThan(
			workflow.indexOf("Checkout protected main commit")
		);
	});

	test("arms rollback before replacing the running container", () => {
		const armedAt = workflow.indexOf("rollback_armed=true");
		const stopAt = workflow.indexOf("docker compose stop -t 30 graphql");
		const disarmedAt = workflow.lastIndexOf("rollback_armed=false");

		expect(workflow).toContain("rollback_graphql_on_exit");
		expect(armedAt).toBeGreaterThan(-1);
		expect(stopAt).toBeGreaterThan(armedAt);
		expect(disarmedAt).toBeGreaterThan(stopAt);
		expect(workflow).toContain("docker compose up \\");
		expect(workflow).toContain("-d --no-deps --no-build --force-recreate graphql");
		expect(workflow).toContain("$HOME/.letletme-graphql-previous-image");
		expect(workflow).not.toContain("/home/workspace/.letletme-graphql-previous-image");
	});

	test("checks both Redis clients with the candidate environment before stopping production", () => {
		const redisPreflightAt = workflow.indexOf("start_stage redisPreflight");
		const redisCheckAt = workflow.indexOf("bun run redis:check");
		const rollbackAt = workflow.indexOf("rollback_armed=true");
		const stopAt = workflow.indexOf("docker compose stop -t 30 graphql");

		expect(workflow).toContain("docker compose run --rm -T --no-deps graphql bun run redis:check");
		expect(redisPreflightAt).toBeGreaterThan(-1);
		expect(redisCheckAt).toBeGreaterThan(redisPreflightAt);
		expect(rollbackAt).toBeGreaterThan(redisCheckAt);
		expect(stopAt).toBeGreaterThan(redisCheckAt);
		expect(dockerfile).toContain(
			"COPY --chown=bun:bun scripts/check-redis-connectivity.ts ./scripts/check-redis-connectivity.ts"
		);
	});

	test("requires both ingress rejection and authenticated business queries", () => {
		expect(workflow).toContain("test \"$anonymous_status\" = '401'");
		expect(workflow).toContain('"X-GraphQL-Service-Token": token');
		expect(workflow).toContain("query DeploymentSmoke");
		expect(workflow).toContain("query LiveDeploymentSmoke");
		expect(workflow).toContain("liveContext");
		expect(workflow).not.toContain("liveSnapshot(eventId: $eventId)");
		expect(workflow).toContain("image_name=${IMAGE_REF%@*}");
		expect(workflow).toContain('--filter "reference=${image_name}:*"');
		expect(workflow).toContain("--filter dangling=true");
		expect(workflow).toContain("docker image ls --digests");
		expect(workflow).toContain("previous_image");
		expect(workflow).toContain('docker image rm "$digest_ref"');
		expect(workflow).not.toContain("docker image prune");
		expect(workflow).not.toContain("letletme-vps-ops");
		expect(workflow).not.toContain("flock -w 300 9");
		expect(workflow).not.toContain("/usr/local/libexec/vps-maintenance");
		expect(workflow).not.toContain("schema" + "Version");
	});

	test("scans the immutable digest before promoting latest", () => {
		const buildAt = workflow.indexOf("Build and push immutable image");
		const scanAt = workflow.indexOf("Scan immutable image before promotion");
		const promoteAt = workflow.indexOf("Promote scanned digest to latest");
		expect(buildAt).toBeGreaterThan(-1);
		expect(scanAt).toBeGreaterThan(buildAt);
		expect(promoteAt).toBeGreaterThan(scanAt);
		expect(workflow.slice(buildAt, scanAt)).not.toContain('--tag "${IMAGE_NAME}:latest"');
		expect(workflow).toContain("image-ref: ${{ steps.image.outputs.image_ref }}");
		expect(workflow).toContain('docker buildx imagetools create --tag "${IMAGE_NAME}:latest"');
		expect(workflow).toContain("severity: HIGH,CRITICAL");
	});

	test("uses the complete GraphQL environment URL without password rewriting", () => {
		expect(workflow).toContain("GRAPHQL_ENV: ${{ secrets.GRAPHQL_ENV }}");
		expect(workflow).toContain('printf \'%s\' "$GRAPHQL_ENV" > "$next_env"');
		expect(workflow).toContain('username != "letletme_graphql_runtime"');
		expect(workflow).toContain("pooler\\.supabase\\.com");
		expect(workflow).toContain("letletme_graphql_runtime\\.[^.]+");
		expect(workflow).toContain("if not parsed.password:");
		expect(workflow).not.toContain("GRAPHQL_RUNTIME_DB_PASSWORD");
		expect(workflow).toContain('"GRAPHQL_RATE_LIMIT_MODE": mode');
		expect(workflow).toContain('"GRAPHQL_BROWSER_INGRESS_RATE_LIMIT": browser');
		expect(workflow).not.toContain("urlunsplit");
	});

	test("persists explicit rate-limit rollout state only after a successful replacement", () => {
		expect(workflow).toContain("p0-legacy");
		expect(workflow).toContain("shadow-v3");
		expect(workflow).toContain("enforce-v3-restored-compat");
		expect(workflow).toContain("$HOME/.letletme-graphql-rate-limit-rollout");
		expect(workflow).toContain("$HOME/.letletme-graphql-rollbacks");
		expect(workflow).toContain("metrics.prom");
		expect(workflow).toContain("command_timeout: 45m");
		expect(workflow).not.toMatch(/\+\s{2,}(?:>|docker|--arg|['{])/);
		expect(workflow).toContain("start_stage p0Observe");
		expect(workflow).toContain("scripts/rate_limit_p0_guard.py");
		expect(workflow).toContain("for sample in $(seq 1 60)");
		expect(workflow).toContain("P0_PROBE_REQUESTS=700");
		expect(workflow).toContain(".total == 700 and .rateLimited > 0");
		expect(workflow).toContain("after_429 * 2");
		expect(workflow.indexOf("start_stage p0Observe")).toBeLessThan(
			workflow.indexOf("start_stage finalize")
		);
		expect(workflow.indexOf('mv "$next_env" .env.deploy')).toBeLessThan(
			workflow.indexOf("printf '%s\\n' \"$persist_rate_limit_rollout\"")
		);
	});

	test("uses a deterministic P0 probe that crosses both changed legacy buckets", () => {
		const query = /const query = `([\s\S]*?)`;/u.exec(p0Probe)?.[1];
		expect(query).toBeTruthy();
		expect(validateGraphQLRequestLimits({ query })).toMatchObject({
			ok: true,
			rateLimitCostUnits: 2,
		});
		expect(p0Probe).toContain('P0_PROBE_REQUESTS ?? "700"');
	});

	test("binds P0 backup evidence to the running image instead of the checkout", () => {
		expect(workflow).toContain("$HOME/.letletme-graphql-current-deployment.json");
		expect(workflow).toContain('[ "$state_image" = "$old_image" ]');
		expect(workflow).toContain("P0 requires a persisted SHA bound to the running GraphQL image");
		expect(workflow).toContain('--arg deploySha "$running_deploy_sha"');
		expect(workflow).not.toContain('--arg deploySha "$previous_deploy_sha"');
		expect(workflow.indexOf('mv "$deployment_state_next" "$deployment_state"')).toBeLessThan(
			workflow.lastIndexOf("deployment_committed=true")
		);
	});

	test("emits structured timing for every remote deployment phase", () => {
		for (const stage of [
			"checkout",
			"envValidate",
			"pull",
			"preflight",
			"redisPreflight",
			"replace",
			"serviceReady",
			"smoke",
			"finalize",
		]) {
			expect(workflow).toContain(`start_stage ${stage}`);
		}
		expect(workflow).toContain('"event":"deploy_stage_timing"');
		expect(workflow).toContain('"outcome":"failed"');
		expect(workflow).toContain("date +%s%3N");
		expect(workflow.indexOf("trap fail_without_rollback_on_exit EXIT")).toBeLessThan(
			workflow.indexOf("start_stage checkout")
		);
		expect(workflow.indexOf("trap rollback_graphql_on_exit EXIT")).toBeGreaterThan(
			workflow.indexOf("start_stage preflight")
		);
		expect(workflow).not.toMatch(/if \[ .*deployment_started.*\]; then\s*fi/);
	});

	test("does not hardcode retired generation-prefixed migration filenames", () => {
		const generationPrefix = "v";
		expect(workflow).not.toMatch(
			new RegExp(`--through\\s+\\d{4}_create_${generationPrefix}[0-9]+_`)
		);
		expect(workflow).not.toMatch(
			new RegExp(`--through\\s+\\d{4}_prepare_${generationPrefix}[0-9]+_`)
		);
		expect(workflow).not.toMatch(
			new RegExp(`--through\\s+\\d{4}_activate_${generationPrefix}[0-9]+_`)
		);
		expect(workflow).not.toMatch(
			new RegExp(`--through\\s+\\d{4}_freeze_${generationPrefix}[0-9]+_`)
		);
	});
});
