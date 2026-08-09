import { describe, expect, it } from "bun:test";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import { entryLiveResolvers } from "../../../src/domains/entry-live/resolvers";
import { fixturesService } from "../../../src/domains/fixtures/service";
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
		const context = {} as GraphQLContext;
		let usedCachedIds = false;

		tournamentsRepository.getTournamentInfoUncached = async () =>
			({ id: 7, standingsReadyAt: "2026-08-04T00:00:00.000Z" }) as never;
		tournamentsService.getTournamentEntryIds = async () => {
			usedCachedIds = true;
			return [999];
		};
		tournamentsService.getTournamentEntryIdsUncached = async () => [101, 202];
		fixturesService.getEventFixtures = async () => [];
		playersRepository.listTeams = async () => [];
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
				{ eventId: 15, tournamentId: 7, includeLive: false },
				context
			);
			expect(result.meta.totalEntries).toBe(2);
			expect(usedCachedIds).toBe(false);
		} finally {
			tournamentsRepository.getTournamentInfoUncached = originalTournament;
			tournamentsService.getTournamentEntryIds = originalCachedIds;
			tournamentsService.getTournamentEntryIdsUncached = originalFreshIds;
			entryLiveBatchService.calcLivePointsForEntries = originalCalculate;
			fixturesService.getEventFixtures = originalFixtures;
			playersRepository.listTeams = originalTeams;
		}
	});
});
