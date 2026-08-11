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
		expect(workflow).not.toContain("schemaVersion");
	});
});
