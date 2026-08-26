import { describe, expect, it } from "bun:test";
import {
	claimLivePublicationFailureLog,
	livePublicationFailureReason,
} from "../../../src/domains/live-desks/publication-observability";

describe("live publication observability", () => {
	it("recognizes the bounded publication-unavailable reason", () => {
		expect(
			livePublicationFailureReason(new Error("LIVE_PUBLICATION_UNAVAILABLE:2627:1:1230"))
		).toBe("LIVE_PUBLICATION_UNAVAILABLE");
	});

	it("does not copy internal error text into logs", () => {
		expect(
			livePublicationFailureReason(
				new Error("relation live_publications does not exist; password=secret")
			)
		).toBe("LIVE_SNAPSHOT_LOAD_FAILED");
		expect(livePublicationFailureReason("LIVE_PUBLICATION_UNAVAILABLE:2627:1:1230")).toBe(
			"LIVE_SNAPSHOT_LOAD_FAILED"
		);
	});

	it("deduplicates aliased field failures within one request", () => {
		const requestScope = {};
		expect(claimLivePublicationFailureLog(requestScope, 1, "1230")).toBe(true);
		expect(claimLivePublicationFailureLog(requestScope, 1, "1230")).toBe(false);
		expect(claimLivePublicationFailureLog(requestScope, 1, "1231")).toBe(true);
		expect(claimLivePublicationFailureLog({}, 1, "1230")).toBe(true);
	});
});
