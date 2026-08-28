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
import { COMPETITION_AGGREGATE_SQL } from "../../../src/domains/my-fpl/competition-aggregate-sql";

const verifiedPrincipal = {
	userId: "user-1",
	source: "website" as const,
	fplEntryId: 123,
	fplEntryVerifiedAt: "2026-08-20T00:00:00.000Z",
};

describe("competition aggregate SQL contract", () => {
	it("keeps the established semantic metric order", () => {
		const catalog = COMPETITION_AGGREGATE_SQL.slice(
			COMPETITION_AGGREGATE_SQL.indexOf("VALUES"),
			COMPETITION_AGGREGATE_SQL.indexOf(") AS catalog")
		);
		const order = [
			"OVERALL_POINTS",
			"TEAM_VALUE",
			"TRANSFERS",
			"TOTAL_COSTS",
			"BENCH_POINTS",
			"AUTO_SUB_POINTS",
		].map((key) => catalog.indexOf(key));
		expect(order).toEqual([...order].sort((left, right) => left - right));
	});

	it("uses only event-scoped captain teams", () => {
		expect(COMPETITION_AGGREGATE_SQL).toContain(
			"captain_team.team_id = captain_historical_team.team_id"
		);
		expect(COMPETITION_AGGREGATE_SQL).not.toContain(
			"COALESCE(captain_historical_team.team_id, captain.team_id)"
		);
	});

	it("requires scored rows for movement insights", () => {
		expect(COMPETITION_AGGREGATE_SQL).toContain(
			"AND event_points IS NOT NULL\n    AND event_net_points IS NOT NULL"
		);
	});
});

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
	officialMembershipIds?: number[];
	member?: boolean;
	catalog?: TournamentInfo[];
	selectedTournament?: TournamentInfo | null;
	boardPayload?: unknown;
	publicationRows?: unknown[];
	pinnedPublicationRows?: unknown[];
	currentEntryNames?: Record<number, string>;
	snapshotEntryRow?: unknown;
	snapshotBoardRow?: unknown;
	snapshotAggregatePayload?: unknown;
	snapshotSeasonPathPayload?: unknown;
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

const snapshotPublicationRow = {
	season_id: 2026,
	event_id: 1,
	revision: "42",
	snapshot_date: "2026-08-22",
	source_checked_at: "2026-08-22T10:45:00.000Z",
	published_at: "2026-08-22T10:46:00.000Z",
	kind: "PROVISIONAL" as const,
	expected_entry_count: 1,
	ready_entry_count: 1,
	empty_entry_count: 0,
	not_applicable_entry_count: 0,
	expected_tournament_count: 1,
	ready_tournament_count: 1,
	content_sha256: "0".repeat(64),
	score_source: "FPL_EVENT_LIVE" as const,
	live_publication_id: "00000000-0000-4000-8000-000000000007",
	live_revision: "8",
	algorithm_version: "fpl-projected-autosubs-v1",
	source_min_checked_at: "2026-08-22T10:45:00.000Z",
	source_max_checked_at: "2026-08-22T10:45:00.000Z",
};

const snapshotPick = (element: number) => ({
	element,
	position: element,
	webName: `Player ${element}`,
	teamShortName: "ARS",
	teamName: "Arsenal",
	elementTypeName: element === 1 ? "GKP" : "DEF",
	isCaptain: element === 1,
	isViceCaptain: element === 2,
	multiplier: element === 1 ? 2 : 1,
	totalPoints: 5,
	minutes: 90,
	goalsScored: 0,
	assists: 0,
	cleanSheets: 1,
	goalsConceded: 0,
	yellowCards: 0,
	redCards: 0,
	saves: 0,
	bonus: 0,
	bps: 10,
	againstShortName: "CHE",
	wasHome: "H",
	score: "2-0",
	fixtureCount: 1,
	bgw: false,
	dgw: false,
	isPlayed: true,
	autoSub: false,
	expectedGoals: 0.1,
	expectedAssists: 0.2,
	expectedGoalInvolvements: 0.3,
	expectedGoalsConceded: 0.4,
});

