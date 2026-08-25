import { describe, expect, it } from "bun:test";
import {
	assertValidLiveExplainBatch,
	liveService,
	MAX_LIVE_EXPLAIN_BATCH,
} from "../../../src/domains/live/service";
import { liveRepository } from "../../../src/domains/live/repository";
import { playersRepository } from "../../../src/domains/players/repository";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

describe("assertValidLiveExplainBatch", () => {
	it("accepts a unique fifteen-player squad", () => {
		expect(() =>
			assertValidLiveExplainBatch(
				Array.from({ length: MAX_LIVE_EXPLAIN_BATCH }, (_, index) => index + 1)
			)
		).not.toThrow();
	});

	it("rejects oversized, duplicate, and non-positive player IDs", () => {
		expect(() =>
			assertValidLiveExplainBatch(
				Array.from({ length: MAX_LIVE_EXPLAIN_BATCH + 1 }, (_, index) => index + 1)
			)
		).toThrow("player limit");
		expect(() => assertValidLiveExplainBatch([1, 1])).toThrow("unique positive integers");
		expect(() => assertValidLiveExplainBatch([0])).toThrow("unique positive integers");
	});
});

const withReadRows = (context: ReturnType<typeof buildSnapshotContext>, rowCount = 11): void => {
	context.data = {
		read: (model: string) => {
			const rows =
				model === "fpl.player_gameweek_stats"
					? Array.from({ length: rowCount }, (_, index) => ({
							event_id: 1,
							element_id: index + 1,
							minutes: 90,
							in_dream_team: true,
							total_points: 12 - index,
						}))
					: [];
			const result = Promise.resolve({ data: rows, error: null });
			const builder = {
				select: () => builder,
				eq: () => builder,
				in: () => builder,
				or: () => builder,
				then: result.then.bind(result),
			};
			return builder as never;
		},
	} as never;
};

describe("live gameweek boards", () => {
	it("allows the settled PostgreSQL fallback only when explicitly enabled", async () => {
		const baseCore = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			events: baseCore.events.map((event) =>
				event.id === 1
					? {
							...event,
							finished: true,
							dataChecked: true,
							dataCheckedAt: "2026-08-20T02:00:00.000Z",
						}
					: event
			),
		});
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)));
		withReadRows(context);

		await expect(liveService.getGameweekBoards(context, 1)).rejects.toThrow(
			"Live snapshot metadata is unavailable"
		);

		const boards = await liveService.getGameweekBoards(context, 1, {
			allowDurableFallback: true,
		});

		expect(boards.source).toBe("DURABLE_DB");
		expect(boards.meta).toBeNull();
		expect(boards.dreamTeam).toHaveLength(11);
		expect(boards.dreamTeam[0]).toMatchObject({ playerId: 1, totalPoints: 12 });
	});

	it("rejects an incomplete settled PostgreSQL dream team", async () => {
		const core = buildTestCoreData(1, {
			events: buildTestCoreData(1).events.map((event) =>
				event.id === 1 ? { ...event, finished: true, dataChecked: true } : event
			),
		});
		const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)));
		withReadRows(context, 10);

		await expect(
			liveService.getGameweekBoards(context, 1, { allowDurableFallback: true })
		).rejects.toThrow("Durable gameweek board is incomplete");
	});
});

describe("liveService.getPlayerLive", () => {
	it("uses one targeted read and preserves the official total", async () => {
		const originalTargeted = liveRepository.getTargetedLiveRead;
		const originalPlayer = playersRepository.getPlayerById;
		let targetedCalls = 0;
		liveRepository.getTargetedLiveRead = async () => {
			targetedCalls += 1;
			return {
				performances: [
					{
						eventId: 4,
						playerId: 9,
						minutes: 90,
						goalsScored: 0,
						assists: 0,
						cleanSheets: 0,
						goalsConceded: 0,
						ownGoals: 0,
						penaltiesSaved: 0,
						penaltiesMissed: 0,
						yellowCards: 0,
						redCards: 0,
						saves: 0,
						bonus: 0,
						bps: 0,
						starts: true,
						defensiveContribution: 0,
						expectedGoals: "0",
						expectedAssists: "0",
						expectedGoalInvolvements: "0",
						expectedGoalsConceded: "0",
						inDreamTeam: false,
						totalPoints: 2,
					},
				],
				meta: {} as never,
			};
		};
		playersRepository.getPlayerById = async () => ({ position: 3 }) as never;

		try {
			const result = await liveService.getPlayerLive({} as GraphQLContext, 9, 4);
			expect(targetedCalls).toBe(1);
			expect(result).toMatchObject({ playerId: 9, bonus: 0, totalPoints: 2 });
		} finally {
			liveRepository.getTargetedLiveRead = originalTargeted;
			playersRepository.getPlayerById = originalPlayer;
		}
	});
});
