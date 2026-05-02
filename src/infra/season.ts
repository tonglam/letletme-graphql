import type { GraphQLContext } from "../graphql/context";

const SEASON_CURRENT_KEY = "season:current";
const DEFAULT_SEASON = "2526";

const seasonMemo = new WeakMap<GraphQLContext, string>();

const parseSeason = (value: string | null): string | null => {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return /^\d{4}$/.test(trimmed) ? trimmed : null;
};

export const getCurrentSeason = async (
	context: GraphQLContext,
): Promise<string> => {
	const cached = seasonMemo.get(context);
	if (cached) {
		return cached;
	}

	const raw = await context.redis.get(SEASON_CURRENT_KEY);
	const parsed = parseSeason(raw);
	const season = parsed ?? DEFAULT_SEASON;
	seasonMemo.set(context, season);
	return season;
};
