import { describe, expect, it } from "bun:test";
import {
	buildPlayerStateProviderRevision,
	playerStateHistoryStorageAvailable,
	resolvePlayerStateMappingStatus,
	type ProviderLinkRow,
} from "../../../src/domains/player-state/coverage";

const link = (status: string, confirmedSeasons: string[] = ["2627"]): ProviderLinkRow => ({
	status,
	rule_version: "player-link-v1",
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
		const missing = buildPlayerStateProviderRevision({
			provider: "UNDERSTAT",
			scope: "CURRENT",
			season: "2627",
			revision: null,
			asOf: null,
			available: false,
		});
		const old = buildPlayerStateProviderRevision({
			provider: "UNDERSTAT",
			scope: "CURRENT",
			season: "2627",
			revision: "old-revision",
			asOf: "2020-01-01T00:00:00.000Z",
			available: true,
		});

		expect(missing.stale).toBe(false);
		expect(old.stale).toBe(true);
	});

	it("requires every FPL history parent before reading sealed cohorts", () => {
		expect(
			playerStateHistoryStorageAvailable({
				playerHistory: "fpl_player_history",
				playerStatHistory: "fpl_player_stat_history",
				eventLiveHistory: "fpl_event_live_history",
			})
		).toBe(true);
		expect(
			playerStateHistoryStorageAvailable({
				playerHistory: "fpl_player_history",
				playerStatHistory: "fpl_player_stat_history",
				eventLiveHistory: null,
			})
		).toBe(false);
		expect(playerStateHistoryStorageAvailable(null)).toBe(false);
	});
});
