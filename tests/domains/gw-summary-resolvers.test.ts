import { describe, expect, it } from "bun:test";
import { RequestTiming, measureRequestStage } from "../../src/http/request-timing";
import { eventOverallResultResolvers } from "../../src/domains/event-overall-result/resolvers";
import type {
	EventResult,
	TopElementInfo,
} from "../../src/domains/event-overall-result/repository";
import { playersService } from "../../src/domains/players/service";
import type { GraphQLContext } from "../../src/graphql/context";

describe("gameweek summary root timing", () => {
	it("starts independent roots concurrently and retains successful sibling results", async () => {
		const timing = new RequestTiming();
		const started: string[] = [];
		const root = (stage: string, value: string, shouldFail = false): Promise<string> =>
			measureRequestStage(timing, stage, async () => {
				started.push(stage);
				await Promise.resolve();
				if (shouldFail) throw new Error("section unavailable");
				return value;
			});

		const results = await Promise.allSettled([
			root("gwSummary.eventOverallResult", "overall"),
			root("gwSummary.eventLive", "live", true),
			root("gwSummary.topTransfersIn", "in"),
			root("gwSummary.topTransfersOut", "out"),
		]);

		expect(started).toEqual([
			"gwSummary.eventOverallResult",
			"gwSummary.eventLive",
			"gwSummary.topTransfersIn",
			"gwSummary.topTransfersOut",
		]);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"rejected",
			"fulfilled",
			"fulfilled",
		]);
		expect(Object.keys(timing.snapshot()).sort()).toEqual(started.slice().sort());
	});

	it("instruments each MiniGameweekSummary root with one stable stage", async () => {
		const files = await Promise.all([
			Bun.file("src/domains/event-overall-result/resolvers.ts").text(),
			Bun.file("src/domains/live/resolvers.ts").text(),
			Bun.file("src/domains/players/resolvers.ts").text(),
		]);
		const source = files.join("\n");
		for (const stage of [
			"gwSummary.eventOverallResult",
			"gwSummary.eventLive",
			"gwSummary.topTransfersIn",
			"gwSummary.topTransfersOut",
		]) {
			expect(source.match(new RegExp(stage.replace(".", "\\."), "g"))?.length).toBe(1);
		}
	});

	it("attributes nested overall-result player and team reads to the same stage", async () => {
		const originalPlayer = playersService.getPlayerById;
		const originalTeam = playersService.getTeamById;
		const timing = new RequestTiming();
		const context = { requestTiming: timing } as GraphQLContext;
		playersService.getPlayerById = async () => ({ id: 1, webName: "Player 1", teamId: 2 }) as never;
		playersService.getTeamById = async () => ({ id: 2, shortName: "T02" }) as never;

		try {
			const player = await eventOverallResultResolvers.EventResult.mostSelectedPlayer(
				{ mostSelectedPlayer: null, mostSelectedId: 1 } as EventResult,
				{},
				context
			);
			const teamShortName = await eventOverallResultResolvers.TopElementInfo.teamShortName(
				{ element: 1, points: 10 } as TopElementInfo,
				{},
				context
			);

			expect(player).toEqual({ id: 1, webName: "Player 1" });
			expect(teamShortName).toBe("T02");
			expect(Object.hasOwn(timing.snapshot(), "gwSummary.eventOverallResult")).toBe(true);
		} finally {
			playersService.getPlayerById = originalPlayer;
			playersService.getTeamById = originalTeam;
		}
	});
});
