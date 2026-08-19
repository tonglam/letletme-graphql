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
	liveRows: Array<ReturnType<typeof liveRow>>
): GraphQLContext => {
	const context = buildSnapshotContext(new TestRedis(buildCorePublication("2526", 7, core)), {
		seasonId: 2025,
		seasonCode: "2526",
		dataRevision: "core-7",
	});
	context.data = {
		read: (table: string) => {
			if (table !== "fpl.player_gameweek_stats") {
				throw new Error(`Unexpected read model ${table}`);
			}
			const promise = Promise.resolve({ data: liveRows, error: null });
			type Builder = typeof promise & { select: () => Builder; in: () => Builder };
			const builder = promise as Builder;
			Object.assign(builder, { select: () => builder, in: () => builder });
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
		const context = makeContext(core, [liveRow(34, 4, 10, 90), liveRow(34, 1, 2, 0)]);

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
});
