import { describe, expect, it } from "bun:test";
import { playersRepository } from "../../../src/domains/players/repository";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const queryChain = <T>(result: T, methods: string[]) => {
	const promise = Promise.resolve(result) as Promise<T> &
		Record<string, (...args: unknown[]) => unknown>;
	for (const method of methods) promise[method] = () => promise;
	return promise;
};

const installPickerDatabase = (
	context: ReturnType<typeof buildSnapshotContext>,
	core: ReturnType<typeof buildTestCoreData>,
	ownershipById: Map<number, number> = new Map()
): (() => number) => {
	let queryCount = 0;
	context.database = {
		query: async (sql: string, values: readonly unknown[] = []) => {
			queryCount += 1;
			const search = typeof values[2] === "string" ? values[2].toLowerCase() : null;
			const position = typeof values[3] === "number" ? values[3] : null;
			const teamId = typeof values[4] === "number" ? values[4] : null;
			const minPrice = typeof values[5] === "number" ? values[5] : null;
			const maxPrice = typeof values[6] === "number" ? values[6] : null;
			const band = typeof values[7] === "string" ? values[7] : null;
			const limit = Number(values[8] ?? 20);
			const offset = Number(values[9] ?? 0);
			const teams = new Map(core.teams.map((team) => [team.id, team] as const));
			const bandMatches = (ownership: number | null): boolean => {
				if (band === null) return true;
				if (ownership === null) return false;
				if (band === "LE5") return ownership <= 5;
				if (band === "GT5_LE15") return ownership > 5 && ownership <= 15;
				if (band === "GT15_LE40") return ownership > 15 && ownership <= 40;
				return ownership > 40;
			};
			const rows = core.players
				.map((player) => ({
					id: player.id,
					web_name: player.webName,
					element_type: player.type,
					team_id: player.teamId,
					team_name: teams.get(player.teamId)?.name ?? "",
					team_short_name: teams.get(player.teamId)?.shortName ?? "",
					price: player.price,
					selected_by_percent: ownershipById.get(player.id) ?? player.selectedByPercent ?? null,
					total_points: player.totalPoints,
					form: null,
				}))
				.filter((row) => search === null || row.web_name.toLowerCase().includes(search))
				.filter((row) => position === null || row.element_type === position)
				.filter((row) => teamId === null || row.team_id === teamId)
				.filter((row) => minPrice === null || row.price >= minPrice)
				.filter((row) => maxPrice === null || row.price <= maxPrice)
				.filter((row) => bandMatches(row.selected_by_percent));
			if (sql.includes("lower(web_name) ASC")) {
				rows.sort((left, right) =>
					left.web_name.localeCompare(right.web_name, "en", { sensitivity: "base" })
				);
			} else if (sql.includes("selected_by_percent DESC")) {
				rows.sort(
					(left, right) => (right.selected_by_percent ?? -1) - (left.selected_by_percent ?? -1)
				);
			} else {
				rows.sort((left, right) => right.total_points - left.total_points);
			}
			return {
				rows: rows.slice(offset, offset + limit).map((row) => ({
					...row,
					total_count: rows.length,
				})),
			};
		},
	} as never;
	return () => queryCount;
};

describe("playersRepository core reads", () => {
	it("pins one immutable core revision per request and exposes a newer revision to a new request", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const firstContext = buildSnapshotContext(redis, { dataRevision: "core-7" });

		expect(await playersRepository.getPlayerById(firstContext, 1)).toMatchObject({
			id: 1,
			price: 45,
		});

		const nextCore = {
			...core,
			players: core.players.map((player) => (player.id === 1 ? { ...player, price: 99 } : player)),
		};
		const nextPublication = buildCorePublication("2627", 8, nextCore);
		for (const [key, value] of nextPublication.store) redis.values.set(key, value);

		expect(await playersRepository.getPlayerById(firstContext, 1)).toMatchObject({ price: 45 });

		const nextContext = buildSnapshotContext(redis, { dataRevision: "core-8" });
		expect(await playersRepository.getPlayerById(nextContext, 1)).toMatchObject({ price: 99 });
		expect(
			await playersRepository.listPlayers(
				nextContext,
				{ teamId: 1, minPrice: 99, maxPrice: 99 },
				10,
				0
			)
		).toMatchObject([{ id: 1, price: 99 }]);
	});

	it("query-caches only the event-stat overlay under the core dataset revision", async () => {
		const core = buildTestCoreData(1);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		let readCount = 0;
		context.data = {
			read: () => {
				readCount += 1;
				return queryChain(
					{ data: [{ total_points: 9, selected_by_percent: "4.2" }], error: null },
					["select", "eq", "limit"]
				);
			},
		} as never;

		const first = await playersRepository.getPlayerByIdForEvent(context, 1, 1);
		const second = await playersRepository.getPlayerByIdForEvent(context, 1, 1);

		expect(first).toMatchObject({ id: 1, price: 45, totalPoints: 9, selectedByPercent: 4.2 });
		expect(second).toEqual(first);
		expect(readCount).toBe(1);
		const cacheWrite = redis.setCalls.find(([key]) => key.includes(":players-event-stats:"));
		expect(cacheWrite?.[0]).toMatch(/^llm:gql:core-7:players-event-stats:/);
		expect(cacheWrite?.slice(-2)).toEqual(["EX", 3600]);
	});
});

