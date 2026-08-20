import { createHmac } from "crypto";
import type Redis from "ioredis";
import type { Logger } from "./logger";
import type { GraphQLTrafficClass, GraphQLWorkload } from "./ingress-context";
import type { GraphQLRateLimitHeaderScope } from "../http/token-bucket-v3";
import { env } from "./env";
import { metrics } from "./metrics";

export const RATE_LIMIT_AGGREGATE_RETENTION_SECONDS = 14 * 24 * 60 * 60;

export type RateLimitAggregateOutcome =
	"allowed" | "denied" | "would_allow" | "would_deny" | "legacy_allowed" | "legacy_denied";

const deniedOutcomes = new Set<RateLimitAggregateOutcome>([
	"denied",
	"would_deny",
	"legacy_denied",
]);

export const rateLimitFingerprint = (
	subject: string | null,
	secret = env.BACKEND_PROXY_SECRET
): string =>
	createHmac("sha256", secret)
		.update(subject ?? "missing-subject")
		.digest("hex")
		.slice(0, 12);

export const rateLimitAggregateDate = (date = new Date()): string =>
	date.toISOString().slice(0, 10);

export const rateLimitAggregateKey = (date: string): string =>
	`llm:gql:rate-limit:v3:aggregate:${date}`;

export const rateLimitDeniedRankingKey = (date: string): string =>
	`llm:gql:rate-limit:v3:denied:${date}`;

export const recordRateLimitAggregate = async ({
	redis,
	trafficClass,
	workload,
	scope,
	outcome,
	fingerprint,
	date = new Date(),
	logger,
}: {
	redis: Redis;
	trafficClass: GraphQLTrafficClass;
	workload: GraphQLWorkload;
	scope: GraphQLRateLimitHeaderScope;
	outcome: RateLimitAggregateOutcome;
	fingerprint: string;
	date?: Date;
	logger: Logger;
}): Promise<void> => {
	metrics.graphqlRateLimitV3Decisions.labels(trafficClass, workload, scope, outcome).inc();
	const day = rateLimitAggregateDate(date);
	const aggregateKey = rateLimitAggregateKey(day);
	const field = [trafficClass, workload, scope, outcome].join("|");
	try {
		const pipeline = redis.pipeline();
		pipeline.hincrby(aggregateKey, field, 1);
		pipeline.expire(aggregateKey, RATE_LIMIT_AGGREGATE_RETENTION_SECONDS);
		if (deniedOutcomes.has(outcome)) {
			const rankingKey = rateLimitDeniedRankingKey(day);
			pipeline.zincrby(
				rankingKey,
				1,
				[trafficClass, workload, scope, outcome, fingerprint].join("|")
			);
			pipeline.expire(rankingKey, RATE_LIMIT_AGGREGATE_RETENTION_SECONDS);
		}
		const results = await pipeline.exec();
		const failure = results?.find(([error]) => error);
		if (failure?.[0]) throw failure[0];
	} catch (error) {
		metrics.rateLimitStorageFailures.labels("graphql-v3-aggregate", "open").inc();
		logger.warn(
			{ err: error, trafficClass, workload, scope, outcome },
			"Rate-limit aggregate persistence unavailable"
		);
	}
};
