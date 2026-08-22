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

const cacheRepositoryEvents = new Counter({
	name: "cache_repository_events_total",
	help: "Cache source, fallback, malformed, negative-hit, and suppressed-write events",
	labelNames: ["domain", "event"] as const,
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

const managerLiveScoreSourceTotal = new Counter({
	name: "manager_live_score_source_total",
	help: "Official manager live score rows by source",
	labelNames: ["source"] as const,
});

const managerLiveScoreAgeSeconds = new Gauge({
	name: "manager_live_score_age_seconds",
	help: "Age of the most recently served manager live score rows",
	labelNames: ["source"] as const,
});

const managerLiveScoreReconciliationTotal = new Counter({
	name: "manager_live_score_reconciliation_total",
	help: "Manager live headline/detail reconciliation outcomes",
	labelNames: ["outcome"] as const,
});

const managerLiveUpstreamRequestsTotal = new Counter({
	name: "manager_live_upstream_requests_total",
	help: "GraphQL to Data manager-live upstream request outcomes",
	labelNames: ["outcome"] as const,
});

const managerLiveUpstreamLatencySeconds = new Histogram({
	name: "manager_live_upstream_latency_seconds",
	help: "Latency of GraphQL to Data manager-live upstream requests",
	buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
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

registry.registerMetric(rateLimitStorageFailures);
registry.registerMetric(authTokenValidations);
registry.registerMetric(graphqlIngressRequests);
registry.registerMetric(graphqlRateLimitDecisions);
registry.registerMetric(graphqlRateLimitV3Decisions);
registry.registerMetric(graphqlRequestOutcomes);
registry.registerMetric(cacheRepositoryEvents);
registry.registerMetric(briefingPublicationReaderEvents);
registry.registerMetric(playerStateProfiles);
registry.registerMetric(playerStateProviderStale);
registry.registerMetric(playerStatsDeskFields);
registry.registerMetric(managerLiveScoreSourceTotal);
registry.registerMetric(managerLiveScoreAgeSeconds);
registry.registerMetric(managerLiveScoreReconciliationTotal);
registry.registerMetric(managerLiveUpstreamRequestsTotal);
registry.registerMetric(managerLiveUpstreamLatencySeconds);
registry.registerMetric(postgresPoolClients);

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
	cacheRepositoryEvents,
	briefingPublicationReaderEvents,
	playerStateProfiles,
	playerStateProviderStale,
	playerStatsDeskFields,
	managerLiveScoreSourceTotal,
	managerLiveScoreAgeSeconds,
	managerLiveScoreReconciliationTotal,
	managerLiveUpstreamRequestsTotal,
	managerLiveUpstreamLatencySeconds,
	postgresPoolClients,
};

export const metricsResponse = async (): Promise<Response> => {
	const body = await registry.metrics();
	return new Response(body, {
		headers: {
			"Content-Type": registry.contentType,
		},
	});
};
