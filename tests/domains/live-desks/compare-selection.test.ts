import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import * as live from "../../../src/domains/entry-live/v2-service";
import { tournamentsService } from "../../../src/domains/tournaments/service";
import { liveDesksResolvers } from "../../../src/domains/live-desks/resolvers";

const context = { currentSeason: { seasonCode: "2627" } } as GraphQLContext;
const ref = { season: "2627", eventId: 4, scoreCoreRevision: "current" };
const publication = {
	publication: {
		eventId: 4,
		state: "FINALIZED",
		revisions: { scoreCore: { revision: "current" } },
	},
} as live.LivePublicationReadV2;

describe("tournament comparison selection", () => {
	beforeEach(() => {
		spyOn(tournamentsService, "getTournamentForMember").mockResolvedValue(
			{} as NonNullable<Awaited<ReturnType<typeof tournamentsService.getTournamentForMember>>>
		);
		spyOn(live, "readLivePublicationV2").mockResolvedValue(publication);
		spyOn(tournamentsService, "getTournamentParticipants").mockResolvedValue(
			[6953, 31056, 6733550].map((entryId) => ({ entryId, entryName: null, playerName: null }))
		);
		spyOn(live, "calcLivePointsForEntriesV2").mockImplementation(
			async (_context, _event, ids) =>
				({
					results: new Map(ids.map((entry) => [entry, { entry }])),
				}) as Awaited<ReturnType<typeof live.calcLivePointsForEntriesV2>>
		);
	});
	afterEach(() => mock.restore());

	for (const ids of [
		[31056, 6733550],
		[31056, 6953],
	]) {
		it(`returns exactly the selected pair ${ids.join(",")} while authorizing the viewer`, async () => {
			const result = await liveDesksResolvers.Query.tournamentEntrySquads(
				null,
				{ entryId: 6953, tournamentId: 3, comparedEntryIds: ids, ref },
				context
			);
			expect(tournamentsService.getTournamentForMember).toHaveBeenCalledWith(context, 3, 6953);
			expect(live.calcLivePointsForEntriesV2).toHaveBeenCalledWith(context, 4, ids);
			expect(result.entries.map((entry) => entry.entry)).toEqual(ids);
		});
	}

	it("does not read scores when viewer membership is denied", async () => {
		spyOn(tournamentsService, "getTournamentForMember").mockResolvedValue(null);
		await expect(
			liveDesksResolvers.Query.tournamentEntrySquads(
				null,
				{ entryId: 6953, tournamentId: 3, comparedEntryIds: [31056, 6733550], ref },
				context
			)
		).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
		expect(live.calcLivePointsForEntriesV2).not.toHaveBeenCalled();
	});

	it("rejects a selected team outside the tournament before calculating any scores", async () => {
		await expect(
			liveDesksResolvers.Query.tournamentEntrySquads(
				null,
				{ entryId: 6953, tournamentId: 3, comparedEntryIds: [31056, 99999], ref },
				context
			)
		).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
		expect(live.calcLivePointsForEntriesV2).not.toHaveBeenCalled();
	});

	it("does not calculate the pair against a different revision", async () => {
		await expect(
			liveDesksResolvers.Query.tournamentEntrySquads(
				null,
				{
					entryId: 6953,
					tournamentId: 3,
					comparedEntryIds: [31056, 6733550],
					ref: { ...ref, scoreCoreRevision: "old" },
				},
				context
			)
		).rejects.toMatchObject({ extensions: { code: "LIVE_SCORE_REVISION_GONE" } });
		expect(live.calcLivePointsForEntriesV2).not.toHaveBeenCalled();
	});
});
