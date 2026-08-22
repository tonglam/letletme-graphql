import { describe, expect, it } from "bun:test";
import { GraphQLError } from "graphql";
import {
	createMyFplRepository,
	myFplTestables,
	type MyFplRepository,
	type MyFplRepositoryDependencies,
	type MyFplReviewState,
	type MyFplTeamHistoryRow,
	type MyFplCompetitionAggregate,
} from "../../../src/domains/my-fpl/repository";
import { createMyFplResolvers } from "../../../src/domains/my-fpl/resolvers";
import {
	GroupMode,
	KnockoutMode,
	TournamentMode,
	TournamentRosterMode,
	TournamentSetupPhase,
	TournamentSetupStatus,
	TournamentState,
	type TournamentInfo,
} from "../../../src/domains/tournaments/repository";
import { LeagueType } from "../../../src/domains/leagues/repository";
import type { GraphQLContext } from "../../../src/graphql/context";
import { gqlCacheKey } from "../../../src/infra/cache-key";
import { TestRedis, testLogger } from "../../helpers/data-publication";

const verifiedPrincipal = {
	userId: "user-1",
	source: "website" as const,
	fplEntryId: 123,
	fplEntryVerifiedAt: "2026-08-20T00:00:00.000Z",
};

const entryRow = (overrides: Record<string, unknown> = {}) => ({
	entry_id: 123,
	entry_name: "Codex XI",
	player_name: "Test Manager",
	region: "AU",
	started_event: 1,
	overall_points: 100,
	overall_rank: 1000,
	bank: 10,
	team_value: 1000,
	total_transfers: 2,
	transfers_synced_through_event_id: 2,
	...overrides,
});

const historyRow = (eventId: number): MyFplTeamHistoryRow & Record<string, unknown> => ({
	eventId,
	eventPoints: 50,
	eventRank: 10,
	overallPoints: eventId * 50,
	overallRank: 10,
	eventTransfers: 1,
	eventTransfersCost: 0,
	eventNetPoints: 50,
	eventBenchPoints: 2,
	eventChip: "NONE",
	eventCaptainPoints: 10,
	captainWebName: null,
	captainTeamShortName: null,
	teamValue: 1000,
	bank: 10,
	event_id: eventId,
	event_points: 50,
	event_rank: 10,
	overall_points: eventId * 50,
	overall_rank: 10,
	event_transfers: 1,
	event_transfers_cost: 0,
	event_net_points: 50,
	event_bench_points: 2,
	event_chip: "none",
	captain_points: 10,
	captain_web_name: null,
	captain_team_short_name: null,
	team_value: 1000,
	rich_synced_at: "2026-08-20T00:00:00.000Z",
});

const gameweekRow = (
	eventId: number,
	elementId: number,
	overrides: Record<string, unknown> = {}
) => ({
	event_id: eventId,
	event_points: 50,
	overall_points: 100,
	overall_rank: 10,
	event_transfers: 1,
	event_transfers_cost: 0,
	event_net_points: 50,
	event_bench_points: 2,
	event_chip: "none",
	captain_points: 10,
	played_captain_web_name: "Captain",
	team_value: 1000,
	bank: 10,
	element_id: elementId,
	position: elementId,
	web_name: `Player ${elementId}`,
	team_short_name: "ARS",
	team_name: "Arsenal",
	element_type: ((elementId - 1) % 4) + 1,
	is_captain: elementId === 1,
	is_vice_captain: elementId === 2,
	multiplier: elementId === 1 ? 2 : 1,
	total_points: 5,
	minutes: 90,
	goals_scored: 0,
	assists: 0,
	clean_sheets: 1,
	goals_conceded: 0,
	yellow_cards: 0,
	red_cards: 0,
	saves: 0,
	bonus: 0,
	bps: 10,
	expected_goals: "0.10",
	expected_assists: "0.20",
	expected_goal_involvements: "0.30",
	expected_goals_conceded: "0.40",
	against_short_name: "CHE",
	was_home: "H",
	score: "2-0",
	fixture_count: 1,
	automatic_substitutions: [],
	...overrides,
});

const tournament = (overrides: Partial<TournamentInfo> = {}): TournamentInfo => ({
	id: 7,
	name: "Codex Cup",
	creator: "user-1",
	adminEntryId: 123,
	leagueId: 7,
	leagueType: LeagueType.CLASSIC,
	sourceLeagueName: null,
	rosterMode: TournamentRosterMode.SNAPSHOT,
	rosterSyncStatus: TournamentSetupStatus.READY,
	rosterLastSyncedAt: null,
	officialScheduleHash: null,
	officialScheduleSyncedAt: null,
	officialScheduleLockedAt: null,
	totalTeamNum: 2,
	tournamentMode: TournamentMode.NORMAL,
	groupMode: GroupMode.POINTS_RACES,
	groupTeamNum: 2,
	groupNum: 1,
	groupStartedEventId: 1,
	groupEndedEventId: 38,
	groupAutoAverages: false,
	groupRounds: 1,
	groupPlayAgainstNum: 1,
	groupQualifyNum: 1,
	knockoutMode: KnockoutMode.NO_KNOCKOUT,
	knockoutTeamNum: null,
	knockoutRounds: null,
	knockoutEventNum: null,
	knockoutStartedEventId: null,
	knockoutEndedEventId: null,
	knockoutPlayAgainstNum: null,
	state: TournamentState.ACTIVE,
	setupStatus: TournamentSetupStatus.READY,
	setupPhase: TournamentSetupPhase.READY,
	setupCompletedUnits: 10,
	setupTotalUnits: 10,
	setupProgressUpdatedAt: "2026-08-20T00:00:00.000Z",
	standingsReadyAt: "2026-08-20T00:00:00.000Z",
	insightsReadyAt: "2026-08-20T00:00:00.000Z",
	setupHasWarnings: false,
	setupStartedAt: "2026-08-20T00:00:00.000Z",
	setupFinishedAt: "2026-08-20T00:00:00.000Z",
	createdAt: "2026-08-19T00:00:00.000Z",
	updatedAt: "2026-08-20T00:00:00.000Z",
	...overrides,
});

