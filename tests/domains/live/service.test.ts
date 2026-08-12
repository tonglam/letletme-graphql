import { describe, expect, it } from "bun:test";
import {
	assertValidLiveExplainBatch,
	liveService,
	MAX_LIVE_EXPLAIN_BATCH,
} from "../../../src/domains/live/service";
import { liveRepository } from "../../../src/domains/live/repository";
import { playersRepository } from "../../../src/domains/players/repository";
import type { GraphQLContext } from "../../../src/graphql/context";

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

describe("liveService.getPlayerLive", () => {
	it("uses one targeted read for both performance and effective bonus", async () => {
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
				effectiveBonusByPlayer: new Map([[9, 3]]),
				meta: {} as never,
			};
		};
		playersRepository.getPlayerById = async () => ({ position: 3 }) as never;

		try {
			const result = await liveService.getPlayerLive({} as GraphQLContext, 9, 4);
			expect(targetedCalls).toBe(1);
			expect(result).toMatchObject({ playerId: 9, bonus: 3, totalPoints: 5 });
		} finally {
			liveRepository.getTargetedLiveRead = originalTargeted;
			playersRepository.getPlayerById = originalPlayer;
		}
	});
});
