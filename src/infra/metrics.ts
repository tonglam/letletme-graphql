import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

const registry = new Registry();

collectDefaultMetrics({ register: registry });

const httpRequestDurationSeconds = new Histogram({
	name: "http_request_duration_seconds",
	help: "Duration of HTTP requests in seconds",
	labelNames: ["method", "route", "status"] as const,
	buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
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

registry.registerMetric(rateLimitStorageFailures);
registry.registerMetric(authTokenValidations);
registry.registerMetric(graphqlIngressRequests);
registry.registerMetric(graphqlRateLimitDecisions);
registry.registerMetric(cacheRepositoryEvents);
registry.registerMetric(briefingPublicationReaderEvents);
registry.registerMetric(playerStateProfiles);
registry.registerMetric(playerStateProviderStale);
registry.registerMetric(playerStatsDeskFields);

export const metrics = {
	registry,
	httpRequestDurationSeconds,
	rateLimitStorageFailures,
	authTokenValidations,
	graphqlIngressRequests,
	graphqlRateLimitDecisions,
	cacheRepositoryEvents,
	briefingPublicationReaderEvents,
	playerStateProfiles,
	playerStateProviderStale,
	playerStatsDeskFields,
};

export const metricsResponse = async (): Promise<Response> => {
	const body = await registry.metrics();
	return new Response(body, {
		headers: {
			"Content-Type": registry.contentType,
		},
	});
};
