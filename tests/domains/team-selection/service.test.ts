import { describe, expect, it } from "bun:test";
import type { CoreDataSnapshot } from "../../../src/infra/data-snapshot";
import {
	teamSelectionService,
	teamSelectionTestables,
} from "../../../src/domains/team-selection/service";
import {
	buildSnapshotContext,
	buildCorePublication,
	buildTestCoreData,
	createTestPublication,
	TestRedis,
} from "../../helpers/data-publication";

const baseEvent = (overrides: Record<string, unknown> = {}) =>
	({
		id: 1,
		name: "Gameweek 1",
		deadlineTime: "2099-01-01T00:00:00.000Z",
		finished: false,
		...overrides,
	}) as CoreDataSnapshot["events"][number];

const snapshot = (overrides: Record<string, unknown> = {}) =>
	({
		source: "redis",
		seasonCode: "2627",
		revision: "core-1",
		publicationId: "publication-1",
		sourceCheckedAt: "2026-08-20T00:00:00.000Z",
		currentEventId: null,
		events: [baseEvent()],
		teams: [],
		players: [],
		phases: [],
		fixtures: [],
		...overrides,
	}) as CoreDataSnapshot;

describe("Team Selection desk policy", () => {
	it("distinguishes preseason, live, settled, and unavailable phases", () => {
		expect(
			teamSelectionTestables.phaseFor(baseEvent(), snapshot(), 1, Date.parse("2028-01-01"))
		).toBe("PRESEASON");
		expect(
			teamSelectionTestables.phaseFor(
				baseEvent({ deadlineTime: "2020-01-01T00:00:00.000Z" }),
				snapshot({ currentEventId: 1 }),
				1,
				Date.parse("2028-01-01")
			)
		).toBe("LIVE");
		expect(
			teamSelectionTestables.phaseFor(
				baseEvent({ finished: true }),
				snapshot({ currentEventId: 2, events: [baseEvent({ finished: true })] }),
				1,
				Date.now()
			)
		).toBe("SETTLED");
		expect(
			teamSelectionTestables.phaseFor(
				baseEvent({ finished: false, deadlineTime: null }),
				snapshot({ currentEventId: 2 }),
				1,
				Date.now()
			)
		).toBe("UNAVAILABLE");
	});

	it("keeps official position names stable for the GraphQL contract", () => {
		expect([1, 2, 3, 4].map(teamSelectionTestables.positionName)).toEqual([
			"GOALKEEPER",
			"DEFENDER",
			"MIDFIELDER",
			"FORWARD",
		]);
	});

	it("builds a bounded desk from the pinned core and market snapshot", async () => {
		const core = buildTestCoreData(1);
		const rules = {
			squadSize: 15,
			startingSize: 11,
			budget: 1000,
			maxPlayersPerTeam: 3,
			currencyMultiplier: 10,
			positions: [
				{ id: 1, name: "Goalkeeper", shortName: "GKP", squadSelect: 2, minPlay: 1, maxPlay: 1 },
				{ id: 2, name: "Defender", shortName: "DEF", squadSelect: 5, minPlay: 3, maxPlay: 5 },
				{ id: 3, name: "Midfielder", shortName: "MID", squadSelect: 5, minPlay: 2, maxPlay: 5 },
				{ id: 4, name: "Forward", shortName: "FWD", squadSelect: 3, minPlay: 1, maxPlay: 3 },
			],
			chips: [],
		};
		const basePublication = buildCorePublication("2627", 9, core);
		const redis = new TestRedis(
			createTestPublication({ dataset: "fpl:core", seasonCode: "2627" }, 9, {
				...basePublication.values,
				selectionRules: rules,
			})
		);
		const player = core.players[0]!;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async (sql) => {
				if (String(sql).includes("latest_date")) {
					return {
						rows: [
							{
								snapshot_date: "2026-08-20",
								captured_at: "2026-08-20T01:00:00.000Z",
								row_count: 1,
								capture_count: 1,
							},
						],
					};
				}
				if (String(sql).includes("DISTINCT ON (element_id)")) {
					return {
						rows: [
							{
								element_id: player.id,
								price: 99,
								selected_by_percent: 12,
								status: "a",
								news: "",
								chance_of_playing_this_round: 100,
							},
						],
					};
				}
				return { rows: [] };
			},
		});
		const result = await teamSelectionService.getTeamSelectionDesk(context, 1, 2);
		expect(result).toMatchObject({
			phase: "LIVE",
			eventId: 1,
			horizon: 2,
			marketRevision: "pg-1787187600000",
			rules,
		});
		expect(result.players.find((candidate) => candidate.id === player.id)).toMatchObject({
			price: 99,
			status: "a",
		});
		expect(result.fixtures.length).toBeGreaterThan(0);
	});

	it("returns an honest unavailable rules section when rules are missing", async () => {
		const core = buildTestCoreData(2);
		const basePublication = buildCorePublication("2627", 10, core);
		const redis = new TestRedis(
			createTestPublication({ dataset: "fpl:core", seasonCode: "2627" }, 10, {
				...basePublication.values,
				selectionRules: null,
			})
		);
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				throw new Error("market unavailable");
			},
		});
		const result = await teamSelectionService.getTeamSelectionDesk(context, 1, 1);
		expect(result.rules).toBeNull();
		expect(result.rulesSection).toMatchObject({
			state: "UNAVAILABLE",
		});
		expect(result.playerPool).toMatchObject({
			state: "AVAILABLE",
		});
	});
});
