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

export type QueryCacheDecoder<T> = (value: unknown) => T | null;

export const readJsonQueryCache = async <T>(
	context: GraphQLContext,
	key: string,
	decode: QueryCacheDecoder<T>
): Promise<T | undefined> => {
	let raw: string | null;
	try {
		raw = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read GraphQL query cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		const decoded = decode(JSON.parse(raw) as unknown);
		if (decoded !== null) return decoded;
		throw new Error("GraphQL query cache codec rejected value");
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed GraphQL query cache");
		await deleteQueryCache(context, key);
		return undefined;
	}
};

export const readJsonQueryCacheBatch = async <T>(
	context: GraphQLContext,
	keys: readonly string[],
	decode: QueryCacheDecoder<T>
): Promise<Array<T | undefined>> => {
	if (keys.length === 0) return [];
	let rawValues: Array<string | null>;
	try {
		rawValues = await context.redis.mget(...keys);
	} catch (error) {
		context.logger.warn({ err: error, keys }, "Failed to read GraphQL query cache batch");
		return keys.map(() => undefined);
	}
	return Promise.all(
		rawValues.map(async (raw, index) => {
			if (raw === null) return undefined;
			const key = keys[index]!;
			try {
				const decoded = decode(JSON.parse(raw) as unknown);
				if (decoded !== null) return decoded;
				throw new Error("GraphQL query cache codec rejected value");
			} catch (error) {
				context.logger.warn({ err: error, key }, "Malformed GraphQL query cache");
				await deleteQueryCache(context, key);
				return undefined;
			}
		})
	);
};

export const writeJsonQueryCache = async (
	context: GraphQLContext,
	key: string,
	value: unknown,
	ttlSeconds: number
): Promise<boolean> => writeQueryCache(context, key, JSON.stringify(value), ttlSeconds);
