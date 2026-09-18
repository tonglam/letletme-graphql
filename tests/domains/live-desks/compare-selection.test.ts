import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import * as live from "../../../src/domains/entry-live/v2-service";
import { tournamentsService } from "../../../src/domains/tournaments/service";
import { liveDesksResolvers } from "../../../src/domains/live-desks/resolvers";

const context = {
	currentSeason: { seasonCode: "2627" },
	data: {
		read() {
			const query = {
				select() {
					return query;
				},
				eq() {
					return query;
				},
				async in(_column: string, ids: number[]) {
					return {
						data: ids
							.filter((id) => [6953, 31056, 6733550].includes(id))
							.map((entry_id) => ({ entry_id })),
						error: null,
					};
				},
			};
			return query;
		},
	},
} as unknown as GraphQLContext;
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

	it("checks only selected IDs and accepts current official members absent from the roster", async () => {
		const reads: string[] = [];
		const selections: number[][] = [];
		const membershipContext = {
			...context,
			logger: { error() {} },
			data: {
				read(table: string) {
					reads.push(table);
					const query = {
						select() {
							return query;
						},
						eq() {
							return query;
						},
						in(_column: string, ids: number[]) {
							selections.push(ids);
							return Promise.resolve({
								data:
									table === "competition.tournament_entries"
										? []
										: ids.map((entry_id) => ({ entry_id })),
								error: null,
							});
						},
					};
					return query;
				},
			},
		} as unknown as GraphQLContext;
		const result = await liveDesksResolvers.Query.tournamentEntrySquads(
			null,
			{ entryId: 6953, tournamentId: 3, comparedEntryIds: [31056, 6733550], ref },
			membershipContext
		);
		expect(result.entries.map((entry) => entry.entry)).toEqual([31056, 6733550]);
		expect(tournamentsService.getTournamentParticipants).not.toHaveBeenCalled();
		expect(reads).toEqual([
			"competition.tournament_entries",
			"competition.entry_leagues_with_tournament",
		]);
		expect(selections).toEqual([
			[31056, 6733550],
			[31056, 6733550],
		]);
	});

	for (const failedTable of [
		"competition.tournament_entries",
		"competition.entry_leagues_with_tournament",
	]) {
		it(`fails closed when ${failedTable} cannot be read`, async () => {
			const failingContext = {
				...context,
				data: {
					read(table: string) {
						const query = {
							select() {
								return query;
							},
							eq() {
								return query;
							},
							async in() {
								return { data: [], error: table === failedTable ? new Error("unavailable") : null };
							},
						};
						return query;
					},
				},
			} as unknown as GraphQLContext;
			await expect(
				liveDesksResolvers.Query.tournamentEntrySquads(
					null,
					{ entryId: 6953, tournamentId: 3, comparedEntryIds: [31056, 6733550], ref },
					failingContext
				)
			).rejects.toThrow("Failed to verify");
			expect(live.calcLivePointsForEntriesV2).not.toHaveBeenCalled();
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
