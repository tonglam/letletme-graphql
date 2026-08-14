import type { GraphQLContext } from "../graphql/context";

export const QUERY_CACHE_TTL_SECONDS = Object.freeze({
	LIVE: 10,
	METADATA: 60,
	REPORTING: 5 * 60,
	MARKET: 5 * 60,
	HISTORICAL: 60 * 60,
});

export const MARKET_REVISIONED_TTL_SECONDS = 24 * 60 * 60;

export const writeQueryCache = async (
	context: GraphQLContext,
	key: string,
	value: string,
	ttlSeconds: number
): Promise<boolean> => {
	if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
		throw new Error("GraphQL query cache TTL must be a positive integer");
	}
	try {
		await context.redis.set(key, value, "EX", ttlSeconds);
		return true;
	} catch (error) {
		context.logger.warn({ err: error, key, ttlSeconds }, "Failed to write GraphQL query cache");
		return false;
	}
};

export const deleteQueryCache = async (context: GraphQLContext, key: string): Promise<boolean> => {
	try {
		await context.redis.del(key);
		return true;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to delete GraphQL query cache");
		return false;
	}
};
