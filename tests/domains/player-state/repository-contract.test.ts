import { describe, expect, it } from "bun:test";
import {
	sourceCoverage,
	resolvePlayerStateMappingStatus,
	type ProviderLinkRow,
} from "../../../src/domains/player-state/coverage";

const link = (status: string, confirmedSeasons: string[] = ["2627"]): ProviderLinkRow => ({
	status,
	rule_id: "player-link",
	left_entity_id: "understat-player-1",
	evidence: { confirmedSeasons },
});

describe("Player State provider contract", () => {
	it("joins only season-specific verified player links", () => {
		expect(resolvePlayerStateMappingStatus(link("auto_verified"), "2627")).toBe("VERIFIED");
		expect(resolvePlayerStateMappingStatus(link("manual_verified"), "2627")).toBe("VERIFIED");
		expect(resolvePlayerStateMappingStatus(link("auto_verified", ["2526"]), "2627")).toBe(
			"UNVERIFIED"
		);
		expect(
			resolvePlayerStateMappingStatus({ ...link("auto_verified"), left_entity_id: null }, "2627")
		).toBe("UNVERIFIED");
	});

	it("never promotes ambiguous or quarantined mappings", () => {
		expect(resolvePlayerStateMappingStatus(link("ambiguous"), "2627")).toBe("AMBIGUOUS");
		expect(resolvePlayerStateMappingStatus(link("quarantined"), "2627")).toBe("QUARANTINED");
		expect(resolvePlayerStateMappingStatus(link("pending"), "2627")).toBe("UNVERIFIED");
		expect(resolvePlayerStateMappingStatus(null, "2627")).toBe("UNAVAILABLE");
	});

	it("does not label a missing provider revision as stale", () => {
		const missing = sourceCoverage({
			provider: "UNDERSTAT",
			scope: "CURRENT",
			seasons: [],
			revision: null,
			asOf: null,
			dataStatus: "UNAVAILABLE",
			analysisStatus: "UNAVAILABLE",
			mappingStatus: "UNAVAILABLE",
			reasonCodes: ["UNDERSTAT_CURRENT_NO_SEASON_ROW"],
		});
		const old = sourceCoverage({
			provider: "UNDERSTAT",
			scope: "CURRENT",
			seasons: ["2627"],
			revision: "old-revision",
			asOf: "2020-01-01T00:00:00.000Z",
			dataStatus: "AVAILABLE",
			analysisStatus: "READY",
			mappingStatus: "VERIFIED",
			reasonCodes: [],
		});

		expect(missing.stale).toBe(false);
		expect(old.stale).toBe(true);
	});
});