const snapshotPayload = () => ({
	entry: {
		id: 123,
		entryName: "Codex XI",
		playerName: "Test Manager",
		region: "AU",
		startedEvent: 1,
		overallPoints: 100,
		overallRank: 1000,
		bank: 10,
		teamValue: 1000,
		totalTransfers: 2,
		transfersSyncedThroughEventId: 1,
		pastSeasonsCheckedAt: "2026-08-22T09:00:00.000Z",
		pastSeasonsCount: 1,
	},
	history: [historyRow(1)],
	pastSeasons: [{ season: "2526", totalPoints: 1000, overallRank: 500 }],
	gameweek: {
		state: "READY" as const,
		eventId: 1,
		result: {
			eventId: 1,
			eventPoints: 50,
			overallPoints: 100,
			overallRank: 1000,
			eventTransfers: 1,
			eventTransfersCost: 0,
			eventNetPoints: 50,
			eventBenchPoints: 2,
			eventChip: "NONE" as const,
			eventCaptainPoints: 10,
			playedCaptainWebName: "Captain",
			teamValue: 1000,
			bank: 10,
			picks: Array.from({ length: 15 }, (_, index) => snapshotPick(index + 1)),
		},
	},
	transfers: [
		{
			eventId: 1,
			elementInWebName: "Player 16",
			elementInTypeName: "DEF",
			elementInTeamShortName: "ARS",
			elementInCost: 50,
			elementOutWebName: "Player 15",
			elementOutTypeName: "DEF",
			elementOutTeamShortName: "CHE",
			elementOutCost: 49,
			time: "2026-08-22T09:00:00.000Z",
		},
	],
});

const snapshotAggregatePayload = () => ({
	eventId: 1,
	entryCount: 1,
	leaderOverallPoints: 100,
	secondOverallPoints: null,
	gapFirstSecond: null,
	averageOverallPoints: 100,
	metrics: [],
	viewers: {
		"123": {
			entryId: 123,
			overallRank: 1,
			tournamentOverallRank: 1,
			teamValue: 1000,
			tournamentTeamValueRank: 1,
			transfersNum: 1,
			tournamentTransfersRank: 1,
			totalCosts: 0,
			tournamentCostsRank: 1,
			totalBenchPoints: 2,
			tournamentBenchPointsRank: 1,
			autoSubPoints: 0,
			tournamentAutoSubRank: 1,
			overallPoints: 100,
			leaderOverallPoints: 100,
			gapToLeader: 0,
			pointsBehindNext: 0,
			pointsAheadOfPrev: 0,
		},
	},
	topPerformers: [],
	risers: [],
	fallers: [],
	captainDistribution: [],
	chipDistribution: [],
	seasonPaths: {
		"123": [
			{
				gameweek: 1,
				tournamentRank: 1,
				gapToLeader: 0,
				pointsVsAverage: 0,
				fieldSize: 1,
				overallPoints: 100,
				leaderOverallPoints: 100,
				averageOverallPoints: 100,
			},
		],
	},
});

const snapshotEntryRow = () => ({
	...snapshotPublicationRow,
	entry_row_count: 1,
	aggregate_row_count: 1,
	payload: snapshotPayload(),
	is_empty: false,
	picks_count: 15,
});

