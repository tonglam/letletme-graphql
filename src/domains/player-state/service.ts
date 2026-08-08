import type { GraphQLContext } from "../../graphql/context";
import { metrics } from "../../infra/metrics";
import { playerStateRepository } from "./repository";
import type { PlayerStateProfile } from "./types";

export const playerStateService = {
	async getPlayerStateProfile(
		context: GraphQLContext,
		playerId: number,
		horizon = 5
	): Promise<PlayerStateProfile | null> {
		const profile = await playerStateRepository.getPlayerStateProfile(context, playerId, horizon);
		if (profile) {
			metrics.playerStateProfiles
				.labels(
					profile.trend.toLowerCase(),
					profile.confidence.toLowerCase(),
					profile.fplOnly ? "fpl_only" : "cross_provider",
					profile.coverage.mappingStatus.toLowerCase()
				)
				.inc();
			for (const provider of profile.coverage.providers) {
				if (!provider.available || !provider.stale) continue;
				metrics.playerStateProviderStale
					.labels(provider.provider.toLowerCase(), provider.scope.toLowerCase())
					.inc();
			}
		}
		return profile;
	},
};
