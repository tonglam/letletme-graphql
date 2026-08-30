import { describe, expect, it } from "bun:test";
import {
	buildTrendTemplate,
	type TrendTemplateCandidate,
} from "../../../src/domains/trends/template";

const player = (
	elementId: number,
	playerPosition: number,
	teamShortName: string,
	count: number,
	roles: Pick<TrendTemplateCandidate, "captainCount" | "viceCaptainCount"> = {
		captainCount: 0,
		viceCaptainCount: 0,
	}
): TrendTemplateCandidate => ({
	elementId,
	playerName: `Player ${elementId}`,
	playerPosition,
	teamShortName,
	count,
	percentage: null,
	...roles,
});

describe("buildTrendTemplate", () => {
	it("builds a valid highest-ownership squad with starters, bench, and roles", () => {
		const candidates = [
			player(1, 1, "ARS", 100, { captainCount: 20, viceCaptainCount: 2 }),
			player(2, 1, "BHA", 99, { captainCount: 19, viceCaptainCount: 3 }),
			player(3, 1, "BRE", 98, { captainCount: 18, viceCaptainCount: 4 }),
			player(4, 2, "ARS", 97, { captainCount: 100, viceCaptainCount: 10 }),
			player(5, 2, "ARS", 96),
			player(6, 2, "ARS", 95),
			player(7, 2, "BHA", 94, { captainCount: 50, viceCaptainCount: 100 }),
			player(8, 2, "BHA", 93),
			player(9, 2, "BRE", 92),
			player(10, 2, "BRE", 91),
			player(11, 2, "CHE", 90),
			player(12, 2, "CHE", 89),
			player(13, 2, "LIV", 88),
			player(14, 3, "ARS", 87),
			player(15, 3, "ARS", 86),
			player(16, 3, "BHA", 85),
			player(17, 3, "BHA", 84),
			player(18, 3, "BRE", 83),
			player(19, 3, "BRE", 82),
			player(20, 3, "CHE", 81),
			player(21, 3, "CHE", 80),
			player(22, 3, "LIV", 79),
			player(23, 4, "ARS", 78),
			player(24, 4, "BHA", 77),
			player(25, 4, "BRE", 76),
			player(26, 4, "CHE", 75),
			player(27, 4, "LIV", 74),
		];

		const rows = buildTrendTemplate(candidates);
		expect(rows).toHaveLength(15);

		const starters = rows!.slice(0, 11);
		const bench = rows!.slice(11);
		expect(starters).toHaveLength(11);
		expect(bench).toHaveLength(4);
		expect(new Set(rows!.map((row) => row.elementId)).size).toBe(15);
		expect(starters.filter((row) => row.playerPosition === 1)).toHaveLength(1);
		expect(starters.filter((row) => row.playerPosition === 2).length).toBeGreaterThanOrEqual(3);
		expect(starters.filter((row) => row.playerPosition === 3).length).toBeGreaterThanOrEqual(2);
		expect(starters.filter((row) => row.playerPosition === 4).length).toBeGreaterThanOrEqual(1);

		const teamCounts = new Map<string, number>();
		for (const row of rows!)
			teamCounts.set(row.teamShortName, (teamCounts.get(row.teamShortName) ?? 0) + 1);
		expect(Math.max(...teamCounts.values())).toBeLessThanOrEqual(3);
		expect(rows!.filter((row) => row.isCaptain)).toHaveLength(1);
		expect(rows!.filter((row) => row.isViceCaptain)).toHaveLength(1);
		expect(rows!.find((row) => row.isCaptain)?.elementId).toBe(4);
		expect(rows!.find((row) => row.isViceCaptain)?.elementId).toBe(7);
	});

	it("returns null when the candidate pool cannot satisfy FPL squad quotas", () => {
		const candidates = [
			player(1, 1, "ARS", 100),
			player(2, 2, "ARS", 90),
			player(3, 3, "ARS", 80),
			player(4, 4, "ARS", 70),
		];

		expect(buildTrendTemplate(candidates)).toBeNull();
	});

	it("keeps the stronger duplicate candidate row deterministically", () => {
		const positions = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
		const candidates = positions.map((position, index) =>
			player(index + 1, position, `T${index % 5}`, 100 - index)
		);
		candidates.push(player(1, 1, "T0", 1, { captainCount: 999, viceCaptainCount: 999 }));

		const rows = buildTrendTemplate(candidates);

		expect(rows).toHaveLength(15);
		expect(rows?.find((row) => row.elementId === 1)?.count).toBe(100);
	});
});
