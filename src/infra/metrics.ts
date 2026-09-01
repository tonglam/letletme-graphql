import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

const registry = new Registry();

collectDefaultMetrics({ register: registry });

const httpRequestDurationSeconds = new Histogram({
	name: "http_request_duration_seconds",
	help: "Duration of HTTP requests in seconds",
	labelNames: ["method", "route", "status"] as const,
	buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.799, 0.8, 1, 1.9, 1.999, 2, 2.5, 5],
});

registry.registerMetric(httpRequestDurationSeconds);

const rateLimitStorageFailures = new Counter({
	name: "rate_limit_storage_failures_total",
	help: "Rate-limit storage failures by route scope and fallback mode",
	labelNames: ["scope", "mode"] as const,
});

const authTokenValidations = new Counter({
	name: "auth_token_validations_total",
	help: "Successful authentication token validations by token family",
	labelNames: ["family"] as const,
});

const graphqlIngressRequests = new Counter({
	name: "graphql_ingress_requests_total",
	help: "GraphQL requests by trusted ingress class",
	labelNames: ["class"] as const,
});

const graphqlRateLimitDecisions = new Counter({
	name: "graphql_rate_limit_decisions_total",
	help: "GraphQL rate-limit outcomes by limiter scope",
	labelNames: ["scope", "outcome"] as const,
});

const graphqlRateLimitV3Decisions = new Counter({
	name: "graphql_rate_limit_v3_decisions_total",
	help: "GraphQL rate-limit outcomes using controlled traffic, workload, and scope labels",
	labelNames: ["traffic_class", "workload", "scope", "outcome"] as const,
});

export const GRAPHQL_REQUEST_OUTCOME_LABELS = ["result"] as const;

const graphqlRequestOutcomes = new Counter({
	name: "graphql_request_outcomes_total",
	help: "GraphQL request outcomes using a controlled result label",
	labelNames: GRAPHQL_REQUEST_OUTCOME_LABELS,
});

const graphqlDeprecatedSchemaUsages = new Counter({
	name: "graphql_deprecated_schema_usages_total",
	help: "Executable GraphQL requests using a deprecated executable schema symbol",
	labelNames: ["symbol"] as const,
});

const livePublicationEventsTotal = new Counter({
	name: "live_publication_events_total",
	help: "Live publication contract events using a controlled reason label",
	labelNames: ["reason"] as const,
});

const cacheRepositoryEvents = new Counter({
	name: "cache_repository_events_total",
	help: "Cache source, fallback, malformed, negative-hit, and suppressed-write events",
	labelNames: ["domain", "event"] as const,
});

const entryLookupOutcomes = new Counter({
	name: "entry_lookup_outcomes_total",
	help: "Entry lookup outcomes by status, source, and persistence state",
	labelNames: ["status", "source", "persistence"] as const,
});

const entrySyncRequestsTotal = new Counter({
	name: "entry_sync_requests_total",
	help: "GraphQL to Data entry persistence enqueue outcomes",
	labelNames: ["kind", "outcome"] as const,
});

const playerDetailDataAvailability = new Counter({
	name: "player_detail_data_availability_total",
	help: "Player detail section authority states observed while serving requests",
	labelNames: ["section", "state"] as const,
});

const seasonAuthorityRefreshes = new Counter({
	name: "season_authority_refreshes_total",
	help: "Current-season authority refresh outcomes",
	labelNames: ["outcome", "reason"] as const,
});

const briefingPublicationReaderEvents = new Counter({
	name: "briefing_publication_reader_events_total",
	help: "Briefing publication reader fallback, corruption, repair, and Redis availability events",
	labelNames: ["event"] as const,
});

const playerStateProfiles = new Counter({
	name: "player_state_profiles_total",
	help: "Player State profiles by trend, confidence, provider mode, and current analysis status",
	labelNames: ["trend", "confidence", "provider_mode", "current_analysis_status"] as const,
});

const playerStateProviderStale = new Counter({
	name: "player_state_provider_stale_total",
	help: "Stale provider revisions observed while serving Player State profiles",
	labelNames: ["provider", "scope"] as const,
});

const playerStatsDeskFields = new Counter({
	name: "player_stats_desk_fields_total",
	help: "Player Stats desk field outcomes by field and status",
	labelNames: ["field", "status"] as const,
});

const livePointsDeliveryTotal = new Counter({
	name: "live_points_delivery_total",
	help: "Live Points V2 responses by delivery state and serving source",
	labelNames: ["state", "served_from"] as const,
});

const livePointsProjectionFailures = new Counter({
	name: "live_points_projection_failures_total",
	help: "Live Points V2 projection failures by reason",
	labelNames: ["reason"] as const,
});

const liveMatchReadDurationSeconds = new Histogram({
	name: "live_match_read_duration_seconds",
	help: "Live Matches V3 resolver read duration by view and serving source",
	labelNames: ["view", "source"] as const,
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 2],
});

const liveMatchPayloadBytes = new Histogram({
	name: "live_match_payload_bytes",
	help: "Live Matches V3 payload bytes by view and read stage",
	labelNames: ["view", "stage"] as const,
	buckets: [
		1024,
		4 * 1024,
		16 * 1024,
		30 * 1024,
		64 * 1024,
		90 * 1024,
		128 * 1024,
		256 * 1024,
		1024 * 1024,
	],
});

const liveMatchRedisRoundtripsTotal = new Counter({
	name: "live_match_redis_roundtrips_total",
	help: "Live Matches V3 Redis read round trips by view and outcome",
	labelNames: ["view", "outcome"] as const,
});

