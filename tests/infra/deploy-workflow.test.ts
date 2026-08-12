import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(".github/workflows/deploy.yml").text();

describe("production deployment workflow", () => {
	test("bootstraps a missing VPS checkout before resolving the exact main commit", () => {
		expect(workflow).toContain(
			'git clone https://github.com/tonglam/letletme-graphql.git "$VPS_WORKDIR"'
		);
		expect(
			workflow.indexOf("git clone https://github.com/tonglam/letletme-graphql.git")
		).toBeLessThan(workflow.indexOf("git fetch origin main"));
		expect(workflow).toContain('test "$(git rev-parse origin/main)" = "$DEPLOY_SHA"');
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

	test("requires both ingress rejection and authenticated business queries", () => {
		expect(workflow).toContain("test \"$anonymous_status\" = '401'");
		expect(workflow).toContain('"X-GraphQL-Service-Token": token');
		expect(workflow).toContain("query DeploymentSmoke");
		expect(workflow).toContain("query LiveDeploymentSmoke");
		expect(workflow).toContain("image_name=${IMAGE_REF%@*}");
		expect(workflow).toContain('--filter "reference=${image_name}:*"');
		expect(workflow).toContain("--filter dangling=true");
		expect(workflow).not.toContain("docker image prune");
		expect(workflow).not.toContain("schema" + "Version");
	});

	test("uses the complete GraphQL environment URL without password rewriting", () => {
		expect(workflow).toContain("GRAPHQL_ENV: ${{ secrets.GRAPHQL_ENV }}");
		expect(workflow).toContain('printf \'%s\' "$GRAPHQL_ENV" > "$next_env"');
		expect(workflow).toContain('username == "letletme_graphql_runtime"');
		expect(workflow).toContain("if not parsed.password:");
		expect(workflow).not.toContain("GRAPHQL_RUNTIME_DB_PASSWORD");
		expect(workflow).not.toContain("env_path.write_text");
		expect(workflow).not.toContain("urlunsplit");
	});

	test("emits structured timing for every remote deployment phase", () => {
		for (const stage of [
			"checkout",
			"envValidate",
			"pull",
			"preflight",
			"replace",
			"serviceReady",
			"smoke",
			"finalize",
		]) {
			expect(workflow).toContain(`start_stage ${stage}`);
		}
		expect(workflow).toContain('"event":"deploy_stage_timing"');
		expect(workflow).toContain('"outcome":"failed"');
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
