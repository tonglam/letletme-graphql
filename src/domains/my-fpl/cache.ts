import type { GraphQLContext } from "../../graphql/context";

/**
 * Read and validate one My FPL cache projection. Corrupt entries are evicted;
 * Redis failures remain request-local and never become an authoritative null.
 */
export const readMyFplCache = async <T>(
	context: Pick<GraphQLContext, "redis" | "logger">,
	key: string,
	validate: (value: unknown) => value is T
): Promise<T | undefined> => {
	let raw: string | null;
	try {
		raw = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read My FPL cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (validate(parsed)) return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed My FPL cache");
	}
	try {
		await context.redis.del(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to evict My FPL cache");
	}
	return undefined;
};
