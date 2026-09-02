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
		expect(capacitySource).toContain("LIVE_MATCH_LOAD_DEPLOY_HEALTH_URL");
		expect(capacitySource).toContain("LIVE_MATCH_LOAD_READY_HEALTH_URL");
		expect(capacitySource).toContain('"/health/ready"');
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
});
