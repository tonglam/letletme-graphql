import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../graphql/context";

export const ACTIVE_SEASON_KEY = "Season:active";

const seasonMemo = new WeakMap<GraphQLContext, string>();

export const parseSeason = (value: string | null): string | null => {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return /^\d{4}$/.test(trimmed) ? trimmed : null;
};

export const getCurrentSeason = async (context: GraphQLContext): Promise<string> => {
	const cached = seasonMemo.get(context);
	if (cached) {
		return cached;
	}

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
	seasonMemo.set(context, parsed);
	return parsed;
};
