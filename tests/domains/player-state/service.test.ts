import { describe, expect, it } from "bun:test";
import { applyRefreshedCurrentSeason } from "../../../src/domains/player-state/service";

describe("player-state season refresh", () => {
	it("keeps the request season identity pinned when the authority advances", () => {
		const current = Object.freeze({
			seasonId: 2025,
			seasonCode: "2526",
			lifecycleState: "preseason" as const,
		});
		const refreshed = Object.freeze({
			seasonId: 2026,
			seasonCode: "2627",
			lifecycleState: "active" as const,
		});

		expect(applyRefreshedCurrentSeason(current, refreshed)).toBe(current);
	});

	it("updates only lifecycle for the pinned season", () => {
		const current = Object.freeze({
			seasonId: 2025,
			seasonCode: "2526",
			lifecycleState: "preseason" as const,
		});
		const refreshed = Object.freeze({
			seasonId: 2025,
			seasonCode: "2526",
			lifecycleState: "active" as const,
		});

		expect(applyRefreshedCurrentSeason(current, refreshed)).toEqual({
			seasonId: 2025,
			seasonCode: "2526",
			lifecycleState: "active",
		});
	});
});