const liveMatchFallbackTotal = new Counter({
	name: "live_match_fallback_total",
	help: "Live Matches V3 fallback selections by component and source",
	labelNames: ["component", "source"] as const,
});

const liveMatchDeliveryTotal = new Counter({
	name: "live_match_delivery_total",
	help: "Live Matches V3 deliveries by view, state, and serving source",
	labelNames: ["view", "state", "served_from"] as const,
});

// Keep zero-valued fallback/roundtrip series visible before the first
// request. Ops treats these metric families as required, and an absent
// series must mean an instrumentation failure rather than a healthy zero.
const liveMatchViews = ["HEAD", "DESK", "FULL"] as const;
const liveMatchRedisOutcomes = ["none", "single", "fallback"] as const;
for (const view of liveMatchViews) {
	for (const outcome of liveMatchRedisOutcomes) {
		liveMatchRedisRoundtripsTotal.labels(view, outcome).inc(0);
	}
}

const liveMatchFallbackComponents = ["desk", "detail"] as const;
const liveMatchFallbackSources = ["REDIS_PREVIOUS", "PROCESS_LKG", "POSTGRES_CHECKPOINT"] as const;
for (const component of liveMatchFallbackComponents) {
	for (const source of liveMatchFallbackSources) {
		liveMatchFallbackTotal.labels(component, source).inc(0);
	}
}

const rateLimitTelemetryOverflows = new Counter({
	name: "rate_limit_telemetry_overflows_total",
	help: "Rate-limit aggregate telemetry records dropped because the bounded queue was full",
	labelNames: ["policy"] as const,
});

type DatabasePoolMetrics = {
	total: number;
	idle: number;
	waiting: number;
};

let readDatabasePoolMetrics = (): DatabasePoolMetrics => ({
	total: 0,
	idle: 0,
	waiting: 0,
});

const postgresPoolClients = new Gauge({
	name: "postgres_pool_clients",
	help: "PostgreSQL pool clients by state",
	labelNames: ["state"] as const,
	collect(): void {
		const snapshot = readDatabasePoolMetrics();
		this.labels("total").set(snapshot.total);
		this.labels("idle").set(snapshot.idle);
		this.labels("waiting").set(snapshot.waiting);
	},
});

export const postgresPoolWaitEvents = new Counter({
	name: "postgres_pool_wait_events_total",
	help: "PostgreSQL pool checkout requests that waited for a client",
});

registry.registerMetric(rateLimitStorageFailures);
registry.registerMetric(authTokenValidations);
registry.registerMetric(graphqlIngressRequests);
registry.registerMetric(graphqlRateLimitDecisions);
registry.registerMetric(graphqlRateLimitV3Decisions);
registry.registerMetric(graphqlRequestOutcomes);
registry.registerMetric(graphqlDeprecatedSchemaUsages);
registry.registerMetric(livePublicationEventsTotal);
registry.registerMetric(cacheRepositoryEvents);
registry.registerMetric(entryLookupOutcomes);
registry.registerMetric(entrySyncRequestsTotal);
registry.registerMetric(playerDetailDataAvailability);
registry.registerMetric(seasonAuthorityRefreshes);
registry.registerMetric(briefingPublicationReaderEvents);
registry.registerMetric(playerStateProfiles);
registry.registerMetric(playerStateProviderStale);
registry.registerMetric(playerStatsDeskFields);
registry.registerMetric(livePointsDeliveryTotal);
registry.registerMetric(livePointsProjectionFailures);
registry.registerMetric(liveMatchReadDurationSeconds);
registry.registerMetric(liveMatchPayloadBytes);
registry.registerMetric(liveMatchRedisRoundtripsTotal);
registry.registerMetric(liveMatchFallbackTotal);
registry.registerMetric(liveMatchDeliveryTotal);
registry.registerMetric(rateLimitTelemetryOverflows);
registry.registerMetric(postgresPoolClients);
registry.registerMetric(postgresPoolWaitEvents);

export const registerDatabasePoolMetrics = (provider: () => DatabasePoolMetrics): void => {
	readDatabasePoolMetrics = provider;
};

export const metrics = {
	registry,
	httpRequestDurationSeconds,
	rateLimitStorageFailures,
	authTokenValidations,
	graphqlIngressRequests,
	graphqlRateLimitDecisions,
	graphqlRateLimitV3Decisions,
	graphqlRequestOutcomes,
	graphqlDeprecatedSchemaUsages,
	livePublicationEventsTotal,
	cacheRepositoryEvents,
	entryLookupOutcomes,
	entrySyncRequestsTotal,
	playerDetailDataAvailability,
	seasonAuthorityRefreshes,
	briefingPublicationReaderEvents,
	playerStateProfiles,
	playerStateProviderStale,
	playerStatsDeskFields,
	livePointsDeliveryTotal,
	livePointsProjectionFailures,
	liveMatchReadDurationSeconds,
	liveMatchPayloadBytes,
	liveMatchRedisRoundtripsTotal,
	liveMatchFallbackTotal,
	liveMatchDeliveryTotal,
	rateLimitTelemetryOverflows,
	postgresPoolClients,
	postgresPoolWaitEvents,
};

export const metricsResponse = async (): Promise<Response> => {
	const body = await registry.metrics();
	return new Response(body, {
		headers: {
			"Content-Type": registry.contentType,
		},
	});
};
