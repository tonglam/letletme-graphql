import { afterEach, describe, expect, it } from "bun:test";
import type { EntryEventResult } from "../../../src/domains/entries/repository";
import { entriesRepository } from "../../../src/domains/entries/repository";
import { entriesService } from "../../../src/domains/entries/service";
import {
	type EntryEventTransferRow,
	entryLiveRepository,
} from "../../../src/domains/entry-live/repository";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const liveRow = (eventId: number, elementId: number, totalPoints: number, minutes: number) => ({
	event_id: eventId,
	element_id: elementId,
	minutes,
	goals_scored: 0,
	assists: 0,
	clean_sheets: 0,
	goals_conceded: 0,
	own_goals: 0,
	penalties_saved: 0,
	penalties_missed: 0,
	yellow_cards: 0,
	red_cards: 0,
	saves: 0,
	bonus: 0,
	bps: 0,
	starts: minutes > 0,
	defensive_contribution: 0,
	expected_goals: "0.00",
	expected_assists: "0.00",
	expected_goal_involvements: "0.00",
	expected_goals_conceded: "0.00",
	in_dream_team: false,
	total_points: totalPoints,
});

const makeContext = (
	core: ReturnType<typeof buildTestCoreData>,
	liveRows: Array<ReturnType<typeof liveRow>>,
	fixtureTeamRows: Array<{
		event_id: number;
		element_id: number;
		fixture_id?: number;
		team_id: number;
	}> = [],
	fixtureTeamError: Error | null = null
): GraphQLContext => {
	const context = buildSnapshotContext(new TestRedis(buildCorePublication("2526", 7, core)), {
		seasonId: 2025,
		seasonCode: "2526",
		dataRevision: "core-7",
	});
	context.data = {
		read: (table: string) => {
			if (table !== "fpl.player_gameweek_stats" && table !== "fpl.player_fixture_stats") {
				throw new Error(`Unexpected read model ${table}`);
			}
			const promise = Promise.resolve({
				data: table === "fpl.player_fixture_stats" ? fixtureTeamRows : liveRows,
				error: table === "fpl.player_fixture_stats" ? fixtureTeamError : null,
			});
			type Builder = typeof promise & {
				select: () => Builder;
				in: () => Builder;
				eq: () => Builder;
				order: () => Builder;
			};
			const builder = promise as Builder;
			Object.assign(builder, {
				select: () => builder,
				in: () => builder,
				eq: () => builder,
				order: () => builder,
			});
			return builder;
		},
	} as never;
	return context;
};

describe("entriesService.getEntryTransferHistory", () => {
	it("joins canonical transfers with the core revision and historical live facts", async () => {
		const originalGetEntryTransferHistory = entryLiveRepository.getEntryTransferHistory;
		const transferRows: EntryEventTransferRow[] = [
			{
				entryId: 84885,
				eventId: 12,
				elementIn: 1,
				elementInCost: 85,
				elementOut: 12,
				elementOutCost: 125,
				time: "2026-01-01T00:00:00Z",
			},
		];
		entryLiveRepository.getEntryTransferHistory = async (): Promise<EntryEventTransferRow[]> =>
			transferRows;

		const base = buildTestCoreData(12);
		const core = {
			...base,
			teams: base.teams.map((team) =>
				team.id === 1
					? { ...team, name: "Arsenal", shortName: "ARS" }
					: team.id === 2
						? { ...team, name: "Liverpool", shortName: "LIV" }
						: team
			),
			players: base.players.map((player) =>
				player.id === 1
					? { ...player, webName: "Saka", type: 3, code: 101, price: 75 }
					: player.id === 12
						? { ...player, webName: "Salah", type: 3, code: 102, price: 130 }
						: player
			),
		};
		const context = makeContext(core, [liveRow(12, 1, 8, 90), liveRow(12, 12, 2, 0)]);

		try {
			const result = await entriesService.getEntryTransferHistory(context, 84885, true);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({ eventId: 12, eventTransfers: 1, eventTransfersCost: 0 });
			expect(result[0].transfers[0]).toMatchObject({
				elementInWebName: "Saka",
				elementInCost: 8.5,
				elementInTeamShortName: "ARS",
				elementInPoints: 8,
				elementInPlayed: true,
				elementOutWebName: "Salah",
				elementOutCost: 12.5,
				elementOutTeamShortName: "LIV",
				elementOutPoints: 2,
			});
		} finally {
			entryLiveRepository.getEntryTransferHistory = originalGetEntryTransferHistory;
		}
	});
});