type FixtureOptions = {
	finalizedIds?: number[];
	currentEventId?: number | null;
	entryRows?: unknown[];
	historyRows?: unknown[];
	pastSeasonRows?: unknown[];
	transferRows?: unknown[];
	gameweekRows?: unknown[];
	aggregateRows?: unknown[];
	aggregateFieldSize?: number;
	aggregatePayload?: MyFplCompetitionAggregate | null;
	seasonPathRows?: unknown[];
	enrichedCount?: number;
	membershipIds?: number[];
	member?: boolean;
	catalog?: TournamentInfo[];
	selectedTournament?: TournamentInfo | null;
	boardPayload?: unknown;
	setupRows?: unknown[];
	queryOverride?: (
		sql: string,
		params: unknown[]
	) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

type AggregateTestRow = Record<string, unknown>;

const aggregatePayloadFromRows = (
	rawRows: unknown[],
	eventId = 1,
	viewerEntryId = 123
): MyFplCompetitionAggregate => {
	const rows = rawRows as AggregateTestRow[];
	const numberAt = (row: AggregateTestRow, key: string): number | null =>
		typeof row[key] === "number" ? (row[key] as number) : null;
	const stringAt = (row: AggregateTestRow, key: string): string | null =>
		typeof row[key] === "string" ? (row[key] as string) : null;
	const sortedPoints = rows
		.map((row) => ({ row, value: numberAt(row, "overall_points") }))
		.filter((sample): sample is { row: AggregateTestRow; value: number } => sample.value !== null)
		.sort(
			(left, right) =>
				right.value -
				left.value -
				(numberAt(left.row, "entry_id") ?? 0) +
				(numberAt(right.row, "entry_id") ?? 0)
		);
	const leaderOverallPoints = sortedPoints[0]?.value ?? null;
	const secondOverallPoints = sortedPoints[1]?.value ?? null;
	const metric = (
		key:
			| "OVERALL_POINTS"
			| "TEAM_VALUE"
			| "TRANSFERS"
			| "TOTAL_COSTS"
			| "BENCH_POINTS"
			| "AUTO_SUB_POINTS",
		field: string,
		higherIsBetter: boolean
	) => {
		const samples = rows
			.map((row) => ({ row, value: numberAt(row, field) }))
			.filter((sample): sample is { row: AggregateTestRow; value: number } => sample.value !== null)
			.sort(
				(left, right) =>
					(higherIsBetter ? right.value - left.value : left.value - right.value) ||
					(numberAt(left.row, "entry_id") ?? 0) - (numberAt(right.row, "entry_id") ?? 0)
			);
		const leader = samples[0];
		return {
			key,
			leaderValue: leader?.value ?? null,
			leaderEntryId: leader ? numberAt(leader.row, "entry_id") : null,
			leaderEntryName: leader ? stringAt(leader.row, "entry_name") : null,
			leaderPlayerName: leader ? stringAt(leader.row, "player_name") : null,
			averageValue:
				samples.length === 0
					? null
					: Math.round(
							(samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length) * 100
						) / 100,
			higherIsBetter,
		};
	};
	const metricRank = (
		field: string,
		higherIsBetter: boolean,
		row: AggregateTestRow
	): number | null => {
		const value = numberAt(row, field);
		if (value === null) return null;
		return (
			1 +
			rows.filter((candidate) => {
				const candidateValue = numberAt(candidate, field);
				return (
					candidateValue !== null &&
					(higherIsBetter ? candidateValue > value : candidateValue < value)
				);
			}).length
		);
	};
	const mine = rows.find((row) => numberAt(row, "entry_id") === viewerEntryId) ?? null;
	const pointIndex = mine
		? sortedPoints.findIndex((sample) => numberAt(sample.row, "entry_id") === viewerEntryId)
		: -1;
	const averageOverallPoints =
		sortedPoints.length === 0
			? null
			: Math.round(
					sortedPoints.reduce((sum, sample) => sum + sample.value, 0) / sortedPoints.length
				);
	const performance = rows
		.filter(
			(row) => numberAt(row, "event_points") !== null && numberAt(row, "event_net_points") !== null
		)
		.sort(
			(left, right) =>
				(numberAt(right, "event_net_points") ?? 0) - (numberAt(left, "event_net_points") ?? 0) ||
				(numberAt(left, "entry_id") ?? 0) - (numberAt(right, "entry_id") ?? 0)
		);
	const toPerformance = (row: AggregateTestRow) => ({
		entryId: numberAt(row, "entry_id") ?? 0,
		entryName: stringAt(row, "entry_name"),
		playerName: stringAt(row, "player_name"),
		eventPoints: numberAt(row, "event_points") ?? 0,
		eventNetPoints: numberAt(row, "event_net_points") ?? 0,
		rank: numberAt(row, "tournament_rank"),
		previousRank: numberAt(row, "previous_tournament_rank"),
		captainId: numberAt(row, "captain_id"),
		captainWebName: stringAt(row, "captain_web_name"),
		captainTeamShortName: stringAt(row, "captain_team_short_name"),
		captainPoints: numberAt(row, "captain_points"),
	});
	const movementRows = rows
		.map((row) => ({
			row,
			movement:
				numberAt(row, "previous_tournament_rank") === null ||
				numberAt(row, "tournament_rank") === null
					? null
					: (numberAt(row, "previous_tournament_rank") ?? 0) - numberAt(row, "tournament_rank")!,
		}))
		.filter((item): item is { row: AggregateTestRow; movement: number } => item.movement !== null);
	const risers = movementRows
		.filter((item) => item.movement > 0)
		.sort(
			(left, right) =>
				right.movement - left.movement ||
				(numberAt(left.row, "entry_id") ?? 0) - (numberAt(right.row, "entry_id") ?? 0)
		)
		.slice(0, 5)
		.map((item) => toPerformance(item.row));
	const fallers = movementRows
		.filter((item) => item.movement < 0)
		.sort(
			(left, right) =>
				left.movement - right.movement ||
				(numberAt(left.row, "entry_id") ?? 0) - (numberAt(right.row, "entry_id") ?? 0)
		)
		.slice(0, 5)
		.map((item) => toPerformance(item.row));
	const distribution = (kind: "captain" | "chip") => {
		const groups = new Map<
			string,
			{ label: string; teamShortName: string | null; count: number; totalPoints: number }
		>();
		for (const row of rows) {
			const captainId = numberAt(row, "captain_id");
			const rawChip =
				stringAt(row, "event_chip")
					?.toUpperCase()
					.replace(/[^A-Z0-9]/g, "") ?? "NONE";
			const key =
				kind === "captain"
					? captainId === null
						? "NONE"
						: String(captainId)
					: rawChip === "BBOOST" || rawChip === "BENCHBOOST"
						? "BENCH_BOOST"
						: rawChip === "FREEHIT"
							? "FREE_HIT"
							: rawChip;
			const current = groups.get(key) ?? {
				label:
					kind === "captain"
						? captainId === null
							? "NONE"
							: (stringAt(row, "captain_web_name") ?? String(captainId))
						: key,
				teamShortName: kind === "captain" ? stringAt(row, "captain_team_short_name") : null,
				count: 0,
				totalPoints: 0,
			};
			current.count += 1;
			current.totalPoints +=
				kind === "captain" && captainId === null
					? 0
					: (numberAt(row, kind === "captain" ? "captain_points" : "event_net_points") ??
						numberAt(row, "event_points") ??
						0);
			groups.set(key, current);
		}
		return [...groups.entries()]
			.map(([key, value]) => ({
				key,
				label: value.label,
				teamShortName: value.teamShortName,
				count: value.count,
				percentage: rows.length === 0 ? 0 : Math.round((value.count / rows.length) * 10_000) / 100,
				averagePoints: Math.round((value.totalPoints / value.count) * 10) / 10,
			}))
			.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
	};
	return {
		eventId,
		entryCount: rows.length,
		leaderOverallPoints,
		secondOverallPoints,
		gapFirstSecond:
			leaderOverallPoints === null || secondOverallPoints === null
				? null
				: leaderOverallPoints - secondOverallPoints,
		averageOverallPoints,
		metrics: [
			metric("OVERALL_POINTS", "overall_points", true),
			metric("TEAM_VALUE", "team_value", true),
			metric("TRANSFERS", "cumulative_transfers", false),
			metric("TOTAL_COSTS", "cumulative_transfer_cost", false),
			metric("BENCH_POINTS", "cumulative_bench_points", true),
			metric("AUTO_SUB_POINTS", "cumulative_auto_sub_points", true),
		],
		viewer: mine
			? {
					entryId: viewerEntryId,
					overallRank: numberAt(mine, "overall_rank"),
					tournamentOverallRank: numberAt(mine, "tournament_rank"),
					teamValue: numberAt(mine, "team_value"),
					tournamentTeamValueRank: metricRank("team_value", true, mine),
					transfersNum: numberAt(mine, "cumulative_transfers"),
					tournamentTransfersRank: metricRank("cumulative_transfers", false, mine),
					totalCosts: numberAt(mine, "cumulative_transfer_cost"),
					tournamentCostsRank: metricRank("cumulative_transfer_cost", false, mine),
					totalBenchPoints: numberAt(mine, "cumulative_bench_points"),
					tournamentBenchPointsRank: metricRank("cumulative_bench_points", true, mine),
					autoSubPoints: numberAt(mine, "cumulative_auto_sub_points"),
					tournamentAutoSubRank: metricRank("cumulative_auto_sub_points", true, mine),
					overallPoints: numberAt(mine, "overall_points"),
					leaderOverallPoints,
					gapToLeader:
						numberAt(mine, "overall_points") === null || leaderOverallPoints === null
							? null
							: Math.max(0, leaderOverallPoints - (numberAt(mine, "overall_points") ?? 0)),
					pointsBehindNext:
						pointIndex <= 0
							? pointIndex === 0
								? 0
								: null
							: Math.max(
									0,
									sortedPoints[pointIndex - 1].value - (numberAt(mine, "overall_points") ?? 0)
								),
					pointsAheadOfPrev:
						pointIndex < 0 || pointIndex === sortedPoints.length - 1
							? pointIndex === sortedPoints.length - 1
								? 0
								: null
							: Math.max(
									0,
									(numberAt(mine, "overall_points") ?? 0) - sortedPoints[pointIndex + 1].value
								),
				}
			: null,
		topPerformers: performance.slice(0, 5).map(toPerformance),
		risers: risers,
		fallers,
		captainDistribution: distribution("captain"),
		chipDistribution: distribution("chip"),
	};
};

const snapshotFor = (currentEventId: number | null) => ({
	source: "redis" as const,
	seasonCode: "2627",
	revision: "core-7",
	publicationId: "00000000-0000-4000-8000-000000000007",
	sourceCheckedAt: "2026-08-20T00:00:00.000Z",
	currentEventId,
	events: [
		{ id: 1, isCurrent: currentEventId === 1, isNext: currentEventId === null },
		{ id: 2, isCurrent: currentEventId === 2, isNext: currentEventId === 1 },
		{ id: 3, isCurrent: currentEventId === 3, isNext: currentEventId === 2 },
	],
});

const makeFixture = (options: FixtureOptions = {}) => {
	const redis = new TestRedis();
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	const selectedTournament =
		options.selectedTournament === undefined ? tournament() : options.selectedTournament;
	const catalog = options.catalog ?? (selectedTournament ? [selectedTournament] : []);
	const lifecycleRows = (options.finalizedIds ?? []).map((eventId) => ({
		event_id: eventId,
		finished: true,
		data_checked: true,
		live_snapshot_finalized_at: "2026-08-20T00:00:00.000Z",
	}));
	const query = async (sql: string, params: unknown[] = []) => {
		queries.push({ sql, params });
		if (options.queryOverride) return options.queryOverride(sql, params);
		if (sql.includes("FROM fpl.events")) return { rows: lifecycleRows };
		if (sql.includes("FROM competition.entries")) return { rows: options.entryRows ?? [] };
		if (sql.includes("FROM competition.entry_past_seasons")) {
			return { rows: options.pastSeasonRows ?? [] };
		}
		if (sql.includes("enriched_event_count")) {
			return { rows: [{ enriched_event_count: options.enrichedCount ?? 0 }] };
		}
		if (sql.includes("FROM competition.entry_event_transfers")) {
			return { rows: options.transferRows ?? [] };
		}
		if (sql.includes("FROM competition.entry_event_results result")) {
			if (sql.includes("entry_event_picks")) return { rows: options.gameweekRows ?? [] };
			return { rows: options.historyRows ?? [] };
		}
		if (sql.includes("FROM competition.tournament_entries")) {
			if (sql.includes("SELECT tournament_id")) {
				const ids = options.membershipIds ?? (options.member === false ? [] : [7]);
				return {
					rows: ids.map((tournamentId) => ({ tournament_id: tournamentId })),
					rowCount: ids.length,
				};
			}
			return {
				rows: options.member === false ? [] : [{ ok: 1 }],
				rowCount: options.member === false ? 0 : 1,
			};
		}
		if (sql.includes("jsonb_build_object")) {
			if (sql.includes("my-fpl competition aggregate")) {
				return {
					rows: [
						{
							payload:
								options.aggregatePayload ?? aggregatePayloadFromRows(options.aggregateRows ?? []),
						},
					],
				};
			}
			return {
				rows: [
					{
						payload: options.boardPayload ?? {
							fieldSize: 0,
							totalRows: 0,
							rows: [],
							viewerRow: null,
						},
					},
				],
			};
		}
		if (sql.includes("FROM competition.tournaments")) return { rows: options.setupRows ?? [] };
		if (sql.includes("WITH field AS MATERIALIZED")) return { rows: options.seasonPathRows ?? [] };
		if (sql.includes("SELECT count(*)::integer AS field_size")) {
			return {
				rows: [{ field_size: options.aggregateFieldSize ?? options.aggregateRows?.length ?? 0 }],
			};
		}
		if (sql.includes("FROM reporting.tournament_entry_event_summaries summary")) {
			return { rows: options.aggregateRows ?? [] };
		}
		return { rows: [] };
	};
	const context = {
		currentSeason: { seasonId: 2026, seasonCode: "2627" },
		dataRevision: "core-test",
		redis,
		database: { query },
		data: {},
		logger: testLogger,
		principal: verifiedPrincipal,
	} as unknown as GraphQLContext;
	const tournamentsRepository = {
		getEntryTournaments: async () => catalog,
		getTournamentInfosUncached: async (_context: GraphQLContext, ids: number[]) =>
			ids.map((id) => (id === selectedTournament?.id ? selectedTournament : null)),
		getTournamentInfoUncached: async () => selectedTournament,
	};
	const dependencies: MyFplRepositoryDependencies = {
		getCoreEventSnapshot: async () => snapshotFor(options.currentEventId ?? 2) as never,
		tournamentsRepository: tournamentsRepository as never,
	};
	return {
		context,
		redis,
		queries,
		repository: createMyFplRepository(dependencies),
	};
};

describe("My FPL review repository", () => {
	it("normalizes search, chips, positions and board rows", () => {
		expect(myFplTestables.normalizeSearch("  North London  ")).toBe("North London");
		expect(() => myFplTestables.normalizeSearch("x".repeat(81))).toThrow(
			"search must contain at most 80 characters"
		);
		expect(myFplTestables.normalizeChip("bboost")).toBe("BENCH_BOOST");
		expect(myFplTestables.normalizeChip("3xc")).toBe("TRIPLE_CAPTAIN");
		expect([1, 2, 3, 4, 5].map(myFplTestables.positionName)).toEqual([
			"GKP",
			"DEF",
			"MID",
			"FWD",
			"",
		]);
		expect(
			myFplTestables.mapBoardJsonRow({
				event_id: 8,
				group_id: 2,
				entry_id: 123,
				entry_name: "Codex XI",
				player_name: "Test Manager",
				rank: "7",
				previous_rank: "9",
				event_points: 61,
				event_cost: 4,
				event_net_points: 57,
				event_rank: 12345,
				overall_points: 510,
				overall_rank: 67890,
				event_chip: "freehit",
				captain_id: 11,
				captain_web_name: "Captain",
				captain_team_short_name: "ARS",
				captain_points: 20,
				team_value: 1007,
				bank: 13,
			})
		).toMatchObject({ rank: 7, previousRank: 9, eventChip: "FREE_HIT" });
	});

	it("requires a verified principal and preserves the bound entry identity", async () => {
		const unauthenticated = makeFixture();
		unauthenticated.context.principal = undefined;
		await expect(
			unauthenticated.repository.loadTeamDesk(unauthenticated.context)
		).rejects.toMatchObject({
			extensions: { code: "FORBIDDEN" },
		});
		const fixture = makeFixture({ finalizedIds: [1], entryRows: [entryRow()] });
		const desk = await fixture.repository.loadTeamDesk(fixture.context);
		expect(desk.entry?.id).toBe(123);
		expect(desk.entry?.entryName).toBe("Codex XI");
	});

	it("reports PRESEASON, EMPTY, PENDING and READY from durable checkpoints", async () => {
		const preseason = makeFixture({ entryRows: [entryRow()], finalizedIds: [] });
		expect((await preseason.repository.loadTeamDesk(preseason.context)).state).toBe("PRESEASON");
		const empty = makeFixture({ finalizedIds: [1], entryRows: [] });
		expect((await empty.repository.loadTeamDesk(empty.context)).state).toBe("EMPTY");
		const pending = makeFixture({
			finalizedIds: [1, 2],
			entryRows: [entryRow()],
			historyRows: [historyRow(1)],
		});
		const pendingDesk = await pending.repository.loadTeamDesk(pending.context);
		expect(pendingDesk.state).toBe("PENDING");
		expect(pending.redis.setCalls.at(-1)?.[3]).toBe(30);
		const ready = makeFixture({
			finalizedIds: [1, 2],
			entryRows: [entryRow()],
			historyRows: [historyRow(1), historyRow(2)],
		});
		expect((await ready.repository.loadTeamDesk(ready.context)).state).toBe("READY");
		expect(ready.redis.setCalls.at(-1)?.[3]).toBeGreaterThan(30);
	});

	it("distinguishes a confirmed empty past-season history from an unchecked history", async () => {
		const confirmedEmpty = makeFixture({
			finalizedIds: [1],
			entryRows: [
				entryRow({
					past_seasons_checked_at: "2026-08-20T00:00:00.000Z",
					past_seasons_count: 0,
				}),
			],
			pastSeasonRows: [],
			historyRows: [historyRow(1)],
		});
		const readyDesk = await confirmedEmpty.repository.loadTeamDesk(confirmedEmpty.context);
		expect(readyDesk.pastSeasons).toEqual([]);
		expect(readyDesk.pastSeasonsState).toBe("READY");

		const unchecked = makeFixture({
			finalizedIds: [1],
			entryRows: [entryRow({ past_seasons_checked_at: null, past_seasons_count: null })],
			historyRows: [historyRow(1)],
		});
		expect((await unchecked.repository.loadTeamDesk(unchecked.context)).pastSeasonsState).toBe(
			"PENDING"
		);
	});

	it("does not promote incomplete finalized or rich-enriched data to READY", async () => {
		const lifecycleIncomplete = makeFixture({
			entryRows: [entryRow()],
			finalizedIds: [],
			historyRows: [historyRow(1)],
		});
		expect(
			(await lifecycleIncomplete.repository.loadTeamDesk(lifecycleIncomplete.context)).state
		).toBe("PRESEASON");
		const richIncomplete = makeFixture({
			entryRows: [entryRow()],
			finalizedIds: [1, 2],
			historyRows: [],
		});
		expect((await richIncomplete.repository.loadTeamDesk(richIncomplete.context)).state).toBe(
			"PENDING"
		);
	});

	it("evicts malformed and schema-invalid cache values before querying PostgreSQL", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			entryRows: [entryRow()],
			historyRows: [historyRow(1)],
		});
		const key = gqlCacheKey(fixture.context, "my-fpl:v6:team-desk:123:season");
		await fixture.redis.set(key, JSON.stringify({ state: "READY", history: [] }));
		const desk = await fixture.repository.loadTeamDesk(fixture.context);
		expect(desk.state).toBe("READY");
		expect(await fixture.redis.get(key)).not.toBe(JSON.stringify({ state: "READY", history: [] }));
		const malformed = makeFixture({ finalizedIds: [1], entryRows: [entryRow()] });
		const malformedKey = gqlCacheKey(malformed.context, "my-fpl:v6:team-desk:123:season");
		await malformed.redis.set(malformedKey, "{");
		await malformed.repository.loadTeamDesk(malformed.context);
		expect(await malformed.redis.get(malformedKey)).not.toBe("{");
	});

	it("keeps transfer and gameweek readiness fail-closed", async () => {
		const preseason = makeFixture({ finalizedIds: [] });
		expect((await preseason.repository.loadTeamTransfers(preseason.context)).state).toBe(
			"PRESEASON"
		);
		const pending = makeFixture({
			finalizedIds: [1, 2],
			entryRows: [entryRow({ transfers_synced_through_event_id: 1 })],
		});
		expect((await pending.repository.loadTeamTransfers(pending.context)).state).toBe("PENDING");
		const gameweek = makeFixture({ finalizedIds: [1], entryRows: [entryRow()] });
		expect((await gameweek.repository.loadTeamGameweek(gameweek.context, 1)).state).toBe("PENDING");
		await expect(gameweek.repository.loadTeamGameweek(gameweek.context, 0)).rejects.toMatchObject({
			extensions: { code: "BAD_USER_INPUT" },
		});
	});

	it("returns a ready gameweek only after all fifteen picks are enriched", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			entryRows: [entryRow()],
			gameweekRows: Array.from({ length: 15 }, (_, index) => gameweekRow(1, index + 1)),
		});
		const gameweek = await fixture.repository.loadTeamGameweek(fixture.context, 1);
		expect(gameweek.state).toBe("READY");
		expect(gameweek.result?.picks).toHaveLength(15);
		expect(gameweek.result?.picks[0]?.isCaptain).toBe(true);
	});

	it("derives fixture count, BGW and DGW from the fixture aggregate", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			entryRows: [entryRow()],
			gameweekRows: Array.from({ length: 15 }, (_, index) =>
				gameweekRow(1, index + 1, {
					fixture_count: index === 0 ? 0 : index === 1 ? 2 : 1,
				})
			),
		});
		const gameweek = await fixture.repository.loadTeamGameweek(fixture.context, 1);
		expect(gameweek.state).toBe("READY");
		expect(gameweek.result?.picks[0]).toMatchObject({
			fixtureCount: 0,
			bgw: true,
			dgw: false,
		});
		expect(gameweek.result?.picks[1]).toMatchObject({
			fixtureCount: 2,
			bgw: false,
			dgw: true,
		});
	});

	it("uses only official automatic substitutions and never infers them from Bench Boost", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			entryRows: [entryRow()],
			gameweekRows: Array.from({ length: 15 }, (_, index) =>
				gameweekRow(1, index + 1, {
					event_chip: "benchboost",
					automatic_substitutions: [],
				})
			),
		});
		const gameweek = await fixture.repository.loadTeamGameweek(fixture.context, 1);
		expect(gameweek.state).toBe("READY");
		expect(gameweek.result?.eventChip).toBe("BENCH_BOOST");
		expect(gameweek.result?.picks.every((pick) => pick.autoSub)).toBe(false);
		expect(gameweek.result?.picks.every((pick) => !pick.autoSub)).toBe(true);
	});

	it("loads enriched transfer rows and groups them by gameweek", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			entryRows: [entryRow()],
			enrichedCount: 1,
			transferRows: [
				{
					event_id: 1,
					event_transfers: 1,
					event_transfers_cost: 4,
					element_in_web_name: "In",
					element_in_type: 3,
					element_in_team_short_name: "ARS",
					element_in_cost: 70,
					element_out_web_name: "Out",
					element_out_type: 4,
					element_out_team_short_name: "CHE",
					element_out_cost: 65,
					transfer_time: "2026-08-20T00:00:00.000Z",
				},
			],
		});
		const transfers = await fixture.repository.loadTeamTransfers(fixture.context);
		expect(transfers.state).toBe("READY");
		expect(transfers.gameweeks).toHaveLength(1);
		expect(transfers.gameweeks[0]?.transfers[0]?.elementInWebName).toBe("In");
	});

	it("validates tournament board pagination, pushes range to SQL, and warms its cache", async () => {
		const boardRow = {
			event_id: 1,
			group_id: 1,
			entry_id: 123,
			entry_name: "Foo",
			player_name: "A",
			rank: 1,
			previous_rank: null,
			event_points: 50,
			event_cost: 0,
			event_net_points: 50,
			event_rank: 10,
			overall_points: 100,
			overall_rank: 1000,
			event_chip: "none",
			captain_id: null,
			captain_web_name: null,
			captain_team_short_name: null,
			captain_points: null,
			team_value: 1000,
			bank: 10,
		};
		const fixture = makeFixture({
			finalizedIds: [1],
			boardPayload: {
				fieldSize: 2,
				totalRows: 2,
				rows: [boardRow],
				viewerRow: boardRow,
			},
		});
		const page = await fixture.repository.loadCompetitionBoard(fixture.context, {
			tournamentId: 7,
			eventId: 1,
			page: 2,
			pageSize: 1,
			search: " Foo ",
		});
		expect(page.state).toBe("READY");
		expect(page.totalPages).toBe(2);
		const boardQuery = fixture.queries.find((query) => query.sql.includes("LIMIT $5 OFFSET $6"));
		expect(boardQuery?.params.slice(3, 6)).toEqual(["Foo", 1, 1]);
		const queryCount = fixture.queries.filter((query) =>
			query.sql.includes("LIMIT $5 OFFSET $6")
		).length;
		await fixture.repository.loadCompetitionBoard(fixture.context, {
			tournamentId: 7,
			eventId: 1,
			page: 2,
			pageSize: 1,
			search: " Foo ",
		});
		expect(fixture.queries.filter((query) => query.sql.includes("LIMIT $5 OFFSET $6")).length).toBe(
			queryCount
		);
		await expect(
			fixture.repository.loadCompetitionBoard(fixture.context, {
				tournamentId: 7,
				eventId: 1,
				page: 101,
				pageSize: 1,
			})
		).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
	});

	it("keeps membership and tournament mode checks before board reads", async () => {
		const unsupported = makeFixture({
			finalizedIds: [1],
			selectedTournament: tournament({ groupMode: GroupMode.BATTLE_RACES }),
		});
		const result = await unsupported.repository.loadCompetitionBoard(unsupported.context, {
			tournamentId: 7,
			eventId: 1,
		});
		expect(result.state).toBe("UNAVAILABLE");
		const forbidden = makeFixture({ member: false, selectedTournament: tournament() });
		await expect(
			forbidden.repository.loadCompetitionBoard(forbidden.context, { tournamentId: 7, eventId: 1 })
		).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
	});

	it("lets an attested platform administrator use My FPL competition roots as a non-member", async () => {
		const fixture = makeFixture({
			member: false,
			membershipIds: [],
			finalizedIds: [],
			setupRows: [
				{
					setup_status: "ready",
					setup_phase: "ready",
					setup_completed_units: 10,
					setup_total_units: 10,
					setup_progress_updated_at: "2026-08-20T00:00:00.000Z",
					standings_ready_at: "2026-08-20T00:00:00.000Z",
					insights_ready_at: "2026-08-20T00:00:00.000Z",
					setup_warning_count: 0,
				},
			],
		});
		fixture.context.principal = { ...verifiedPrincipal, platformAdmin: true };

		const desk = await fixture.repository.loadCompetitionsDesk(fixture.context, 7);
		expect(desk.tournaments.map((item) => item.id)).toEqual([7]);
		const status = await fixture.repository.loadCompetitionSetupStatus(fixture.context, 7);
		expect(status.ready).toBe(true);
		expect(
			fixture.queries.some((query) => query.sql.includes("FROM competition.tournament_entries"))
		).toBe(false);
	});

	it("returns the competitions desk with aggregate and season-path readiness", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			entryRows: [entryRow()],
			boardPayload: {
				fieldSize: 2,
				totalRows: 2,
				rows: [{ event_id: 1, group_id: 1, entry_id: 123, entry_name: "Foo", player_name: "A" }],
				viewerRow: { event_id: 1, group_id: 1, entry_id: 123, entry_name: "Foo", player_name: "A" },
			},
			aggregateRows: [
				{
					entry_id: 123,
					entry_name: "Foo",
					player_name: "A",
					overall_points: 100,
					overall_rank: 1,
					team_value: 1000,
					cumulative_transfers: 1,
					cumulative_transfer_cost: 4,
					cumulative_bench_points: 2,
					cumulative_auto_sub_points: 0,
					tournament_rank: 1,
				},
			],
			seasonPathRows: [
				{
					event_id: 1,
					tournament_rank: 1,
					field_size: 1,
					overall_points: 100,
					leader_overall_points: 100,
					average_overall_points: "100",
					gap_to_leader: 0,
					points_vs_average: "0",
				},
			],
		});
		const desk = await fixture.repository.loadCompetitionsDesk(fixture.context, 7, 1);
		expect(desk.state).toBe("READY");
		expect(desk.aggregate?.viewer?.entryId).toBe(123);
		const path = await fixture.repository.loadCompetitionSeasonPath(fixture.context, 7, 1);
		expect(path.state).toBe("READY");
		expect(path.points[0]?.tournamentRank).toBe(1);
	});

	it("computes competition insight distributions from the complete field", async () => {
		const boardRow = {
			event_id: 1,
			group_id: 1,
			entry_id: 123,
			entry_name: "Foo",
			player_name: "A",
			rank: 1,
			previous_rank: 2,
			event_points: 60,
			event_cost: 0,
			event_net_points: 56,
			event_rank: 1,
			overall_points: 100,
			overall_rank: 1000,
			event_chip: "benchboost",
			captain_id: 11,
			captain_web_name: "Saka",
			captain_team_short_name: "ARS",
			captain_points: 20,
			team_value: 1000,
			bank: 10,
		};
		const fixture = makeFixture({
			finalizedIds: [1],
			boardPayload: {
				fieldSize: 3,
				totalRows: 3,
				rows: [boardRow],
				viewerRow: boardRow,
			},
			aggregateRows: [
				{
					entry_id: 123,
					entry_name: "Foo",
					player_name: "A",
					overall_points: 100,
					overall_rank: 1000,
					team_value: 1000,
					cumulative_transfers: 1,
					cumulative_transfer_cost: 0,
					cumulative_bench_points: 4,
					cumulative_auto_sub_points: 0,
					event_points: 60,
					event_net_points: 56,
					event_chip: "benchboost",
					captain_id: 11,
					captain_web_name: "Saka",
					captain_team_short_name: "ARS",
					captain_points: 20,
					tournament_rank: 1,
					previous_tournament_rank: 2,
				},
				{
					entry_id: 124,
					entry_name: "Bar",
					player_name: "B",
					overall_points: 90,
					overall_rank: 1100,
					team_value: 995,
					cumulative_transfers: 2,
					cumulative_transfer_cost: 4,
					cumulative_bench_points: 2,
					cumulative_auto_sub_points: 1,
					event_points: 40,
					event_net_points: 40,
					event_chip: "none",
					captain_id: 11,
					captain_web_name: "Saka",
					captain_team_short_name: "ARS",
					captain_points: 10,
					tournament_rank: 2,
					previous_tournament_rank: 3,
				},
				{
					entry_id: 125,
					entry_name: "Baz",
					player_name: "C",
					overall_points: 80,
					overall_rank: 1200,
					team_value: 990,
					cumulative_transfers: 0,
					cumulative_transfer_cost: 0,
					cumulative_bench_points: 1,
					cumulative_auto_sub_points: 0,
					event_points: 30,
					event_net_points: 30,
					event_chip: "freehit",
					captain_id: 12,
					captain_web_name: "Palmer",
					captain_team_short_name: "CHE",
					captain_points: 8,
					tournament_rank: 3,
					previous_tournament_rank: 1,
				},
			],
		});
		const desk = await fixture.repository.loadCompetitionsDesk(fixture.context, 7, 1);
		const aggregate = desk.aggregate;
		expect(aggregate?.entryCount).toBe(3);
		expect(aggregate?.topPerformers[0]?.entryId).toBe(123);
		expect(aggregate?.risers[0]?.entryId).toBe(123);
		expect(aggregate?.fallers[0]?.entryId).toBe(125);
		expect(aggregate?.captainDistribution[0]).toMatchObject({
			key: "11",
			teamShortName: "ARS",
			count: 2,
			percentage: 66.67,
			averagePoints: 15,
		});
		expect(aggregate?.chipDistribution.find((row) => row.key === "BENCH_BOOST")).toMatchObject({
			count: 1,
			percentage: 33.33,
		});
	});

	it("marks H2H/battle review as unavailable instead of rendering a points race", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			selectedTournament: tournament({ groupMode: GroupMode.BATTLE_RACES }),
		});
		const desk = await fixture.repository.loadCompetitionsDesk(fixture.context, 7, 1);
		expect(desk.state).toBe("UNAVAILABLE");
		expect(desk.board?.state).toBe("UNAVAILABLE");
		expect(desk.aggregate).toBeNull();
	});

	it("does not convert PostgreSQL errors into empty data or success cache", async () => {
		const fixture = makeFixture({
			queryOverride: async (sql) => {
				if (sql.includes("FROM competition.entries")) throw new Error("database unavailable");
				if (sql.includes("FROM fpl.events")) return { rows: [] };
				return { rows: [] };
			},
		});
		await expect(fixture.repository.loadTeamDesk(fixture.context)).rejects.toThrow(
			"database unavailable"
		);
		expect(fixture.redis.setCalls).toHaveLength(0);
	});

	it("normalizes setup readiness without letting profile warnings hide ready insights", async () => {
		const fixture = makeFixture({
			setupRows: [
				{
					setup_status: "ready",
					setup_phase: "ready",
					setup_completed_units: 10,
					setup_total_units: 10,
					setup_progress_updated_at: "2026-08-20T00:00:00.000Z",
					standings_ready_at: "2026-08-20T00:00:00.000Z",
					insights_ready_at: "2026-08-20T00:00:00.000Z",
					setup_warning_count: 1,
				},
			],
		});
		const status = await fixture.repository.loadCompetitionSetupStatus(fixture.context, 7);
		expect(status.setupStatus).toBe("READY");
		expect(status.insightsReadyAt).toBe("2026-08-20T00:00:00.000Z");
		expect(status.setupHasWarnings).toBe(true);
		expect(status.ready).toBe(true);
	});

	it("delegates resolver roots through the injected repository and propagates errors", async () => {
		const calls: string[] = [];
		const fakeRepository = {
			loadTeamDesk: async () => {
				calls.push("desk");
				return { state: "EMPTY" as MyFplReviewState } as never;
			},
			loadTeamGameweek: async () => ({ state: "PENDING" as MyFplReviewState }) as never,
			loadTeamTransfers: async () => ({ state: "PRESEASON" as MyFplReviewState }) as never,
			loadCompetitionsDesk: async () => ({ state: "EMPTY" as MyFplReviewState }) as never,
			loadCompetitionBoard: async () => ({ state: "EMPTY" as MyFplReviewState }) as never,
			loadCompetitionSeasonPath: async () => ({ state: "EMPTY" as MyFplReviewState }) as never,
			loadCompetitionSetupStatus: async () => {
				throw new GraphQLError("database unavailable", {
					extensions: { code: "INTERNAL_SERVER_ERROR" },
				});
			},
		} as unknown as MyFplRepository;
		const resolvers = createMyFplResolvers(fakeRepository);
		const context = makeFixture().context;
		await resolvers.Query.myFplTeamDesk(null, {}, context);
		expect(calls).toEqual(["desk"]);
		await resolvers.Query.myFplTeamGameweek(null, { eventId: 1 }, context);
		await resolvers.Query.myFplTeamTransfers(null, {}, context);
		await resolvers.Query.myFplCompetitionsDesk(null, {}, context);
		await resolvers.Query.myFplCompetitionBoard(
			null,
			{ tournamentId: 7, eventId: 1, page: 1, pageSize: 1 },
			context
		);
		await resolvers.Query.myFplCompetitionSeasonPath(
			null,
			{ tournamentId: 7, throughEventId: 1 },
			context
		);
		await expect(
			resolvers.Query.myFplCompetitionSetupStatus(null, { tournamentId: 7 }, context)
		).rejects.toThrow("database unavailable");
	});
});
