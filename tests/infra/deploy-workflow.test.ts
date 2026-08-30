import { describe, expect, test } from "bun:test";
import { validateGraphQLRequestLimits } from "../../src/graphql/limits";

const workflow = await Bun.file(".github/workflows/deploy.yml").text();
const monitorWorkflow = await Bun.file(".github/workflows/rate-limit-monitor.yml").text();
const deployScript = await Bun.file("scripts/deploy-remote.sh").text();
const dockerfile = await Bun.file("Dockerfile").text();
const compose = await Bun.file("docker-compose.yml").text();
const p0Probe = await Bun.file("scripts/rate-limit-p0-probe.ts").text();

describe("production deployment workflow", () => {
	test("resolves and checks the exact protected main head before deployment", () => {
		expect(workflow).toContain(
			"actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$main_sha"
		);
		expect(workflow).toContain('.status == "completed"');
		expect(workflow).toContain('.conclusion == "success"');
		expect(workflow).toContain("No completed successful ci.yml push run found for exact main SHA");
		expect(workflow).toContain("ref: ${{ steps.target.outputs.sha }}");
		expect(deployScript).toContain("git fetch origin main");
		expect(deployScript).toContain('test "$(git rev-parse origin/main)" = "$DEPLOY_SHA"');
		expect(deployScript).toContain('test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"');
	});

	test("uses pinned OpenSSH host identity and never key-scans at runtime", () => {
		for (const source of [workflow, monitorWorkflow]) {
			expect(source).toContain("StrictHostKeyChecking=yes");
			expect(source).toContain("IdentitiesOnly=yes");
			expect(source).toContain("VPS_SSH_KNOWN_HOSTS");
			expect(source).toContain("VPS_SSH_FINGERPRINT");
			expect(source).not.toContain("ssh-keyscan");
		}
		expect(workflow).toContain("ssh-keygen -lf");
		expect(workflow).toContain('test "$fingerprints" = "$VPS_SSH_FINGERPRINT"');
		expect(workflow).toContain("wc -l");
	});

	test("deploys only to the inactive blue/green slot and leaves the active slot running", () => {
		expect(deployScript).toContain("BLUE_PROJECT=${BLUE_PROJECT:-letletme_graphql_blue}");
		expect(deployScript).toContain("GREEN_PROJECT=${GREEN_PROJECT:-letletme_graphql_green}");
		expect(deployScript).toContain("inactive_slot=green");
		expect(deployScript).toContain("compose up -d --no-deps --no-build --force-recreate graphql");
		expect(deployScript).not.toContain("docker compose stop");
		expect(deployScript).not.toContain("docker compose rm");
		expect(deployScript).toContain('sudo -n "$SWITCH_HELPER" "$inactive_slot"');
		expect(deployScript).toContain('sudo -n "$SWITCH_HELPER" "$old_slot"');
		expect(deployScript).toContain("ACTIVE_SLOT_FILE");
	});

	test("holds the platform-wide deployment lock before changing checkout or slots", () => {
		const lockAt = deployScript.indexOf('exec 9<>"$DEPLOY_LOCK_PATH"');
		expect(deployScript).toContain(
			"DEPLOY_LOCK_PATH=${DEPLOY_LOCK_PATH:-/var/lock/letletme-platform-deploy.lock}"
		);
		expect(deployScript).toContain("flock -w 300 9");
		expect(lockAt).toBeGreaterThan(-1);
		expect(lockAt).toBeLessThan(deployScript.indexOf("git fetch origin main"));
		expect(lockAt).toBeLessThan(deployScript.indexOf('sudo -n "$SWITCH_HELPER" "$inactive_slot"'));
	});

	test("creates a fresh work-directory parent before changing into it", () => {
		const createParentAt = deployScript.indexOf('mkdir -p -- "$(dirname "$VPS_WORKDIR")"');
		const changeParentAt = deployScript.indexOf('cd "$(dirname "$VPS_WORKDIR")"');
		expect(createParentAt).toBeGreaterThan(-1);
		expect(createParentAt).toBeLessThan(changeParentAt);
		expect(changeParentAt).toBeLessThan(deployScript.indexOf("git clone"));
	});

	test("requires candidate readiness, image digest, revision label, ingress and contract probes", () => {
		expect(dockerfile).toContain("COPY --chown=bun:bun scripts/lib ./scripts/lib");
		expect(deployScript).toContain("/health/ready");
		expect(deployScript).toContain('.status == "ok" and .deploySha == $deploySha');
		expect(deployScript).toContain("docker inspect --format '{{.Config.Image}}'");
		expect(deployScript).toContain("org.opencontainers.image.revision");
		expect(deployScript).toContain('test "$anonymous_status" = 401');
		expect(deployScript).toContain("entryLookup(id: -1)");
		expect(deployScript).toContain("entry { id }");
		expect(deployScript).toContain('status !== "INVALID_ID"');
		expect(deployScript).toContain("priceChangeBoard");
		expect(deployScript).toContain('status === "READY"');
		expect(deployScript).toContain("candidate_contract_passed");
		expect(deployScript).toContain("PUBLIC_GRAPHQL_URL");
		expect(deployScript).toContain("public_contract_passed");
	});

	test("isolates streamed deployment stdin from container probes", () => {
		expect(deployScript).toContain("compose_exec() {");
		expect(deployScript).toContain('compose exec -T "$@" < /dev/null');
		expect(deployScript.match(/^compose_exec(?: |\n)/gm) ?? []).toHaveLength(3);
	});

	test("allowlists exact public GraphQL routes before switching or forwarding credentials", () => {
		const validationAt = deployScript.indexOf('const expectedOrigin = "https://api.letletme.top";');
		const switchAt = deployScript.indexOf('sudo -n "$SWITCH_HELPER" "$inactive_slot"');
		const publicTokenRequestAt = deployScript.indexOf(
			'compose_exec -e PUBLIC_GRAPHQL_URL="$PUBLIC_GRAPHQL_URL" graphql bun -e'
		);
		expect(validationAt).toBeGreaterThan(-1);
		expect(deployScript).toContain("parsed.pathname !== expectedPathname");
		expect(deployScript).toContain(
			"parsed.username || parsed.password || parsed.search || parsed.hash"
		);
		expect(deployScript).toContain('"/api/graphql/health/ready"');
		expect(deployScript).toContain('"/api/graphql"');
		expect(validationAt).toBeLessThan(switchAt);
		expect(validationAt).toBeLessThan(publicTokenRequestAt);
	});

	test("treats a non-ready price board as business degradation, not a container rollback", () => {
		const readyCheck = deployScript.indexOf('board?.status === "READY"');
		const switchAt = deployScript.indexOf('sudo -n "$SWITCH_HELPER" "$inactive_slot"');
		expect(readyCheck).toBeGreaterThan(-1);
		expect(switchAt).toBeGreaterThan(readyCheck);
		expect(deployScript).not.toContain('priceChangeStatus === "UNAVAILABLE"\n    throw');
	});

	test("rolls back the slot switch when public verification fails", () => {
		expect(deployScript).toContain("rollback_switch()");
		expect(deployScript).toContain("public GraphQL health did not converge");
		expect(deployScript).toContain('sudo -n "$SWITCH_HELPER" "$old_slot"');
		expect(deployScript).not.toContain('sudo -n "$SWITCH_HELPER" "$old_slot" || true');
		expect(deployScript).toContain('!= "$old_slot"');
		expect(deployScript).toContain("rollback could not be verified");
		expect(deployScript).toContain("manifest=$(mktemp");
		expect(deployScript).toContain("oldSlot:$oldSlot,newSlot:$newSlot");
		expect(deployScript).toContain("Public GraphQL contract failed");
		expect(deployScript).toContain("PUBLIC_HEALTH_ATTEMPTS=${PUBLIC_HEALTH_ATTEMPTS:-15}");
		expect(deployScript).toContain("public_health_ready=false");
		expect(deployScript).toContain('old_slot_deploy_sha=""');
		expect(deployScript).toContain("old_slot_deploy_sha");
		expect(deployScript).toContain("active GraphQL slot has an invalid deployment revision label");
		expect(deployScript).toContain('for attempt in $(seq 1 "$PUBLIC_HEALTH_ATTEMPTS")');
		expect(deployScript).toContain('sleep "$PUBLIC_HEALTH_DELAY_SECONDS"');
		expect(deployScript).toContain(
			'if ! public_health=$(curl --fail --silent --show-error --max-time 5 "$public_health_url"); then'
		);
		expect(deployScript).toContain(
			"public GraphQL health probe failed after switching to $inactive_slot; rolling back"
		);
		expect(deployScript).toContain(
			"public GraphQL health returned an unexpected deployment identity; rolling back"
		);
		expect(deployScript).toContain('elif (has("deploySha") | not) then {kind:"legacy"}');
		expect(deployScript).toContain('{kind:"identity",sha:.deploySha}');
		expect(deployScript).toContain('test("^[0-9a-f]{40}$")');
		expect(deployScript).toContain('case "$public_health_kind" in');
		expect(deployScript).toContain('[ "$public_identity" = "$old_slot_deploy_sha" ]');
		expect(deployScript).toContain(
			"public GraphQL health did not converge to $DEPLOY_SHA after ${PUBLIC_HEALTH_ATTEMPTS} attempts"
		);
		expect(deployScript).not.toContain("neither the new nor previous revision");
		expect(deployScript.indexOf("switched=true")).toBeLessThan(
			deployScript.indexOf('sudo -n "$SWITCH_HELPER" "$inactive_slot"')
		);
		expect(deployScript.lastIndexOf("switched=false")).toBeGreaterThan(
			deployScript.indexOf('mv "$manifest" "$RELEASE_MANIFEST_DIR/$DEPLOY_SHA.json"')
		);
	});

	test("protects the public token probe and candidate lifecycle on interruption", () => {
		expect(deployScript).toContain('redirect: "error"');
		expect(deployScript).toContain(
			'const response = await fetch("http://127.0.0.1:4000/graphql", {'
		);
		expect(deployScript).toContain("--max-time 5");
		expect(deployScript).toContain("candidate_started=true");
		expect(deployScript).toContain("rollback_verified=false");
		expect(deployScript).toContain(
			"preserving candidate slot because active-slot rollback is unverified"
		);
		expect(deployScript).toContain("compose down --remove-orphans >/dev/null 2>&1 || true");
		expect(deployScript).toContain("trap 'rollback_on_signal 129' HUP");
		expect(deployScript).toContain("trap 'rollback_on_signal 130' INT");
		expect(deployScript).toContain("trap 'rollback_on_signal 143' TERM");
		expect(deployScript).toContain("promotion_committed=true");
	});

	test("uploads deployment secrets and runs cleanup inside one remote shell", () => {
		const deployStep = workflow.slice(
			workflow.indexOf("- name: Deploy candidate to inactive slot"),
			workflow.indexOf("- name: Promote verified digest to latest")
		);
		expect(deployStep).toContain("remote_env=$(mktemp /tmp/letletme-graphql-env.XXXXXX)");
		expect(deployStep).toContain("remote_token=$(mktemp /tmp/letletme-graphql-token.XXXXXX)");
		expect(deployStep).toContain("trap cleanup_remote EXIT");
		expect(deployStep).toContain('base64 --decode > "$remote_env"; then');
		expect(deployStep).toContain('base64 --decode > "$remote_token"; then');
		expect(deployStep).toContain("GraphQL environment payload failed remote base64 decode");
		expect(deployStep).toContain("GHCR token payload failed remote base64 decode");
		expect(deployStep).not.toContain("remote_env=$(ssh");
		expect(deployStep).not.toContain("cleanup_remote() {\n            set +e\n            ssh");
	});

	test("retires the implicit legacy project only before canonical blue reuses port 4000", () => {
		const retireAt = deployScript.indexOf("retire_legacy_bootstrap_before_blue");
		const candidateUpAt = deployScript.indexOf(
			"compose up -d --no-deps --no-build --force-recreate graphql"
		);
		expect(deployScript).toContain("LEGACY_PROJECT=${LEGACY_PROJECT:-letletme_graphql}");
		expect(deployScript).toContain('[ "$active_slot" != green ]');
		expect(deployScript).toContain('[ "$inactive_slot" != blue ]');
		expect(deployScript).toContain('--filter "label=com.docker.compose.project=$LEGACY_PROJECT"');
		expect(deployScript).toContain("docker container rm --force");
		expect(retireAt).toBeGreaterThan(deployScript.indexOf("compose pull graphql"));
		expect(retireAt).toBeLessThan(candidateUpAt);
	});

	test("scans the immutable digest and promotes latest only after deployment", () => {
		const scanAt = workflow.indexOf("Scan immutable image before deployment");
		const deployAt = workflow.indexOf("Deploy candidate to inactive slot");
		const promoteAt = workflow.indexOf("Promote verified digest to latest");
		expect(scanAt).toBeGreaterThan(-1);
		expect(deployAt).toBeGreaterThan(scanAt);
		expect(promoteAt).toBeGreaterThan(deployAt);
		expect(workflow).toContain("image-ref: ${{ steps.image.outputs.image_ref }}");
		expect(workflow).toContain("docker buildx imagetools create --tag");
		expect(workflow).toContain("severity: HIGH,CRITICAL");
		expect(workflow.slice(0, promoteAt)).not.toContain("IMAGE_NAME}:latest");
	});

	test("prunes only superseded repository images after the release manifest is durable", () => {
		const manifestAt = deployScript.indexOf(
			'mv "$manifest" "$RELEASE_MANIFEST_DIR/$DEPLOY_SHA.json"'
		);
		const pruneAt = deployScript.indexOf("prune_superseded_repository_images");
		expect(pruneAt).toBeGreaterThan(manifestAt);
		expect(deployScript).toContain("image_repository=${IMAGE_REF%@sha256:*}");
		expect(deployScript).toContain("candidate_image_id=$(docker inspect");
		expect(deployScript).toContain('image_id" = "$active_image_id');
		expect(deployScript).toContain('docker image rm "$image_id"');
		expect(deployScript).not.toContain("docker image prune");
	});

	test("isolates and removes the temporary Docker credential store", () => {
		expect(deployScript).toContain(
			'docker_config_dir=$(mktemp -d "$VPS_WORKDIR/.docker-config.XXXXXX")'
		);
		expect(deployScript).toContain('export DOCKER_CONFIG="$docker_config_dir"');
		expect(deployScript).toContain('rm -rf -- "$docker_config_dir"');
		expect(deployScript).toContain("trap cleanup_sensitive_files EXIT");
		expect(deployScript.indexOf("export DOCKER_CONFIG")).toBeLessThan(
			deployScript.indexOf("docker login ghcr.io")
		);
	});

	test("validates secret payloads before and during the remote transfer", () => {
		expect(workflow).toContain(
			'payload_dir=$(mktemp -d "$RUNNER_TEMP/letletme-graphql-payload.XXXXXX")'
		);
		expect(workflow).toContain(
			'base64 --wrap=0 < "$payload_dir/env.expected" > "$payload_dir/env.b64"'
		);
		expect(workflow).toContain(
			'base64 --wrap=0 < "$payload_dir/token.expected" > "$payload_dir/token.b64"'
		);
		expect(workflow).toContain(
			"env_sha=$(sha256sum \"$payload_dir/env.expected\" | awk '{print $1}')"
		);
		expect(workflow).toContain(
			"token_sha=$(sha256sum \"$payload_dir/token.expected\" | awk '{print $1}')"
		);
		expect(workflow).toContain('cmp -s "$payload_dir/env.expected" "$payload_dir/env.decoded"');
		expect(workflow).toContain('cmp -s "$payload_dir/token.expected" "$payload_dir/token.decoded"');
		expect(workflow).toContain(
			"printf 'if ! printf %%s %s | base64 --decode > \"$remote_env\"; then\\n'"
		);
		expect(workflow).toContain(
			"printf 'if ! printf %%s %s | base64 --decode > \"$remote_token\"; then\\n'"
		);
		expect(workflow).toContain("verify_payload() {");
		expect(workflow).toContain("printf 'verify_payload GRAPHQL_ENV \"$remote_env\" %s %s\\n'");
		expect(workflow).toContain("printf 'verify_payload GHCR_TOKEN \"$remote_token\" %s %s\\n'");
		expect(workflow).toContain("payload changed during remote transport");
		expect(workflow).toContain("GraphQL environment payload failed remote base64 decode");
		expect(workflow).toContain("GHCR token payload failed remote base64 decode");
		expect(workflow).not.toContain("base64 | tr -d '\\n'");
		expect(workflow).not.toContain("REMOTE_WRAPPER");
	});

	test("binds image and container identity to the exact commit", () => {
		expect(dockerfile).toContain("ARG VCS_REVISION=unknown");
		expect(dockerfile).toContain("ENV DEPLOY_SHA=${VCS_REVISION}");
		expect(dockerfile).toContain('org.opencontainers.image.revision="${VCS_REVISION}"');
		expect(workflow).toContain('--build-arg "VCS_REVISION=${{ steps.target.outputs.sha }}"');
		expect(deployScript).toContain('index .Config.Labels "org.opencontainers.image.revision"');
	});

	test("inherits the active slot rate-limit mode when rollout is preserved", () => {
		expect(deployScript).toContain('active_env="$VPS_WORKDIR/.env.deploy.$active_slot"');
		expect(deployScript).toContain("active_rate_limit_mode=shadow-v4");
		expect(deployScript).toContain('replace_rate_limit_mode "$active_rate_limit_mode"');
		expect(deployScript).toContain("invalid or duplicate GRAPHQL_RATE_LIMIT_MODE");
		expect(deployScript).toContain('tail -c 1 "$candidate_env_next"');
		expect(deployScript.indexOf('tail -c 1 "$candidate_env_next"')).toBeLessThan(
			deployScript.indexOf("printf 'GRAPHQL_RATE_LIMIT_MODE=%s\\n'")
		);
	});

	test("requires the slot helper to persist an active-slot authority file", () => {
		expect(deployScript).toContain('if [ ! -f "$ACTIVE_SLOT_FILE" ] ||');
	});

	test("anchors benchmark output validation to the script repository", async () => {
		const benchmark = await Bun.file("scripts/benchmark-queries.ts").text();
		expect(benchmark).toContain('resolve(import.meta.dir, "..")');
		expect(benchmark).not.toContain("resolve(process.cwd())");
		expect(benchmark).toContain("query EntryLookup($id: Int!) { entryLookup(id: $id)");
		expect(benchmark).toContain("entry { id entryName }");
	});

	test("keeps compose ports and readiness checks slot-aware", () => {
		expect(compose).toContain("127.0.0.1:${GRAPHQL_PORT:-4000}:4000");
		expect(compose).toContain("/health/hot");
		expect(deployScript).toContain("candidate_port=4002");
		expect(deployScript).toContain("candidate_port=4000");
		expect(monitorWorkflow).toContain("project=letletme_graphql_blue");
		expect(monitorWorkflow).toContain("project=letletme_graphql_green");
	});

	test("attaches both slots to the shared primary Redis network", () => {
		expect(compose).toContain("- graphql_shared");
		// The shared network is also the primary Redis egress path. An implicit
		// per-slot default network can win Docker's default route and make a
		// freshly started candidate unable to reach Redis while the active slot
		// remains healthy.
		expect(compose).not.toContain("      - default\n");
		expect(compose).toContain("graphql_shared:");
		expect(compose).toContain("external: true");
		expect(compose).toContain("name: ${GRAPHQL_SHARED_NETWORK:-letletme_graphql_default}");
	});

	test("does not retain retired controls or floating/stop-first deployment paths", () => {
		for (const source of [workflow, deployScript, dockerfile, compose]) {
			expect(source).not.toContain("MY_FPL_SNAPSHOT_READ");
			expect(source).not.toContain("apk upgrade");
		}
		expect(workflow).not.toContain("appleboy/ssh-action");
		expect(workflow).not.toContain("docker compose stop");
		expect(deployScript).not.toContain("grep -nE");
		expect(deployScript).not.toContain("ROLLOUT_STATE");
	});

	test("keeps the deterministic P0 probe bounded and observable", () => {
		const query = /const query = `([\s\S]*?)`;/u.exec(p0Probe)?.[1];
		expect(query).toBeTruthy();
		expect(validateGraphQLRequestLimits({ query })).toMatchObject({
			ok: true,
			// currentEventInfo is a bounded public root and keeps its effective
			// five-unit floor even when mixed with the ordinary events root.
			rateLimitCostUnits: 6,
		});
		expect(p0Probe).toContain('P0_PROBE_REQUESTS ?? "700"');
		expect(p0Probe).toContain("unexpected");
	});
});