describe("entriesService.getEntryEventPicks", () => {
	it("enriches compact picks from the core revision and historical live facts", async () => {
		const eventResult: EntryEventResult = {
			entryId: 84885,
			eventId: 34,
			eventPoints: 65,
			eventRank: 1000,
			overallPoints: 1900,
			overallRank: 2000,
			eventTransfers: 1,
			eventTransfersCost: 0,
			eventNetPoints: 65,
			eventBenchPoints: 6,
			eventChip: null,
			eventPlayedCaptain: 4,
			eventCaptainPoints: 20,
			eventPicks: [
				{
					element: 4,
					position: 7,
					multiplier: 2,
					is_captain: true,
					is_vice_captain: false,
				},
				{
					element: 1,
					position: 12,
					multiplier: 0,
					is_captain: false,
					is_vice_captain: false,
				},
			],
			teamValue: 1020,
			bank: 5,
		};
		const base = buildTestCoreData(34);
		const core = {
			...base,
			teams: base.teams.map((team) =>
				team.id === 1 ? { ...team, name: "Arsenal", shortName: "ARS" } : team
			),
			players: base.players.map((player) =>
				player.id === 4
					? { ...player, webName: "Gyokeres", type: 4, code: 449, price: 75 }
					: player.id === 1
						? { ...player, webName: "Dubravka", type: 1, code: 470, price: 50 }
						: player
			),
		};
		const context = makeContext(
			core,
			[liveRow(34, 4, 10, 90), liveRow(34, 1, 2, 0)],
			[
				{ event_id: 34, element_id: 4, team_id: 1 },
				{ event_id: 34, element_id: 1, team_id: 1 },
			]
		);

		const result = await entriesService.getEntryEventPicks(context, eventResult);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			webName: "Gyokeres",
			teamShortName: "ARS",
			teamName: "Arsenal",
			elementTypeName: "FWD",
			isCaptain: true,
			isViceCaptain: false,
			multiplier: 2,
			totalPoints: 10,
			minutes: 90,
			position: 7,
		});
		expect(result[1]).toMatchObject({
			webName: "Dubravka",
			elementTypeName: "GKP",
			totalPoints: 2,
			minutes: 0,
			position: 12,
		});
	});

	it("uses the player team from the requested event when enriching historical fixtures", async () => {
		const base = buildTestCoreData(34);
		const targetFixture = base.fixtures.find(
			(fixture) => fixture.eventId === 34 && (fixture.teamHId === 2 || fixture.teamAId === 2)
		);
		if (!targetFixture) throw new Error("Test fixture not found");
		const core = {
			...base,
			fixtures: base.fixtures.map((fixture) =>
				fixture.id === targetFixture.id
					? { ...fixture, finished: true, started: true, minutes: 90, teamHScore: 1, teamAScore: 0 }
					: fixture
			),
		};
		const context = makeContext(
			core,
			[liveRow(34, 4, 10, 90)],
			[{ event_id: 34, element_id: 4, team_id: 2 }]
		);
		const wasHome = targetFixture.teamHId === 2;
		const opponentId = wasHome ? targetFixture.teamAId : targetFixture.teamHId;
		const score = wasHome ? "1-0" : "0-1";

		const result = await entriesService.getEntryEventPicks(context, {
			entryId: 84885,
			eventId: 34,
			eventPoints: 10,
			eventRank: 1,
			overallPoints: 10,
			overallRank: 1,
			eventTransfers: 0,
			eventTransfersCost: 0,
			eventNetPoints: 10,
			eventBenchPoints: 0,
			eventChip: null,
			eventPlayedCaptain: 4,
			eventCaptainPoints: 10,
			eventPicks: [{ element: 4, position: 1, multiplier: 2, is_captain: true }],
			teamValue: 1000,
			bank: 0,
		});

		expect(result[0]).toMatchObject({
			teamId: 2,
			teamShortName: "T02",
			againstId: opponentId,
			wasHome: wasHome ? "H" : "A",
			score,
			bgw: false,
			dgw: false,
		});
	});

	it("does not attach the current club to a historical blank gameweek", async () => {
		const base = buildTestCoreData(34);
		const currentClubFixture = base.fixtures.find(
			(fixture) => fixture.eventId === 34 && (fixture.teamHId === 2 || fixture.teamAId === 2)
		);
		if (!currentClubFixture) throw new Error("Current club fixture not found");
		const core = {
			...base,
			players: base.players.map((player) =>
				player.id === 4
					? { ...player, teamId: 2 }
					: player.id === 12
						? { ...player, teamId: 1 }
						: player
			),
		};
		const context = makeContext(core, [liveRow(34, 4, 10, 90)]);

		const result = await entriesService.getEntryEventPicks(context, {
			entryId: 84885,
			eventId: 34,
			eventPoints: 10,
			eventRank: 1,
			overallPoints: 10,
			overallRank: 1,
			eventTransfers: 0,
			eventTransfersCost: 0,
			eventNetPoints: 10,
			eventBenchPoints: 0,
			eventChip: null,
			eventPlayedCaptain: 4,
			eventCaptainPoints: 10,
			eventPicks: [{ element: 4, position: 1, multiplier: 2, is_captain: true }],
			teamValue: 1000,
			bank: 0,
		});

		expect(result[0]).toMatchObject({
			teamId: 0,
			againstName: "BLANK",
			againstShortName: "BLANK",
			wasHome: "",
			score: "",
			bgw: true,
		});
	});

	it("uses kickoff order for a double gameweek team lookup", async () => {
		const base = buildTestCoreData(34);
		const originalFixture = base.fixtures.find(
			(fixture) => fixture.eventId === 34 && (fixture.teamHId === 2 || fixture.teamAId === 2)
		);
		const movedFixture = base.fixtures.find(
			(fixture) => fixture.eventId === 35 && (fixture.teamHId === 2 || fixture.teamAId === 2)
		);
		if (!originalFixture || !movedFixture) throw new Error("DGW fixture not found");
		const firstKickoff = "2026-01-01T12:00:00.000Z";
		const secondKickoff = "2026-01-01T20:00:00.000Z";
		const core = {
			...base,
			fixtures: base.fixtures.map((fixture) =>
				fixture.id === originalFixture.id
					? { ...fixture, kickoffTime: firstKickoff }
					: fixture.id === movedFixture.id
						? { ...fixture, eventId: 34, kickoffTime: secondKickoff }
						: fixture
			),
		};
		const context = makeContext(
			core,
			[liveRow(34, 4, 10, 90)],
			[
				{ event_id: 34, element_id: 4, fixture_id: movedFixture.id, team_id: 4 },
				{ event_id: 34, element_id: 4, fixture_id: originalFixture.id, team_id: 2 },
			]
		);

		const result = await entriesService.getEntryEventPicks(context, {
			entryId: 84885,
			eventId: 34,
			eventPoints: 10,
			eventRank: 1,
			overallPoints: 10,
			overallRank: 1,
			eventTransfers: 0,
			eventTransfersCost: 0,
			eventNetPoints: 10,
			eventBenchPoints: 0,
			eventChip: null,
			eventPlayedCaptain: 4,
			eventCaptainPoints: 10,
			eventPicks: [{ element: 4, position: 1, multiplier: 2, is_captain: true }],
			teamValue: 1000,
			bank: 0,
		});

		expect(result[0]).toMatchObject({ teamId: 2, dgw: true });
	});

	it("keeps event fixtures when current player metadata is missing", async () => {
		const base = buildTestCoreData(34);
		const targetFixture = base.fixtures.find(
			(fixture) => fixture.eventId === 34 && (fixture.teamHId === 2 || fixture.teamAId === 2)
		);
		if (!targetFixture) throw new Error("Historical fixture not found");
		const context = makeContext(
			base,
			[liveRow(34, 999, 10, 90)],
			[{ event_id: 34, element_id: 999, fixture_id: targetFixture.id, team_id: 2 }]
		);
		const wasHome = targetFixture.teamHId === 2;
		const opponentId = wasHome ? targetFixture.teamAId : targetFixture.teamHId;

		const result = await entriesService.getEntryEventPicks(context, {
			entryId: 84885,
			eventId: 34,
			eventPoints: 10,
			eventRank: 1,
			overallPoints: 10,
			overallRank: 1,
			eventTransfers: 0,
			eventTransfersCost: 0,
			eventNetPoints: 10,
			eventBenchPoints: 0,
			eventChip: null,
			eventPlayedCaptain: 999,
			eventCaptainPoints: 10,
			eventPicks: [{ element: 999, position: 1, multiplier: 2, is_captain: true }],
			teamValue: 1000,
			bank: 0,
		});

		expect(result[0]).toMatchObject({
			element: 999,
			teamId: 2,
			againstId: opponentId,
			bgw: false,
		});
	});

	it("fails closed when event-scoped team data is unavailable", async () => {
		const core = buildTestCoreData(34);
		const fixtureTeamError = new Error("fixture stats unavailable");
		const context = makeContext(core, [liveRow(34, 4, 10, 90)], [], fixtureTeamError);

		await expect(
			entriesService.getEntryEventPicks(context, {
				entryId: 84885,
				eventId: 34,
				eventPoints: 10,
				eventRank: 1,
				overallPoints: 10,
				overallRank: 1,
				eventTransfers: 0,
				eventTransfersCost: 0,
				eventNetPoints: 10,
				eventBenchPoints: 0,
				eventChip: null,
				eventPlayedCaptain: 4,
				eventCaptainPoints: 10,
				eventPicks: [{ element: 4, position: 1, multiplier: 2, is_captain: true }],
				teamValue: 1000,
				bank: 0,
			})
		).rejects.toMatchObject({
			message: "Failed to load event-scoped player teams",
			cause: fixtureTeamError,
		});
	});
});

