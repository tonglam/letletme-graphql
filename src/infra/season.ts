import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../graphql/context";

export const ACTIVE_SEASON_KEY = "Season:active";

const seasonMemo = new WeakMap<GraphQLContext, Promise<string>>();

export const parseSeason = (value: string | null): string | null => {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return /^\d{4}$/.test(trimmed) ? trimmed : null;
};

export const getCurrentSeason = (context: GraphQLContext): Promise<string> => {
	const cached = seasonMemo.get(context);
	if (cached) {
		return cached;
	}

	const loading = (async (): Promise<string> => {
		let raw: string | null;
		try {
			raw = await context.redis.get(ACTIVE_SEASON_KEY);
		} catch (error) {
			context.logger.warn(
				{ err: error, key: ACTIVE_SEASON_KEY },
				"Failed to read current season metadata"
			);
			throw new GraphQLError("Current season metadata is unavailable", {
				extensions: {
					code: "CACHE_METADATA_UNAVAILABLE",
					http: { status: 503 },
				},
			});
		}
		const parsed = parseSeason(raw);
		if (!parsed) {
			throw new GraphQLError("Current season metadata is unavailable", {
				extensions: {
					code: "CACHE_METADATA_UNAVAILABLE",
					http: { status: 503 },
				},
			});
		}
		return parsed;
	})();
	const memoized = loading.catch((error) => {
		seasonMemo.delete(context);
		throw error;
	});
	seasonMemo.set(context, memoized);
	return memoized;
};
