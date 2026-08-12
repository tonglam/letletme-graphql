import { describe, expect, it } from "bun:test";
import { RequestTiming, measureRequestStage } from "../../src/http/request-timing";

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
});