describe("entriesService.getEntrySnapshot", () => {
	const originalGetEntrySnapshotById = entriesRepository.getEntrySnapshotById;
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		entriesRepository.getEntrySnapshotById = originalGetEntrySnapshotById;
		globalThis.fetch = originalFetch;
	});

	it("delegates only to the persisted repository path", async () => {
		let requestedId = 0;
		entriesRepository.getEntrySnapshotById = async (_context, id) => {
			requestedId = id;
			return null;
		};
		globalThis.fetch = (async () => {
			throw new Error("FPL must not be called");
		}) as unknown as typeof fetch;

		const result = await entriesService.getEntrySnapshot({} as GraphQLContext, 424242);

		expect(result).toBeNull();
		expect(requestedId).toBe(424242);
	});
});

describe("entriesService.getEntryById", () => {
	const originalGetEntryById = entriesRepository.getEntryById;
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		entriesRepository.getEntryById = originalGetEntryById;
		globalThis.fetch = originalFetch;
	});

	it("returns the stored row without calling FPL", async () => {
		entriesRepository.getEntryById = async () => ({
			id: 101,
			entryName: "Stored",
			playerName: "Manager",
			region: null,
			startedEvent: 1,
			overallPoints: 10,
			overallRank: 20,
			bank: 1,
			teamValue: 1000,
			totalTransfers: 0,
			lastEventId: 1,
			lastOverallPoints: 10,
			lastOverallRank: 20,
			lastTeamValue: 1000,
			lastBank: 1,
		});
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("unused", { status: 500 });
		}) as unknown as typeof fetch;

		const entry = await entriesService.getEntryById({} as GraphQLContext, 101);
		expect(entry?.entryName).toBe("Stored");
		expect(fetched).toBe(false);
	});

	it("falls back to FPL and caches the live summary when the row is missing", async () => {
		entriesRepository.getEntryById = async () => null;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					id: 424242,
					name: "Let Let Me",
					player_first_name: "Tong",
					player_last_name: "Lam",
					summary_overall_points: 80,
					summary_overall_rank: 100,
				}),
				{ status: 200 }
			)) as unknown as typeof fetch;

		const written: Array<{ key: string; value: string; ttl: number }> = [];
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-17",
			redis: {
				set: async (key: string, value: string, mode: string, ttl: number) => {
					expect(mode).toBe("EX");
					written.push({ key, value, ttl });
					return "OK";
				},
			},
			logger: { warn: () => undefined },
		} as unknown as GraphQLContext;

		const entry = await entriesService.getEntryById(context, 424242);
		expect(entry?.entryName).toBe("Let Let Me");
		expect(entry?.playerName).toBe("Tong Lam");
		expect(written).toHaveLength(1);
		expect(written[0]?.key.startsWith("llm:gql:core-17:entries-info:")).toBe(true);
		expect(JSON.parse(written[0]?.value ?? "{}")).toMatchObject({
			id: 424242,
			entryName: "Let Let Me",
		});
	});

	it("writes a short negative cache only for a real FPL 404", async () => {
		entriesRepository.getEntryById = async () => null;
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches += 1;
			return new Response("missing", { status: 404 });
		}) as unknown as typeof fetch;
		const values = new Map<string, string>();
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-negative",
			redis: {
				get: async (key: string) => values.get(key) ?? null,
				set: async (key: string, value: string, _mode: string, ttl: number) => {
					values.set(key, value);
					expect(ttl).toBe(60);
					return "OK";
				},
				del: async () => 0,
			},
			logger: { warn: () => undefined },
		} as unknown as GraphQLContext;
		expect(await entriesService.getEntryById(context, 515151)).toBeNull();
		expect(await entriesService.getEntryById(context, 515151)).toBeNull();
		expect(fetches).toBe(1);
	});

	it("does not cache transient FPL failures and caps distinct admissions at eight", async () => {
		entriesRepository.getEntryById = async () => null;
		let fetches = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		globalThis.fetch = (async () => {
			fetches += 1;
			await gate;
			return new Response("busy", { status: 503 });
		}) as unknown as typeof fetch;
		const values = new Map<string, string>();
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-saturated",
			redis: {
				get: async (key: string) => values.get(key) ?? null,
				set: async (key: string, value: string) => {
					values.set(key, value);
					return "OK";
				},
				del: async () => 0,
			},
			logger: { warn: () => undefined },
		} as unknown as GraphQLContext;
		const calls = Array.from({ length: 10 }, (_, index) =>
			entriesService.getEntryById(context, 620000 + index)
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetches).toBe(8);
		release();
		expect((await Promise.all(calls)).every((entry) => entry === null)).toBe(true);
	});
});
