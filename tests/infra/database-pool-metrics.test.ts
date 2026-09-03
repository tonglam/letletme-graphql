import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { metrics, registerDatabasePoolMetrics } from "../../src/infra/metrics";

describe("PostgreSQL pool observability", () => {
	it("exports bounded total, idle, and waiting gauges", async () => {
		registerDatabasePoolMetrics(() => ({ total: 5, idle: 3, waiting: 0 }));
		const rendered = await metrics.registry.metrics();
		expect(rendered).toContain('postgres_pool_clients{state="total"} 5');
		expect(rendered).toContain('postgres_pool_clients{state="idle"} 3');
		expect(rendered).toContain('postgres_pool_clients{state="waiting"} 0');
	});

	it("exports the monotonic wait-event metric used by the capacity gate", async () => {
		const rendered = await metrics.registry.metrics();
		const capacitySource = readFileSync(
			new URL("../../scripts/live-match-capacity.ts", import.meta.url),
			"utf8"
		);

		expect(rendered).toContain("postgres_pool_wait_events_total");
		expect(capacitySource).toContain("postgres_pool_wait_events_total");
		expect(capacitySource).toContain("dbPoolWaitEventsZero");
		expect(capacitySource).toContain('session.on("goaway"');
		expect(capacitySource).toContain("settings.maxConcurrentStreams");
		expect(capacitySource).toContain("settingsReceived");
		expect(capacitySource).toContain("advertisedMaxConcurrentStreams = 0");
		expect(capacitySource).toContain("maxConcurrentStreams: 0");
		expect(capacitySource).toContain("http2 peer reduced maxConcurrentStreams to zero");
		expect(capacitySource).toContain("http2CapacityTarget");
		expect(capacitySource).toContain("ensureHttp2Capacity");
		expect(capacitySource).toContain("remoteMaxConcurrentStreams");
		expect(capacitySource).toContain("beginNetworkRequest");
		expect(capacitySource).toContain("endNetworkRequest");
		expect(capacitySource).toContain('request.once("socket", observeSocket)');
		expect(capacitySource).toContain('socket.once("connect"');
		expect(capacitySource).toContain('tlsSocket.once("secureConnect"');
		expect(capacitySource).toContain("requestEnded");
		expect(capacitySource.indexOf('request.once("socket", observeSocket)')).toBeLessThan(
			capacitySource.indexOf("request.end(requestBody)")
		);
		expect(capacitySource).toContain("beginNetworkConcurrencyStage");
		expect(capacitySource).toContain("finishNetworkConcurrencyStage");
		expect(capacitySource).toContain("targetCoverageRatio");
		expect(capacitySource).toContain("NETWORK_CONCURRENCY_COVERAGE_REQUIREMENT");
		expect(capacitySource).toContain("observedDurationSeconds");
		expect(capacitySource).toContain("maxNetworkInFlight");
		expect(capacitySource).toContain("maxProcessingInFlight");
		expect(capacitySource).toContain("NETWORK_SPARE_WORKER_RATIO");
		expect(capacitySource).toContain("workerCountForStage");
		expect(capacitySource).toContain("spareWorkers");
		expect(capacitySource).toContain("http2CapacityWaiters");
		expect(capacitySource).toContain("totalRemaining");
		expect(capacitySource).toContain("waitForHttp2Capacity");
		expect(capacitySource).toContain("runtimeReadinessSamples");
		expect(capacitySource).toContain("validateCapacityHealthEndpoint");
		expect(capacitySource).toContain("validateCapacityHealthBinding");
		expect(capacitySource).toContain(
			"cross-origin capacity health URLs must use the load target or its api alias"
		);
		expect(capacitySource).toContain(
			"cross-origin capacity health URLs must be bound to the load route"
		);
		expect(capacitySource).toContain("isApiAliasHostname");
		expect(capacitySource).toContain("LIVE_MATCH_LOAD_DEPLOY_HEALTH_URL");
		expect(capacitySource).toContain("LIVE_MATCH_LOAD_READY_HEALTH_URL");
		expect(capacitySource).toContain("LetLetMe-LiveMatch-Capacity/");
		expect(capacitySource).toContain('"x-metrics-token": metricsToken');
		expect(capacitySource).toContain("LIVE_MATCH_LOAD_TRANSPORT must be cold, warm, or http1");
		expect(capacitySource).toContain('transport === "http1" ? http1KeepAliveAgent');
		expect(capacitySource).toContain("keepAlive: true");
		expect(capacitySource).toContain("http1 uses HTTP/1 keep-alive");
		expect(capacitySource).toContain('"/health/ready"');
		expect(capacitySource).toContain("readyHealthEndpoint.origin");
		expect(capacitySource).toContain("must not include credentials");
		expect(capacitySource).toContain("must not include a fragment");
		expect(capacitySource).toContain("must not include a query string");
		expect(capacitySource).toContain('redirect: "error"');
		expect(capacitySource).toContain("runtimeReadinessHealthy");
		expect(capacitySource).toContain("playerValue.price < 0");
		expect(capacitySource).toContain("metadataOnlyHead");
		expect(capacitySource).toContain("detailObservation");
		expect(capacitySource).toContain("expectedMetadataOnlyRootReasons");
		expect(capacitySource).toContain("expectedMetadataOnlyDetailReasons");
		expect(capacitySource).toContain('rootReasonCodes.includes("FINAL_CHECKPOINT_PENDING")');
		expect(capacitySource).toContain("hasExactReasonCodes");
		expect(capacitySource).toContain('typeof detailObservation === "string"');
		expect(capacitySource).toContain('"DETAIL_METADATA_ONLY"');
		expect(capacitySource).not.toContain("playerValue.price <= 0");
		expect(capacitySource).not.toContain("LIVE_MATCH_LOAD_REQUIRE_READY");
		expect(capacitySource.indexOf("reserveHttp2Stream(selected.session)")).toBeLessThan(
			capacitySource.indexOf("stream = session.request")
		);
		expect(capacitySource).not.toContain("report.maxInFlight");
		expect(capacitySource).not.toContain("gunzipSync");
		expect(capacitySource).not.toContain("brotliDecompressSync");
		expect(capacitySource).not.toContain("inflateSync");
	});

	it("keeps zero-valued fallback series available for the Ops required rules", async () => {
		const rendered = await metrics.registry.metrics();
		expect(rendered).toContain(
			'live_match_redis_roundtrips_total{view="HEAD",outcome="fallback"} 0'
		);
		expect(rendered).toContain(
			'live_match_fallback_total{component="desk",source="REDIS_PREVIOUS"} 0'
		);
	});

	it("fails closed when health overrides target an unrelated deployment", async () => {
		for (const [healthUrl, expectedError] of [
			[
				"https://unrelated.example/health/deploy",
				"cross-origin capacity health URLs must use the load target or its api alias",
			],
			[
				"https://letletme.top/other/health/deploy",
				"capacity health URLs must be bound to the load route",
			],
			[
				"https://api.letletme.top/api/other/health/deploy",
				"cross-origin capacity health URLs must be bound to the load route",
			],
			[
				"https://api.api.letletme.top/api/graphql/health/deploy",
				"cross-origin capacity health URLs must use the load target or its api alias",
			],
			[
				"https://api.letletme.top/api/graphql/health/deploy?",
				"capacity health URLs must not include a query string",
			],
			[
				"https://api.letletme.top:8443/api/graphql/health/deploy",
				"cross-origin capacity health URLs must preserve the load endpoint port",
			],
			[
				"https://api.letletme.top/api/graphql/health/deploy#",
				"capacity health URLs must not include a fragment",
			],
		] as const) {
			const child = Bun.spawn(["bun", "scripts/live-match-capacity.ts", "--mode=HEAD"], {
				cwd: process.cwd(),
				env: {
					...Bun.env,
					LIVE_MATCH_LOAD_URL: "https://letletme.top/api/graphql",
					LIVE_MATCH_GRAPHQL_SERVICE_TOKEN: "test-token",
					LIVE_MATCH_LOAD_DEPLOY_SHA: "a".repeat(40),
					LIVE_MATCH_LOAD_DEPLOY_HEALTH_URL: healthUrl,
					LIVE_MATCH_LOAD_READY_HEALTH_URL: "",
					LIVE_MATCH_LOAD_STAGES: "1",
				},
				stderr: "pipe",
				stdout: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);

			expect(exitCode).not.toBe(0);
			expect(stderr).toContain(expectedError);
		}
	});

	it("accepts a root-routed API health override before validating the next setting", async () => {
		const child = Bun.spawn(["bun", "scripts/live-match-capacity.ts", "--mode=HEAD"], {
			cwd: process.cwd(),
			env: {
				...Bun.env,
				LIVE_MATCH_LOAD_URL: "https://letletme.top/",
				LIVE_MATCH_GRAPHQL_SERVICE_TOKEN: "test-token",
				LIVE_MATCH_LOAD_DEPLOY_SHA: "a".repeat(40),
				LIVE_MATCH_LOAD_DEPLOY_HEALTH_URL: "https://api.letletme.top/health/deploy",
				LIVE_MATCH_LOAD_READY_HEALTH_URL: "ftp://api.letletme.top/health/ready",
				LIVE_MATCH_LOAD_STAGES: "1",
			},
			stderr: "pipe",
			stdout: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("capacity health URLs must use http or https");
		expect(stderr).not.toContain("capacity health URLs must be bound to the load route");
	});

	it("does not treat different loopback hostnames as the same health target", async () => {
		const child = Bun.spawn(
			["bun", "scripts/live-match-capacity.ts", "--mode=HEAD", "--transport=cold"],
			{
				cwd: process.cwd(),
				env: {
					...Bun.env,
					LIVE_MATCH_LOAD_URL: "http://127.0.0.1:4000/api/graphql",
					LIVE_MATCH_GRAPHQL_SERVICE_TOKEN: "test-token",
					LIVE_MATCH_LOAD_DEPLOY_SHA: "a".repeat(40),
					LIVE_MATCH_LOAD_DEPLOY_HEALTH_URL: "http://localhost:4000/api/graphql/health/deploy",
					LIVE_MATCH_LOAD_READY_HEALTH_URL: "",
					LIVE_MATCH_LOAD_STAGES: "1",
				},
				stderr: "pipe",
				stdout: "pipe",
			}
		);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain(
			"cross-origin capacity health URLs must use the load target or its api alias"
		);
	});

	it("accepts http1 keep-alive on loopback HTTP and rejects plaintext non-loopback", async () => {
		const invalid = Bun.spawn(
			["bun", "scripts/live-match-capacity.ts", "--mode=HEAD", "--transport=not-a-transport"],
			{
				cwd: process.cwd(),
				env: {
					...Bun.env,
					LIVE_MATCH_LOAD_URL: "http://127.0.0.1:4000/graphql",
					LIVE_MATCH_GRAPHQL_SERVICE_TOKEN: "test-token",
					LIVE_MATCH_LOAD_DEPLOY_SHA: "a".repeat(40),
					LIVE_MATCH_LOAD_STAGES: "1",
				},
				stderr: "pipe",
				stdout: "pipe",
			}
		);
		const [invalidExit, invalidStderr] = await Promise.all([
			invalid.exited,
			new Response(invalid.stderr).text(),
		]);
		expect(invalidExit).not.toBe(0);
		expect(invalidStderr).toContain("LIVE_MATCH_LOAD_TRANSPORT must be cold, warm, or http1");

		const remotePlaintext = Bun.spawn(
			["bun", "scripts/live-match-capacity.ts", "--mode=HEAD", "--transport=http1"],
			{
				cwd: process.cwd(),
				env: {
					...Bun.env,
					LIVE_MATCH_LOAD_URL: "http://example.com/graphql",
					LIVE_MATCH_GRAPHQL_SERVICE_TOKEN: "test-token",
					LIVE_MATCH_LOAD_DEPLOY_SHA: "a".repeat(40),
					LIVE_MATCH_LOAD_STAGES: "1",
				},
				stderr: "pipe",
				stdout: "pipe",
			}
		);
		const [plainExit, plainStderr] = await Promise.all([
			remotePlaintext.exited,
			new Response(remotePlaintext.stderr).text(),
		]);
		expect(plainExit).not.toBe(0);
		expect(plainStderr).toContain("plaintext capacity runs require a loopback endpoint");

		const acceptedHttp1 = Bun.spawn(
			["bun", "scripts/live-match-capacity.ts", "--mode=HEAD", "--transport=http1"],
			{
				cwd: process.cwd(),
				env: {
					...Bun.env,
					LIVE_MATCH_LOAD_URL: "http://127.0.0.1:4000/graphql",
					LIVE_MATCH_GRAPHQL_SERVICE_TOKEN: "test-token",
					LIVE_MATCH_LOAD_DEPLOY_SHA: "a".repeat(40),
					LIVE_MATCH_LOAD_READY_HEALTH_URL: "ftp://127.0.0.1:4000/health/ready",
					LIVE_MATCH_LOAD_STAGES: "1",
				},
				stderr: "pipe",
				stdout: "pipe",
			}
		);
		const [http1Exit, http1Stderr] = await Promise.all([
			acceptedHttp1.exited,
			new Response(acceptedHttp1.stderr).text(),
		]);
		expect(http1Exit).not.toBe(0);
		expect(http1Stderr).toContain("capacity health URLs must use http or https");
		expect(http1Stderr).not.toContain("LIVE_MATCH_LOAD_TRANSPORT must be cold, warm, or http1");
	});
});
