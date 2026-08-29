import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import { entryLiveBatchService } from "../../../src/domains/entry-live/batch-service";
import {
	entryLiveCalcService,
	type LiveCalcData,
} from "../../../src/domains/entry-live/calc-service";

const timedContext = (stages: string[]): GraphQLContext =>
	({
		requestTiming: {
			start: (stage: string) => {
				stages.push(stage);
				return () => undefined;
			},
		},
	}) as unknown as GraphQLContext;

describe("entryLiveCalcService.calcLivePointsByEntry", () => {
	it("rejects invalid identifiers without entering the batch pipeline", async () => {
		const originalBatchCalc = entryLiveBatchService.calcLivePointsForEntries;
		let calls = 0;
		entryLiveBatchService.calcLivePointsForEntries = async () => {
			calls += 1;
			throw new Error("unexpected batch call");
		};

		try {
			const result = await entryLiveCalcService.calcLivePointsByEntry({} as GraphQLContext, 0, 123);
			expect(result.availability).toBe("NO_PICKS");
			expect(result.event).toBe(0);
			expect(calls).toBe(0);
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = originalBatchCalc;
		}
	});

	it("delegates a valid entry exactly once to the canonical batch engine", async () => {
		const originalBatchCalc = entryLiveBatchService.calcLivePointsForEntries;
		const stages: string[] = [];
		const ready = {
			availability: "READY",
			event: 1,
			entry: 123,
			score: { source: "FPL_EVENT_LIVE", state: "FRESH" },
		} as LiveCalcData;
		let calls = 0;
		entryLiveBatchService.calcLivePointsForEntries = async (
			_context,
			eventId,
			entryIds,
			options
		) => {
			calls += 1;
			expect(eventId).toBe(1);
			expect(entryIds).toEqual([123]);
			expect(options?.managerReadMode).toBe("CACHE_ONLY");
			return {
				results: new Map([[123, ready]]),
				errors: [],
				meta: { eventId, totalEntries: 1, succeededCount: 1, failedCount: 0 },
			};
		};

		try {
			const result = await entryLiveCalcService.calcLivePointsByEntry(timedContext(stages), 1, 123);
			expect(result).toBe(ready);
			expect(calls).toBe(1);
			expect(stages).toEqual(["entryLive.aggregate"]);
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = originalBatchCalc;
		}
	});

	it("returns the batch NO_PICKS result without rebuilding its metadata", async () => {
		const originalBatchCalc = entryLiveBatchService.calcLivePointsForEntries;
		const originalDataUrl = Bun.env.LETLETME_DATA_URL;
		Bun.env.LETLETME_DATA_URL = "";
		const noPicks = {
			availability: "NO_PICKS",
			event: 7,
			entry: 123,
			entryName: "Legacy Team",
			score: { source: "UNAVAILABLE", state: "UNAVAILABLE" },
		} as LiveCalcData;
		entryLiveBatchService.calcLivePointsForEntries = async () => ({
			results: new Map([[123, noPicks]]),
			errors: [],
			meta: { eventId: 7, totalEntries: 1, succeededCount: 1, failedCount: 0 },
		});

		try {
			const result = await entryLiveCalcService.calcLivePointsByEntry({} as GraphQLContext, 7, 123);
			expect(result).toBe(noPicks);
			expect(result.entryName).toBe("Legacy Team");
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = originalBatchCalc;
			if (originalDataUrl === undefined) delete Bun.env.LETLETME_DATA_URL;
			else Bun.env.LETLETME_DATA_URL = originalDataUrl;
		}
	});

	it("surfaces the batch error for a missing result", async () => {
		const originalBatchCalc = entryLiveBatchService.calcLivePointsForEntries;
		entryLiveBatchService.calcLivePointsForEntries = async () => ({
			results: new Map(),
			errors: [{ entryId: 123, message: "canonical failure" }],
			meta: { eventId: 1, totalEntries: 1, succeededCount: 0, failedCount: 1 },
		});

		try {
			await expect(
				entryLiveCalcService.calcLivePointsByEntry({} as GraphQLContext, 1, 123)
			).rejects.toThrow("canonical failure");
		} finally {
			entryLiveBatchService.calcLivePointsForEntries = originalBatchCalc;
		}
	});
});
