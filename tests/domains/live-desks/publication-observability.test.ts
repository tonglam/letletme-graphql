import { describe, expect, it } from "bun:test";
import {
	claimLivePublicationFailureLog,
	livePublicationFailureDetails,
} from "../../../src/domains/live-desks/publication-observability";

describe("live publication observability", () => {
	it("recognizes the bounded publication-unavailable reason", () => {
		expect(
			livePublicationFailureDetails(
				new Error("LIVE_PUBLICATION_UNAVAILABLE:2627:1:1230"),
				"2627",
				1
			)
		).toEqual({ reason: "LIVE_PUBLICATION_UNAVAILABLE", revision: "1230" });
	});

	it("does not copy public input or internal error text into logs", () => {
		expect(
			livePublicationFailureDetails(
				new Error("relation live_publications does not exist; password=secret"),
				"2627",
				1
			)
		).toEqual({ reason: "LIVE_SNAPSHOT_LOAD_FAILED", revision: null });
		expect(
			livePublicationFailureDetails(
				new Error("LIVE_PUBLICATION_UNAVAILABLE:2627:1:not-a-revision"),
				"2627",
				1
			)
		).toEqual({ reason: "LIVE_SNAPSHOT_LOAD_FAILED", revision: null });
		expect(
			livePublicationFailureDetails(
				new Error("LIVE_PUBLICATION_UNAVAILABLE:2627:2:1230"),
				"2627",
				1
			)
		).toEqual({ reason: "LIVE_SNAPSHOT_LOAD_FAILED", revision: null });
	});

	it("deduplicates aliased field failures within one request", () => {
		const requestScope = {};
		expect(claimLivePublicationFailureLog(requestScope, 1, "1230")).toBe(true);
		expect(claimLivePublicationFailureLog(requestScope, 1, "1230")).toBe(false);
		expect(claimLivePublicationFailureLog(requestScope, 1, "1231")).toBe(true);
		expect(claimLivePublicationFailureLog({}, 1, "1230")).toBe(true);
	});
});
