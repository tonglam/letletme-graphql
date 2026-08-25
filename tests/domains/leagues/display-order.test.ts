import { describe, expect, it } from "bun:test";
import {
	LeagueScoring,
	OfficialLeagueKind,
	compareLeaguesForOfficialDisplay,
	mapFplOfficialKind,
	selectHomeLeagues,
	sortLeaguesForOfficialDisplay,
} from "../../../src/domains/leagues/display-order";

const league = (
	name: string,
	kind: OfficialLeagueKind,
	scoring: LeagueScoring = LeagueScoring.CLASSIC,
	shortName: string | null = null
) => ({ name, officialKind: kind, scoring, shortName });

describe("official FPL league display order", () => {
	it("maps only the FPL s/x categories", () => {
		expect(mapFplOfficialKind("s")).toBe(OfficialLeagueKind.SYSTEM);
		expect(mapFplOfficialKind("x")).toBe(OfficialLeagueKind.INVITATIONAL);
		expect(mapFplOfficialKind("c")).toBeNull();
		expect(mapFplOfficialKind(null)).toBeNull();
	});

	it("sorts invitational classic names with localeCompare en", () => {
		const names = [
			"这破游戏⚽让让群大乱斗(25/26)",
			"FPL Pod",
			"2627平超联赛",
			"@OfficialFPL on X",
			"guazhang可能要鸽",
			"♪ü♪让让群联赛10周年",
			"FALEAGUE 26/27",
			"笑谈范特西英超联赛",
			"E1⚽FPL Championship Cup S2",
			"FPL中国官方联赛",
		];
		const sorted = sortLeaguesForOfficialDisplay(
			names.map((name) => league(name, OfficialLeagueKind.INVITATIONAL))
		).map((item) => item.name);
		expect(sorted).toEqual([
			"@OfficialFPL on X",
			"♪ü♪让让群联赛10周年",
			"2627平超联赛",
			"E1⚽FPL Championship Cup S2",
			"FALEAGUE 26/27",
			"FPL Pod",
			"FPL中国官方联赛",
			"guazhang可能要鸽",
			"笑谈范特西英超联赛",
			"这破游戏⚽让让群大乱斗(25/26)",
		]);
	});

	it("uses the official mobile My Leagues group order", () => {
		const sorted = sortLeaguesForOfficialDisplay([
			league("Overall", OfficialLeagueKind.SYSTEM, LeagueScoring.CLASSIC, "overall"),
			league("Australia", OfficialLeagueKind.SYSTEM, LeagueScoring.CLASSIC, "region-241"),
			league("让让群10周年瑞士轮", OfficialLeagueKind.INVITATIONAL, LeagueScoring.H2H),
			league("Friends League", OfficialLeagueKind.INVITATIONAL),
			league("Stan Sport League", OfficialLeagueKind.SYSTEM, LeagueScoring.CLASSIC, "brd-stan"),
		]);
		expect(sorted.map((item) => item.name)).toEqual([
			"Stan Sport League",
			"Friends League",
			"让让群10周年瑞士轮",
			"Australia",
			"Overall",
		]);
	});

	it("treats missing official kind with a short_name as system", () => {
		const overall = {
			name: "Overall",
			officialKind: null,
			scoring: LeagueScoring.CLASSIC,
			shortName: "overall",
		};
		const privateLeague = {
			name: "Office League",
			officialKind: null,
			scoring: LeagueScoring.CLASSIC,
			shortName: null,
		};
		expect(compareLeaguesForOfficialDisplay(privateLeague, overall)).toBeLessThan(0);
	});

	it("keeps private and system leagues while excluding unknown categories", () => {
		const preview = selectHomeLeagues([
			league("Overall", OfficialLeagueKind.SYSTEM, LeagueScoring.CLASSIC, "overall"),
			league("Stan Sport League", OfficialLeagueKind.SYSTEM, LeagueScoring.CLASSIC, "brd-stan"),
			league("Office League", OfficialLeagueKind.INVITATIONAL),
			league("Friends League", OfficialLeagueKind.INVITATIONAL),
			league("H2H Cup", OfficialLeagueKind.INVITATIONAL, LeagueScoring.H2H),
			{
				name: "Legacy c League",
				officialKind: null,
				scoring: LeagueScoring.CLASSIC,
				shortName: "legacy-c",
			},
		]);
		expect(preview.map((item) => item.name)).toEqual([
			"Friends League",
			"Office League",
			"Overall",
			"Stan Sport League",
			"H2H Cup",
		]);
	});
});