describe("playersRepository.getPlayersForPicker", () => {
	it("uses the core publication, reporting stats, and a normally expiring query cache", async () => {
		const core = buildTestCoreData(null);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		const queryCount = installPickerDatabase(context, core, new Map([[1, 74.6]]));

		const first = await playersRepository.getPlayersForPicker(context, 1, null, "Player 1");
		const second = await playersRepository.getPlayersForPicker(context, 1, null, "Player 1");

		expect(first.items).toEqual([
			expect.objectContaining({ id: 1, price: 45, selectedByPercent: 74.6 }),
		]);
		expect(first.totalCount).toBeGreaterThan(first.items.length);
		expect(first.nextCursor).toEqual(expect.any(Number));
		expect(first.nextCursor).toBeLessThan(0);
		expect(second).toEqual(first);
		expect(queryCount()).toBe(1);
		const cacheWrite = redis.setCalls.find(([key]) => key.includes(":players-picker:"));
		expect(cacheWrite?.[0]).toMatch(/^llm:gql:core-7:players-picker:/);
		expect(cacheWrite?.slice(-2)).toEqual(["EX", 300]);
	});

	it("applies the requested sort before taking the page", async () => {
		const core = buildTestCoreData(null, {
			players: buildTestCoreData(null).players.map((player) =>
				player.id === 1
					? { ...player, webName: "Zed Player" }
					: player.id === 2
						? { ...player, webName: "Alpha Player" }
						: player
			),
		});
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		installPickerDatabase(context, core);

		const result = await playersRepository.getPlayersForPicker(
			context,
			1,
			null,
			null,
			null,
			"NAME_ASC"
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ id: 2, webName: "Alpha Player" });
		expect(result.nextCursor).toBeLessThan(0);

		const nextPage = await playersRepository.getPlayersForPicker(
			context,
			1,
			result.nextCursor,
			null,
			null,
			"NAME_ASC"
		);
		// The cursor encodes the next offset and selected sort; it must not depend on player IDs.
		expect(nextPage.items[0]).toMatchObject({ id: 10, webName: "Player 10" });
		const thirdPage = await playersRepository.getPlayersForPicker(
			context,
			1,
			nextPage.nextCursor,
			null,
			null,
			"NAME_ASC"
		);
		expect(thirdPage.items[0]).toMatchObject({ id: 100, webName: "Player 100" });
		let cursorForPage = thirdPage.nextCursor;
		let foundZed = thirdPage.items.some((item) => item.id === 1);
		for (
			let pageNumber = 0;
			pageNumber < 20 && cursorForPage !== null && !foundZed;
			pageNumber += 1
		) {
			const page = await playersRepository.getPlayersForPicker(
				context,
				200,
				cursorForPage,
				null,
				null,
				"NAME_ASC"
			);
			foundZed = page.items.some((item) => item.id === 1 && item.webName === "Zed Player");
			cursorForPage = page.nextCursor;
		}
		expect(foundZed).toBe(true);

		await expect(
			playersRepository.getPlayersForPicker(context, 1, 1, null, null, "NAME_ASC")
		).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
	});

	it("applies ownership bands before counting and paginating", async () => {
		const baseline = buildTestCoreData(null);
		const ownershipById = new Map([
			[1, 5],
			[2, 5.1],
			[3, 15],
			[4, 15.1],
			[5, 40],
			[6, 40.1],
		]);
		const core = buildTestCoreData(null, {
			players: baseline.players.map((player) => ({
				...player,
				selectedByPercent: ownershipById.get(player.id) ?? null,
			})),
		});
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		installPickerDatabase(context, core, ownershipById);

		const expectedIds = {
			LE5: [1],
			GT5_LE15: [2, 3],
			GT15_LE40: [4, 5],
			GT40: [6],
		} as const;
		for (const [band, ids] of Object.entries(expectedIds)) {
			const result = await playersRepository.getPlayersForPicker(
				context,
				20,
				null,
				null,
				null,
				"NAME_ASC",
				band as keyof typeof expectedIds
			);
			expect(result.items.map((item) => item.id).sort((left, right) => left - right)).toEqual([
				...ids,
			]);
			expect(result.totalCount).toBe(ids.length);
			expect(result.nextCursor).toBeNull();
		}
	});
});

describe("playersRepository top transfers", () => {
	it("returns no rows when every event transfer count is zero", async () => {
		const queryResult = {
			data: [
				{
					element_id: 1,
					event_id: 1,
					transfers_in_event: 0,
					transfers_out_event: 0,
				},
			],
			error: null,
		};
		const builder = {
			select: () => builder,
			eq: () => builder,
			not: () => builder,
			order: () => builder,
			limit: async () => queryResult,
		};
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-7",
			data: { read: () => builder },
			logger: { error: () => undefined },
		} as never;

		expect(await playersRepository.getTopTransfersInEnriched(context, 1, 10)).toEqual({
			stats: [],
			players: {},
		});
		expect(await playersRepository.getTopTransfersOutEnriched(context, 1, 10)).toEqual({
			stats: [],
			players: {},
		});
	});
});