const snapshotBoardRow = () => ({
	field_size: 1,
	expected_field_size: 1,
	invalid_row_count: 0,
	total_rows: 1,
	rows: [
		{
			__snapshotEntryId: 123,
			eventId: 1,
			groupId: null,
			entryId: 123,
			entryName: "Codex XI",
			playerName: "Test Manager",
			rank: 1,
			previousRank: null,
			fieldRank: 1,
			eventPoints: 50,
			eventCost: 0,
			eventNetPoints: 50,
			eventRank: 1,
			overallPoints: 100,
			overallRank: 1,
			eventChip: "NONE",
			captainId: 1,
			captainWebName: "Captain",
			captainTeamShortName: "ARS",
			captainPoints: 10,
			teamValue: 1000,
			bank: 10,
		},
	],
	viewer_row: {
		__snapshotEntryId: 123,
		eventId: 1,
		groupId: null,
		entryId: 123,
		entryName: "Codex XI",
		playerName: "Test Manager",
		rank: 1,
		previousRank: null,
		fieldRank: 1,
		eventPoints: 50,
		eventCost: 0,
		eventNetPoints: 50,
		eventRank: 1,
		overallPoints: 100,
		overallRank: 1,
		eventChip: "NONE",
		captainId: 1,
		captainWebName: "Captain",
		captainTeamShortName: "ARS",
		captainPoints: 10,
		teamValue: 1000,
		bank: 10,
	},
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
		if (sql.includes("JOIN competition.my_fpl_snapshot_entries")) {
			return { rows: options.snapshotEntryRow ? [options.snapshotEntryRow] : [] };
		}
		if (sql.includes("FROM competition.my_fpl_snapshot_tournament_rows")) {
			return { rows: [options.snapshotBoardRow ?? {}] };
		}
		if (sql.includes("FROM competition.my_fpl_snapshot_tournament_aggregates aggregate")) {
			return {
				rows:
					options.snapshotAggregatePayload === undefined
						? []
						: [{ payload: options.snapshotAggregatePayload }],
			};
		}
		if (sql.includes("FROM competition.my_fpl_snapshot_tournament_aggregates")) {
			return {
				rows:
					options.snapshotSeasonPathPayload === undefined
						? []
						: [{ payload: options.snapshotSeasonPathPayload }],
			};
		}
		if (sql.includes("FROM competition.my_fpl_snapshot_publications")) {
			return {
				rows: sql.includes("AND active")
					? (options.publicationRows ?? [])
					: (options.pinnedPublicationRows ?? options.publicationRows ?? []),
			};
		}
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
			const rosterIds = options.membershipIds ?? (options.member === false ? [] : [7]);
			const ids = [...new Set([...rosterIds, ...(options.officialMembershipIds ?? [])])];
			if (sql.trimStart().startsWith("SELECT tournament_id")) {
				return {
					rows: ids.map((tournamentId) => ({ tournament_id: tournamentId })),
					rowCount: ids.length,
				};
			}
			const requestedTournamentId = Number(params.at(-1));
			const isMember = ids.includes(requestedTournamentId);
			return {
				rows: isMember ? [{ ok: 1 }] : [],
				rowCount: isMember ? 1 : 0,
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
		getCoreEventSnapshot: async () =>
			snapshotFor(options.currentEventId === undefined ? 2 : options.currentEventId) as never,
		getEntriesByIds: async (_context: GraphQLContext, ids: number[]) =>
			new Map(
				ids.map((id) => [
					id,
					{
						...snapshotPayload().entry,
						id,
						entryName: options.currentEntryNames?.[id] ?? snapshotPayload().entry.entryName,
					},
				])
			) as never,
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
		expect(myFplTestables.snapshotDateKey(new Date("2026-08-21T16:00:00.000Z"))).toBe("2026-08-22");
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
				field_rank: "5",
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
		).toMatchObject({
			rank: 7,
			previousRank: 9,
			fieldRank: 5,
			eventChip: "FREE_HIT",
		});
	});

	it("keeps only the previous UTC+8 day inside the daily provisional grace window", () => {
		const beforeObligation = new Date("2026-08-23T02:44:00.000Z");
		const duringObligation = new Date("2026-08-23T03:00:00.000Z");
		expect(myFplTestables.snapshotFreshness("2026-08-23", "PROVISIONAL", beforeObligation)).toBe(
			"CURRENT"
		);
		expect(myFplTestables.snapshotFreshness("2026-08-22", "PROVISIONAL", beforeObligation)).toBe(
			"CURRENT"
		);
		expect(myFplTestables.snapshotFreshness("2026-08-22", "PROVISIONAL", duringObligation)).toBe(
			"GENERATING"
		);
		expect(myFplTestables.snapshotFreshness("2026-08-21", "PROVISIONAL", beforeObligation)).toBe(
			"STALE"
		);
		expect(myFplTestables.snapshotFreshness("2026-08-24", "PROVISIONAL", beforeObligation)).toBe(
			"STALE"
		);
		expect(myFplTestables.snapshotFreshness("2026-01-01", "FINAL", beforeObligation)).toBe(
			"CURRENT"
		);
	});

	it("compares normalized PostgreSQL bigint snapshot revisions", () => {
		expect(myFplTestables.compareSnapshotRevisions("43", "42")).toBe(1);
		expect(myFplTestables.compareSnapshotRevisions("00042", "42")).toBe(0);
		expect(myFplTestables.compareSnapshotRevisions("9", "10")).toBe(-1);
	});

	it("reads every My FPL surface from one pinned daily publication", async () => {
		{
			const fixture = makeFixture({
				finalizedIds: [1],
				publicationRows: [snapshotPublicationRow],
				snapshotEntryRow: snapshotEntryRow(),
				snapshotBoardRow: snapshotBoardRow(),
				snapshotAggregatePayload: snapshotAggregatePayload(),
				snapshotSeasonPathPayload: snapshotAggregatePayload(),
			});

			const desk = await fixture.repository.loadTeamDesk(fixture.context, 1, "42");
			expect(desk.state).toBe("READY");
			expect(desk.selectedEventId).toBe(1);
			expect(desk.snapshotMeta).toMatchObject({ revision: "42", kind: "PROVISIONAL" });
			expect(desk.gameweek?.result?.picks).toHaveLength(15);

			const gameweek = await fixture.repository.loadTeamGameweek(fixture.context, 1, "42");
			expect(gameweek.state).toBe("READY");
			expect(gameweek.snapshotMeta?.revision).toBe("42");

			const transfers = await fixture.repository.loadTeamTransfers(fixture.context, "42");
			expect(transfers.state).toBe("READY");
			expect(transfers.gameweeks[0]?.transfers).toHaveLength(1);

			const competitions = await fixture.repository.loadCompetitionsDesk(
				fixture.context,
				7,
				1,
				"42"
			);
			expect(competitions.state).toBe("READY");
			expect(competitions.snapshotMeta?.revision).toBe("42");
			expect(competitions.board?.viewerRow?.entryId).toBe(123);
			expect(competitions.aggregate?.viewer?.entryId).toBe(123);

			const path = await fixture.repository.loadCompetitionSeasonPath(fixture.context, 7, 1, "42");
			expect(path.state).toBe("READY");
			expect(path.points[0]?.gameweek).toBe(1);
			expect(path.snapshotMeta?.revision).toBe("42");
		}
	});

	it("does not switch to a newer revision when a requested publication is unavailable", async () => {
		{
			const activePublication = { ...snapshotPublicationRow, revision: "43" };
			const fixture = makeFixture({
				finalizedIds: [1],
				publicationRows: [activePublication],
				pinnedPublicationRows: [],
				snapshotEntryRow: { ...snapshotEntryRow(), revision: "43" },
			});

			const desk = await fixture.repository.loadTeamDesk(fixture.context, 1, "42");

			expect(desk.state).toBe("PENDING");
			expect(desk.snapshotMeta).toBeNull();
			expect(
				fixture.queries.some(
					({ sql, params }) =>
						sql.includes("FROM competition.my_fpl_snapshot_publications") &&
						!sql.includes("AND active") &&
						params.includes("42")
				)
			).toBe(true);
			expect(fixture.queries.every(({ sql }) => !sql.includes("active OR"))).toBe(true);
		}
	});

	it("fails closed when the snapshot aggregate viewer is bound to another entry", async () => {
		{
			const aggregate = snapshotAggregatePayload();
			const fixture = makeFixture({
				publicationRows: [snapshotPublicationRow],
				snapshotEntryRow: snapshotEntryRow(),
				snapshotBoardRow: snapshotBoardRow(),
				snapshotAggregatePayload: {
					...aggregate,
					viewers: {
						"123": { ...aggregate.viewers["123"], entryId: 999 },
					},
				},
				snapshotSeasonPathPayload: aggregate,
			});
			const competitions = await fixture.repository.loadCompetitionsDesk(
				fixture.context,
				7,
				1,
				"42"
			);
			expect(competitions.aggregate).toBeNull();
		}
	});

	it("fails closed when the daily publication is absent or malformed", async () => {
		{
			const absent = makeFixture({ entryRows: [entryRow()] });
			expect((await absent.repository.loadTeamDesk(absent.context)).state).toBe("PENDING");
			expect((await absent.repository.loadTeamGameweek(absent.context, 1)).state).toBe("PENDING");
			expect((await absent.repository.loadTeamTransfers(absent.context)).state).toBe("PENDING");
			expect(
				(
					await absent.repository.loadCompetitionBoard(absent.context, {
						tournamentId: 7,
						eventId: 1,
					})
				).state
			).toBe("PENDING");

			const malformed = makeFixture({
				publicationRows: [{ ...snapshotPublicationRow, content_sha256: "bad" }],
				entryRows: [entryRow()],
			});
			const desk = await malformed.repository.loadTeamDesk(malformed.context, 1);
			expect(desk.state).toBe("PENDING");
			expect(desk.snapshotMeta).toBeNull();
		}
	});

	it("requires a viewer team and preserves the selected entry identity", async () => {
		const unauthenticated = makeFixture();
		unauthenticated.context.principal = undefined;
		await expect(
			unauthenticated.repository.loadTeamDesk(unauthenticated.context)
		).rejects.toMatchObject({
			extensions: { code: "VIEWER_ENTRY_REQUIRED" },
		});
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
		});
		const desk = await fixture.repository.loadTeamDesk(fixture.context);
		expect(desk.entry?.id).toBe(123);
		expect(desk.entry?.entryName).toBe("Codex XI");

		const miniViewer = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
		});
		miniViewer.context.principal = {
			userId: "mini-account-1",
			source: "wechat_miniprogram",
			viewerEntryId: 123,
			fplEntryId: null,
			fplEntryVerifiedAt: null,
		};
		expect((await miniViewer.repository.loadTeamDesk(miniViewer.context)).entry?.id).toBe(123);
	});

	it("overlays the current entry name on historical My FPL team payloads", async () => {
		const snapshotEntry = snapshotEntryRow();
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntry,
			currentEntryNames: { 123: "Renamed XI" },
		});

		const desk = await fixture.repository.loadTeamDesk(fixture.context, 1);

		expect(desk.entry?.entryName).toBe("Renamed XI");
		expect(desk.gameweek?.entry?.entryName).toBe("Renamed XI");
		expect((snapshotEntry.payload as { entry: { entryName: string } }).entry.entryName).toBe(
			"Codex XI"
		);
	});

	it("reports PRESEASON, EMPTY, PENDING and READY from durable checkpoints", async () => {
		const preseason = makeFixture({ currentEventId: null, finalizedIds: [] });
		expect((await preseason.repository.loadTeamDesk(preseason.context)).state).toBe("PRESEASON");
		const emptyPayload = {
			...snapshotPayload(),
			gameweek: { state: "EMPTY" as const, eventId: 1, result: null },
		};
		const empty = makeFixture({
			finalizedIds: [1],
			publicationRows: [
				{
					...snapshotPublicationRow,
					ready_entry_count: 0,
					empty_entry_count: 1,
				},
			],
			snapshotEntryRow: {
				...snapshotEntryRow(),
				payload: emptyPayload,
				is_empty: true,
				picks_count: 0,
			},
		});
		expect((await empty.repository.loadTeamDesk(empty.context)).state).toBe("EMPTY");
		const pending = makeFixture({ finalizedIds: [1], entryRows: [entryRow()] });
		const pendingDesk = await pending.repository.loadTeamDesk(pending.context);
		expect(pendingDesk.state).toBe("PENDING");
		const ready = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
		});
		expect((await ready.repository.loadTeamDesk(ready.context)).state).toBe("READY");
		expect(ready.redis.setCalls.at(-1)?.[3]).toBeGreaterThan(30);
	});

	it("distinguishes a confirmed empty past-season history from an unchecked history", async () => {
		const confirmedEmpty = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: {
				...snapshotEntryRow(),
				payload: {
					...snapshotPayload(),
					entry: {
						...snapshotPayload().entry,
						pastSeasonsCheckedAt: "2026-08-22T09:00:00.000Z",
						pastSeasonsCount: 0,
					},
					pastSeasons: [],
				},
			},
		});
		const readyDesk = await confirmedEmpty.repository.loadTeamDesk(confirmedEmpty.context);
		expect(readyDesk.pastSeasons).toEqual([]);
		expect(readyDesk.pastSeasonsState).toBe("READY");
		expect(confirmedEmpty.redis.setCalls.at(-1)?.[3]).toBeGreaterThan(30);

		const unchecked = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: {
				...snapshotEntryRow(),
				payload: {
					...snapshotPayload(),
					entry: {
						...snapshotPayload().entry,
						pastSeasonsCheckedAt: null,
						pastSeasonsCount: null,
					},
				},
			},
		});
		const uncheckedDesk = await unchecked.repository.loadTeamDesk(unchecked.context);
		expect(uncheckedDesk.pastSeasonsState).toBe("PENDING");
		expect(unchecked.redis.setCalls.at(-1)?.[3]).toBe(30);
	});

	it("does not promote incomplete finalized or rich-enriched data to READY", async () => {
		const lifecycleIncomplete = makeFixture({
			entryRows: [entryRow()],
			finalizedIds: [],
			currentEventId: null,
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

	it("does not read mutable rows when the selected publication is missing", async () => {
		const fixture = makeFixture({
			finalizedIds: [1, 2],
			entryRows: [entryRow()],
			historyRows: [historyRow(1)],
			gameweekRows: Array.from({ length: 15 }, (_, index) => gameweekRow(1, index + 1)),
		});

		const desk = await fixture.repository.loadTeamDesk(fixture.context, 1);

		expect(desk.state).toBe("PENDING");
		expect(desk.gameweek).toBeNull();
		expect(fixture.queries.some(({ sql }) => sql.includes("entry_event_results"))).toBe(false);
	});

	it("does not infer an empty gameweek from mutable entry rows", async () => {
		const fixture = makeFixture({
			finalizedIds: [1, 2],
			entryRows: [
				entryRow({
					started_event: 2,
					past_seasons_checked_at: "2026-08-20T00:00:00.000Z",
					past_seasons_count: 0,
				}),
			],
			pastSeasonRows: [],
			historyRows: [],
		});

		const desk = await fixture.repository.loadTeamDesk(fixture.context, 1);

		expect(desk.state).toBe("PENDING");
		expect(desk.gameweek).toBeNull();
		expect(fixture.queries.some(({ sql }) => sql.includes("competition.entries"))).toBe(false);
	});

	it("evicts malformed and schema-invalid cache values before querying PostgreSQL", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
		});
		const key = gqlCacheKey(fixture.context, "my-fpl:v10:team-desk:123:season:rev:42");
		await fixture.redis.set(key, JSON.stringify({ state: "READY", history: [] }));
		const desk = await fixture.repository.loadTeamDesk(fixture.context);
		expect(desk.state).toBe("READY");
		expect(await fixture.redis.get(key)).not.toBe(JSON.stringify({ state: "READY", history: [] }));
		const malformed = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
		});
		const malformedKey = gqlCacheKey(malformed.context, "my-fpl:v10:team-desk:123:season:rev:42");
		await malformed.redis.set(malformedKey, "{");
		await malformed.repository.loadTeamDesk(malformed.context);
		expect(await malformed.redis.get(malformedKey)).not.toBe("{");
	});

	it("keeps transfer and gameweek readiness fail-closed", async () => {
		const preseason = makeFixture({ currentEventId: null, finalizedIds: [] });
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
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
		});
		const gameweek = await fixture.repository.loadTeamGameweek(fixture.context, 1);
		expect(gameweek.state).toBe("READY");
		expect(gameweek.result?.picks).toHaveLength(15);
		expect(gameweek.result?.picks[0]?.isCaptain).toBe(true);
	});

	it("derives fixture count, BGW and DGW from the fixture aggregate", async () => {
		const payload = snapshotPayload();
		payload.gameweek.result.picks = payload.gameweek.result.picks.map((pick, index) => ({
			...pick,
			fixtureCount: index === 0 ? 0 : index === 1 ? 2 : 1,
			bgw: index === 0,
			dgw: index === 1,
		}));
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: { ...snapshotEntryRow(), payload },
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
		const basePayload = snapshotPayload();
		const payload = {
			...basePayload,
			gameweek: {
				...basePayload.gameweek,
				result: {
					...basePayload.gameweek.result,
					eventChip: "BENCH_BOOST" as string,
					picks: basePayload.gameweek.result.picks.map((pick) => ({
						...pick,
						autoSub: false,
					})),
				},
			},
		};
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: { ...snapshotEntryRow(), payload },
		});
		const gameweek = await fixture.repository.loadTeamGameweek(fixture.context, 1);
		expect(gameweek.state).toBe("READY");
		expect(gameweek.result?.eventChip).toBe("BENCH_BOOST");
		expect(gameweek.result?.picks.every((pick) => pick.autoSub)).toBe(false);
		expect(gameweek.result?.picks.every((pick) => !pick.autoSub)).toBe(true);
	});

	it("loads enriched transfer rows and groups them by gameweek", async () => {
		const payload = snapshotPayload();
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: {
				...snapshotEntryRow(),
				payload: {
					...payload,
					transfers: [
						{
							eventId: 1,
							elementInWebName: "In",
							elementInTypeName: "DEF",
							elementInTeamShortName: "ARS",
							elementInCost: 70,
							elementOutWebName: "Out",
							elementOutTypeName: "FWD",
							elementOutTeamShortName: "CHE",
							elementOutCost: 65,
							time: "2026-08-20T00:00:00.000Z",
						},
					],
				},
			},
		});
		const transfers = await fixture.repository.loadTeamTransfers(fixture.context);
		expect(transfers.state).toBe("READY");
		expect(transfers.gameweeks).toHaveLength(1);
		expect(transfers.gameweeks[0]?.transfers[0]?.elementInWebName).toBe("In");
	});

	it("rejects contradictory transfer counts in a daily snapshot", async () => {
		{
			const payload = snapshotPayload();
			const fixture = makeFixture({
				publicationRows: [snapshotPublicationRow],
				snapshotEntryRow: {
					...snapshotEntryRow(),
					payload: {
						...payload,
						history: [{ ...historyRow(1), eventTransfers: 0 }],
					},
				},
			});
			const transfers = await fixture.repository.loadTeamTransfers(fixture.context);
			expect(transfers.state).toBe("PENDING");
		}
	});

	it("validates tournament board pagination, pushes range to SQL, and warms its cache", async () => {
		const boardSnapshot = snapshotBoardRow();
		const boardSnapshotRow = { ...boardSnapshot.rows[0], entryName: "Foo", playerName: "A" };
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
			snapshotBoardRow: {
				...snapshotBoardRow(),
				field_size: 2,
				expected_field_size: 2,
				total_rows: 2,
				rows: [boardSnapshotRow],
				viewer_row: boardSnapshotRow,
			},
			currentEntryNames: { 123: "Current Foo" },
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
		const boardQuery = fixture.queries.find((query) => query.sql.includes("LIMIT $6 OFFSET $7"));
		expect(boardQuery?.params.slice(4, 7)).toEqual(["Foo", 1, 1]);
		expect(boardQuery?.sql).toContain("FROM competition.my_fpl_snapshot_tournament_rows");
		expect(boardQuery?.sql).toContain("JOIN competition.entries entry");
		expect(boardQuery?.sql).toContain("jsonb_build_object('entryName', entry.entry_name)");
		expect(page.rows[0]?.entryName).toBe("Current Foo");
		const queryCount = fixture.queries.filter((query) =>
			query.sql.includes("LIMIT $6 OFFSET $7")
		).length;
		await fixture.repository.loadCompetitionBoard(fixture.context, {
			tournamentId: 7,
			eventId: 1,
			page: 2,
			pageSize: 1,
			search: " Foo ",
		});
		expect(fixture.queries.filter((query) => query.sql.includes("LIMIT $6 OFFSET $7")).length).toBe(
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

	it("keeps a tracked official Classic membership without frozen roster membership", async () => {
		const classic = tournament({ id: 3, leagueId: 8_863, name: "Tracked Classic" });
		const fixture = makeFixture({
			member: false,
			membershipIds: [],
			officialMembershipIds: [3],
			selectedTournament: classic,
			catalog: [classic],
		});

		const desk = await fixture.repository.loadCompetitionsDesk(fixture.context);

		expect(desk.selectedTournamentId).toBe(3);
		expect(desk.tournaments.map((item) => item.id)).toEqual([3]);
		const membershipQueries = fixture.queries.filter((query) =>
			query.sql.includes("FROM competition.tournament_entries")
		);
		expect(membershipQueries.length).toBeGreaterThan(0);
		expect(
			membershipQueries.every(
				(query) =>
					query.sql.includes("FROM competition.entry_leagues entry_league") &&
					query.sql.includes("FROM competition.tournaments tournament") &&
					!query.sql.includes("competition.entry_leagues_with_tournament")
			)
		).toBe(true);
	});

	it("keeps platform administrator management separate from My FPL membership", async () => {
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

		await expect(fixture.repository.loadCompetitionsDesk(fixture.context, 7)).rejects.toMatchObject(
			{
				extensions: { code: "FORBIDDEN" },
			}
		);
		await expect(
			fixture.repository.loadCompetitionSetupStatus(fixture.context, 7)
		).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
	});

	it("returns the competitions desk with aggregate and season-path readiness", async () => {
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
			snapshotBoardRow: snapshotBoardRow(),
			snapshotAggregatePayload: snapshotAggregatePayload(),
			snapshotSeasonPathPayload: snapshotAggregatePayload(),
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
			field_rank: 1,
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
		const distributionPerformance = {
			entryId: 123,
			entryName: "Foo",
			playerName: "A",
			eventPoints: 60,
			eventNetPoints: 56,
			rank: 1,
			previousRank: 2,
			captainId: 11,
			captainWebName: "Saka",
			captainTeamShortName: "ARS",
			captainPoints: 20,
		};
		const distributionAggregate = {
			...snapshotAggregatePayload(),
			entryCount: 3,
			leaderOverallPoints: 100,
			secondOverallPoints: 90,
			gapFirstSecond: 10,
			averageOverallPoints: 90,
			metrics: [
				{
					key: "OVERALL_POINTS",
					leaderValue: 100,
					leaderEntryId: 123,
					leaderEntryName: "Foo",
					leaderPlayerName: "A",
					averageValue: 90,
					higherIsBetter: true,
				},
			],
			topPerformers: [distributionPerformance],
			risers: [distributionPerformance],
			fallers: [{ ...distributionPerformance, entryId: 125, entryName: "Baz", playerName: "C" }],
			captainDistribution: [
				{
					key: "11",
					label: "Saka",
					teamShortName: "ARS",
					count: 2,
					percentage: 66.67,
					averagePoints: 15,
				},
			],
			chipDistribution: [
				{
					key: "BENCH_BOOST",
					label: "BENCH_BOOST",
					teamShortName: null,
					count: 1,
					percentage: 33.33,
					averagePoints: 56,
				},
			],
		};
		const boardSnapshot = snapshotBoardRow();
		const boardSnapshotRow = {
			...boardSnapshot.rows[0],
			...{
				entryName: "Foo",
				playerName: "A",
				eventPoints: 60,
				eventNetPoints: 56,
			},
		};
		const fixture = makeFixture({
			finalizedIds: [1],
			publicationRows: [snapshotPublicationRow],
			snapshotEntryRow: snapshotEntryRow(),
			snapshotBoardRow: {
				...snapshotBoardRow(),
				field_size: 3,
				expected_field_size: 3,
				total_rows: 3,
				rows: [boardSnapshotRow],
				viewer_row: boardSnapshotRow,
			},
			snapshotAggregatePayload: distributionAggregate,
			currentEntryNames: { 123: "Current Foo", 125: "Current Baz" },
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
		expect(aggregate?.topPerformers[0]?.entryName).toBe("Current Foo");
		expect(aggregate?.risers[0]?.entryId).toBe(123);
		expect(aggregate?.fallers[0]?.entryId).toBe(125);
		expect(aggregate?.fallers[0]?.entryName).toBe("Current Baz");
		expect(aggregate?.metrics[0]?.leaderEntryName).toBe("Current Foo");
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

	it("does not convert missing durable publication into empty data or success cache", async () => {
		const fixture = makeFixture({
			queryOverride: async (sql) => {
				if (sql.includes("FROM competition.entries")) throw new Error("database unavailable");
				if (sql.includes("FROM fpl.events")) return { rows: [] };
				return { rows: [] };
			},
		});
		const desk = await fixture.repository.loadTeamDesk(fixture.context);
		expect(desk.state).toBe("PENDING");
		expect(desk.entry).toBeNull();
		expect(fixture.queries.some((query) => query.sql.includes("competition.entries"))).toBe(false);
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
