import { describe, expect, it } from "bun:test";
import {
	assertValidLiveExplainBatch,
	MAX_LIVE_EXPLAIN_BATCH,
} from "../../../src/domains/live/service";

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
