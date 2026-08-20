import type { GraphQLContext } from "../../graphql/context";
import { getCoreEventSnapshot } from "../../infra/data-snapshot";
import { metrics } from "../../infra/metrics";
import type { CurrentSeason } from "../../infra/season";
import { getPlayerStateDatasetRevision, playerStateRepository } from "./repository";
import type { PlayerStateProfile } from "./types";

const profileSingleflight = new Map<string, Promise<PlayerStateProfile | null>>();

const revisionFor = async (context: GraphQLContext): Promise<string> => {
	const coreRevision = (await getCoreEventSnapshot(context)).revision;
	const datasetRevision = await getPlayerStateDatasetRevision(context, context.database);
	return `${coreRevision}:${datasetRevision.revision}`;
};

const profileSingleflightKey = (
	context: GraphQLContext,
	revision: string,
	playerId: number,
	horizon: number
): string =>
	`${context.currentSeason.seasonId}:${context.currentSeason.lifecycleState ?? "unknown"}:${revision}:${playerId}:${horizon}`;

/**
 * A request pins its season identity when the ReadModelClient and authorization
 * are created. Refresh may update lifecycle state, but it must never move the
 * request to a different season after those readers have been constructed.
 */
export const applyRefreshedCurrentSeason = (
	currentSeason: CurrentSeason,
	refreshedSeason: CurrentSeason
): CurrentSeason => {
	if (
		currentSeason.seasonId !== refreshedSeason.seasonId ||
		currentSeason.seasonCode !== refreshedSeason.seasonCode
	) {
		return currentSeason;
	}
	if (currentSeason.lifecycleState === refreshedSeason.lifecycleState) return currentSeason;
	return Object.freeze({
		seasonId: currentSeason.seasonId,
		seasonCode: currentSeason.seasonCode,
		...(refreshedSeason.lifecycleState === undefined
			? {}
			: { lifecycleState: refreshedSeason.lifecycleState }),
	});
};

const loadProfilesSingleflight = async (
	context: GraphQLContext,
	playerIds: number[],
	horizon: number
): Promise<Map<number, PlayerStateProfile | null>> => {
	const refreshedSeason = await context.refreshCurrentSeason?.();
	if (refreshedSeason)
		context.currentSeason = applyRefreshedCurrentSeason(context.currentSeason, refreshedSeason);
	// The process-level coalescing key must include the immutable core revision.
	// Otherwise a request that starts immediately after an active-pointer switch
	// could join work that is still computing against the old publication.
	const revision = await revisionFor(context);
	const uniqueIds = Array.from(new Set(playerIds));
	const pending = new Map<number, Promise<PlayerStateProfile | null>>();
	const missingIds: number[] = [];
	for (const playerId of uniqueIds) {
		const existing = profileSingleflight.get(
			profileSingleflightKey(context, revision, playerId, horizon)
		);
		if (existing) pending.set(playerId, existing);
		else missingIds.push(playerId);
	}
	if (missingIds.length > 0) {
		const batch = playerStateRepository.getPlayerStateProfiles(context, missingIds, horizon);
		for (const playerId of missingIds) {
			const key = profileSingleflightKey(context, revision, playerId, horizon);
			const loading = batch
				.then((profiles) => profiles.get(playerId) ?? null)
				.finally(() => profileSingleflight.delete(key));
			profileSingleflight.set(key, loading);
			pending.set(playerId, loading);
		}
	}
	return new Map(
		await Promise.all(
			uniqueIds.map(async (playerId) => [playerId, await pending.get(playerId)!] as const)
		)
	);
};

export const playerStateService = {
	async getPlayerStateProfile(
		context: GraphQLContext,
		playerId: number,
		horizon = 5
	): Promise<PlayerStateProfile | null> {
		const profile =
			(await loadProfilesSingleflight(context, [playerId], horizon)).get(playerId) ?? null;
		if (profile) {
			const currentSource = profile.coverage.sources.find(
				(source) => source.provider === "FPL" && source.scope === "CURRENT"
			);
			metrics.playerStateProfiles
				.labels(
					profile.trend.toLowerCase(),
					profile.confidence.toLowerCase(),
					profile.providerMode.toLowerCase(),
					(currentSource?.analysisStatus ?? "UNAVAILABLE").toLowerCase()
				)
				.inc();
			for (const provider of profile.coverage.sources) {
				if (provider.dataStatus !== "AVAILABLE" || !provider.stale) continue;
				metrics.playerStateProviderStale
					.labels(provider.provider.toLowerCase(), provider.scope.toLowerCase())
					.inc();
			}
		}
		return profile;
	},

	async getPlayerStateProfiles(
		context: GraphQLContext,
		playerIds: number[],
		horizon = 5
	): Promise<Map<number, PlayerStateProfile | null>> {
		const profiles = await loadProfilesSingleflight(context, playerIds, horizon);
		for (const profile of profiles.values()) {
			if (!profile) continue;
			const currentSource = profile.coverage.sources.find(
				(source) => source.provider === "FPL" && source.scope === "CURRENT"
			);
			metrics.playerStateProfiles
				.labels(
					profile.trend.toLowerCase(),
					profile.confidence.toLowerCase(),
					profile.providerMode.toLowerCase(),
					(currentSource?.analysisStatus ?? "UNAVAILABLE").toLowerCase()
				)
				.inc();
		}
		return profiles;
	},
};
