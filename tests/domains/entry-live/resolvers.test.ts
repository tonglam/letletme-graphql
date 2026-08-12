import { describe, expect, it } from "bun:test";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import { entryLiveResolvers } from "../../../src/domains/entry-live/resolvers";
import { fixturesService } from "../../../src/domains/fixtures/service";
import { liveRepository } from "../../../src/domains/live/repository";
import { playersRepository } from "../../../src/domains/players/repository";
import { tournamentsRepository } from "../../../src/domains/tournaments/repository";
import { tournamentsService } from "../../../src/domains/tournaments/service";
import type { GraphQLContext } from "../../../src/graphql/context";

describe("calcLivePointsForTournament resolver", () => {
	it("uses the authoritative roster after the readiness barrier", async () => {
		const originalTournament = tournamentsRepository.getTournamentInfoUncached;
		const originalCachedIds = tournamentsService.getTournamentEntryIds;
		const originalFreshIds = tournamentsService.getTournamentEntryIdsUncached;
		const originalCalculate = entryLiveBatchService.calcLivePointsForEntries;
		const originalFixtures = fixturesService.getEventFixtures;
		const originalTeams = playersRepository.listTeams;
		const originalLive = liveRepository.getAllLivePerformances;
		const context = {} as GraphQLContext;
		let usedCachedIds = false;
		let secondaryCalls = 0;

		tournamentsRepository.getTournamentInfoUncached = async () =>
			({ id: 7, standingsReadyAt: "2026-08-04T00:00:00.000Z" }) as never;
		tournamentsService.getTournamentEntryIds = async () => {
			usedCachedIds = true;
			return [999];
		};
		tournamentsService.getTournamentEntryIdsUncached = async () => [101, 202];
		fixturesService.getEventFixtures = async () => {
			secondaryCalls += 1;
			throw new Error("fixtures must not be prefetched");
		};
		playersRepository.listTeams = async () => {
			secondaryCalls += 1;
			throw new Error("teams must not be prefetched");
		};
		liveRepository.getAllLivePerformances = async () => {
			secondaryCalls += 1;
			throw new Error("live must not be prefetched");
		};
		entryLiveBatchService.calcLivePointsForEntries = async (_inputContext, eventId, entryIds) => {
			expect(eventId).toBe(15);
			expect(entryIds).toEqual([101, 202]);
			return {
				results: new Map(),
				errors: [],
				meta: {
					eventId,
					totalEntries: entryIds.length,
					succeededCount: 0,
					failedCount: 0,
				},
			};
		};

		try {
			const result = await entryLiveResolvers.Query.calcLivePointsForTournament(
				undefined,
				{ eventId: 15, tournamentId: 7, includeLive: true },
				context
			);
			expect(result.meta.totalEntries).toBe(2);
			expect(usedCachedIds).toBe(false);
			expect(secondaryCalls).toBe(0);
		} finally {
			tournamentsRepository.getTournamentInfoUncached = originalTournament;
			tournamentsService.getTournamentEntryIds = originalCachedIds;
			tournamentsService.getTournamentEntryIdsUncached = originalFreshIds;
			entryLiveBatchService.calcLivePointsForEntries = originalCalculate;
			fixturesService.getEventFixtures = originalFixtures;
			playersRepository.listTeams = originalTeams;
			liveRepository.getAllLivePerformances = originalLive;
		}
	});
});
