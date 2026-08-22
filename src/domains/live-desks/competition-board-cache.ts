import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import type { LiveDataSnapshot } from "../../infra/data-snapshot";

export const LIVE_COMPETITION_PROJECTION_VERSION = "v3";

export type CachedCompetitionBoard = {
	board: unknown[];
	partial: boolean;
	failedEntryIds: number[];
	totalEntries: number;
};

export const competitionBoardCacheKey = (
	context: GraphQLContext,
	snapshot: Pick<LiveDataSnapshot, "seasonCode" | "eventId" | "revision">,
	tournamentId: number
): string =>
	gqlCacheKey(
		context,
		`live-competition-board:${snapshot.eventId}:${tournamentId}:${LIVE_COMPETITION_PROJECTION_VERSION}`,
		`live-${snapshot.seasonCode}-${snapshot.eventId}-${snapshot.revision}`
	);

export const readCompetitionBoardCache = async (
	context: GraphQLContext,
	key: string
): Promise<CachedCompetitionBoard | null> => {
	try {
		const raw = await context.redis.get(key);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CachedCompetitionBoard;
		if (
			!parsed ||
			!Array.isArray(parsed.board) ||
			typeof parsed.partial !== "boolean" ||
			!Array.isArray(parsed.failedEntryIds) ||
			!parsed.failedEntryIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
			!Number.isSafeInteger(parsed.totalEntries) ||
			parsed.totalEntries < 0
		)
			return null;
		return parsed;
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read Live competition board cache");
		return null;
	}
};

export const writeCompetitionBoardCache = async (
	context: GraphQLContext,
	key: string,
	value: CachedCompetitionBoard,
	ttlSeconds: number
): Promise<void> => {
	try {
		await context.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
	} catch (error) {
		context.logger.warn(
			{ err: error, key, ttlSeconds },
			"Failed to write Live competition board cache"
		);
	}
};
