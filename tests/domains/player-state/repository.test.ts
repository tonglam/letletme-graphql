import { describe, expect, it } from "bun:test";
import type { QueryResultRow } from "pg";
import type { GraphQLContext } from "../../../src/graphql/context";
import type { QueryExecutor } from "../../../src/infra/database";
import type { CoreDataSnapshot } from "../../../src/infra/data-snapshot";
import {
	createPlayerStateRepository,
	PLAYER_STATE_NULL_CACHE_TTL_SECONDS,
	PLAYER_STATE_SUCCESS_CACHE_TTL_SECONDS,
} from "../../../src/domains/player-state/repository";
import { TestRedis, testLogger } from "../../helpers/data-publication";

type QueryFixture = Readonly<{
	link?: QueryResultRow | null;
	understatRows?: QueryResultRow[];
	understatError?: Error;
}>;

const isVerifiedStatus = (status: unknown): boolean =>
	status === "auto_verified" || status === "manual_verified";

const currentSummaryRows: QueryResultRow[] = [
	{
		element_id: 10,
		total_points: 80,
		minutes: 900,
		bonus: 12,
		starts: 10,
		goals_scored: 5,
		assists: 6,
		clean_sheets: 3,
		saves: 0,
		bps: 220,
		expected_goal_involvements: "10.2",
	},
	{
		element_id: 20,
		total_points: 45,
		minutes: 900,
		bonus: 4,
		starts: 10,
		goals_scored: 2,
		assists: 2,
		clean_sheets: 2,
		saves: 0,
		bps: 130,
		expected_goal_involvements: "4.1",
	},
	{
		element_id: 30,
		total_points: 110,
		minutes: 900,
		bonus: 20,
		starts: 10,
		goals_scored: 8,
		assists: 8,
		clean_sheets: 4,
		saves: 0,
		bps: 300,
		expected_goal_involvements: "15.4",
	},
];

const currentGameweekRows: QueryResultRow[] = Array.from({ length: 10 }, (_, index) =>
	[10, 20, 30].map((elementId) => ({
		element_id: elementId,
		event_id: index + 1,
		total_points: elementId === 10 ? 8 : elementId === 20 ? 4 : 11,
		minutes: 90,
		started: true,
		bonus: elementId === 10 ? 1 : elementId === 20 ? 0 : 2,
	}))
).flat();

const historyRows: QueryResultRow[] = [
	["2324", 100, 120, 2700, 170, 20, 18, 38],
	["2324", 200, 120, 2500, 120, 8, 10, 38],
	["2324", 300, 120, 2800, 210, 30, 22, 38],
	["2425", 100, 120, 2800, 185, 22, 20, 38],
	["2425", 200, 120, 2600, 130, 10, 11, 38],
	["2425", 300, 120, 2850, 220, 34, 24, 38],
].map(([season, playerCode, position, minutes, totalPoints, bonus, returns, gameweeks]) => ({
	season,
	player_code: playerCode,
	position: Number(position) / 40,
	minutes,
	total_points: totalPoints,
	bonus,
	return_count: returns,
	gameweek_count: gameweeks,
	as_of: `${season}-05-20T00:00:00.000Z`,
}));

const verifiedLink: QueryResultRow = {
	status: "auto_verified",
	rule_version: "understat-fpl-player-name-v3",
	left_entity_id: "1000",
	evidence: { confirmedSeasons: ["2425", "2526"] },
};

const understatRow = (
	season: string,
	playerCode: number,
	playerId: number,
	minutes: number,
	npxg: number,
	xa: number
): QueryResultRow => ({
	season,
	season_state: "complete",
	season_last_seen_at: "2026-08-08T00:00:00.000Z",
	player_code: playerCode,
	player_id: playerId,
	is_subject: playerCode === 100,
	minutes,
	position: "M",
	non_penalty_xg: npxg,
	xa,
	shots: Math.round(npxg * 5),
	key_passes: Math.round(xa * 6),
	xg_chain: npxg + xa + 4,
	xg_buildup: xa + 2,
	source_hash: `${season}-${playerId}-hash`,
	updated_at: "2026-08-08T00:00:00.000Z",
});

const defaultUnderstatRows: QueryResultRow[] = [
	understatRow("2425", 100, 1000, 2600, 7, 6),
	understatRow("2425", 200, 2000, 2500, 4, 3),
	understatRow("2425", 300, 3000, 2700, 10, 8),
	understatRow("2526", 100, 1000, 1000, 5, 4),
	understatRow("2526", 200, 2000, 1000, 2, 2),
	understatRow("2526", 300, 3000, 1000, 8, 6),
];

const makeExecutor = (
	fixture: QueryFixture = {}
): Readonly<{ executor: QueryExecutor; queries: string[] }> => {
	const queries: string[] = [];
	const executor: QueryExecutor = {
		query: async <Row extends QueryResultRow>(text: string) => {
			queries.push(text);
			let rows: QueryResultRow[];
			if (text.includes("player-state:provider-link-verified")) {
				rows =
					fixture.link === undefined || isVerifiedStatus(fixture.link?.status)
						? [fixture.link ?? verifiedLink]
						: [];
			} else if (text.includes("player-state:provider-link-unresolved")) {
				rows = fixture.link && !isVerifiedStatus(fixture.link.status) ? [fixture.link] : [];
			} else if (text.includes("player-state:understat-cohorts")) {
				if (fixture.understatError) throw fixture.understatError;
				rows = fixture.understatRows ?? defaultUnderstatRows;
			} else if (text.includes("player-state:market")) {
				rows = [
					{
						status: "a",
						chance_this_round: 100,
						captured_at: new Date().toISOString(),
					},
				];
			} else if (text.includes("player-state:current-peers")) {
				rows = currentSummaryRows;
			} else if (text.includes("player-state:current-gameweeks")) {
				rows = currentGameweekRows;
			} else if (text.includes("player-state:fpl-history")) {
				rows = historyRows;
			} else {
				throw new Error(`Unexpected query: ${text}`);
			}
			return { rows: rows as Row[], rowCount: rows.length } as never;
		},
	};
	return { executor, queries };
};

const snapshot = (players = true): CoreDataSnapshot => ({
	source: "postgres",
	seasonCode: "2526",
	revision: "9",
	publicationId: "00000000-0000-4000-8000-000000000009",
	sourceCheckedAt: "2026-08-08T00:00:00.000Z",
	currentEventId: 10,
	events: Array.from({ length: 38 }, (_, index) => ({
		id: index + 1,
		name: `Gameweek ${index + 1}`,
		deadlineTime: null,
		averageEntryScore: null,
		finished: index < 9,
		dataChecked: index < 9,
		highestScoringEntry: null,
		deadlineTimeEpoch: null,
		deadlineTimeGameOffset: null,
		highestScore: null,
		isPrevious: index === 8,
		isCurrent: index === 9,
		isNext: index === 10,
		cupLeagueCreate: false,
		h2hKoMatchesCreated: false,
		chipPlays: [],
		mostSelected: null,
		mostTransferredIn: null,
		topElement: null,
		topElementInfo: null,
		transfersMade: null,
		mostCaptained: null,
		mostViceCaptained: null,
	})),
	teams: [
		{
			id: 1,
			code: 1,
			name: "Alpha",
			shortName: "ALP",
			strength: 3,
			position: 1,
			points: 20,
			played: 10,
			win: 6,
			draw: 2,
			loss: 2,
			form: null,
			strengthOverallHome: 1000,
			strengthOverallAway: 1000,
			strengthAttackHome: 1000,
			strengthAttackAway: 1000,
			strengthDefenceHome: 1000,
			strengthDefenceAway: 1000,
		},
		{
			id: 2,
			code: 2,
			name: "Beta",
			shortName: "BET",
			strength: 3,
			position: 2,
			points: 18,
			played: 10,
			win: 5,
			draw: 3,
			loss: 2,
			form: null,
			strengthOverallHome: 1000,
			strengthOverallAway: 1000,
			strengthAttackHome: 1000,
			strengthAttackAway: 1000,
			strengthDefenceHome: 1000,
			strengthDefenceAway: 1000,
		},
	],
	players: players
		? [
				{
					id: 10,
					code: 100,
					type: 3,
					teamId: 1,
					price: 80,
					startPrice: 75,
					firstName: "Test",
					secondName: "Player",
					webName: "Player",
					totalPoints: 80,
					selectedByPercent: 10,
				},
			]
		: [],
	phases: [{ id: 1, name: "Overall", startEvent: 1, stopEvent: 38, highestScore: null }],
	fixtures: Array.from({ length: 38 }, (_, index) => ({
		id: index + 1,
		code: 1000 + index,
		eventId: index + 1,
		finished: index < 9,
		finishedProvisional: false,
		kickoffTime: null,
		minutes: index < 9 ? 90 : 0,
		started: index < 10,
		teamHId: index % 2 === 0 ? 1 : 2,
		teamAId: index % 2 === 0 ? 2 : 1,
		teamHScore: null,
		teamAScore: null,
		teamHDifficulty: 3,
		teamADifficulty: 3,
	})),
});

const makeContext = (redis: TestRedis): GraphQLContext =>
	({
		currentSeason: { seasonId: 2025, seasonCode: "2526" },
		dataRevision: "9",
		redis,
		logger: testLogger,
		database: {},
		data: {},
	}) as unknown as GraphQLContext;

describe("Player State v3 repository", () => {
	it("uses a season-confirmed bridge link and direct Understat PostgreSQL cohort", async () => {
		const redis = new TestRedis();
		const { executor, queries } = makeExecutor();
		let snapshotLoads = 0;
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => {
				snapshotLoads += 1;
				return snapshot();
			},
		});

		const first = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(first?.coverage.mappingStatus).toBe("VERIFIED");
		expect(first?.coverage.understatCurrent).toBe(true);
		expect(first?.fplOnly).toBe(false);
		expect(
			first?.dimensions
				.find((dimension) => dimension.kind === "REAL_WORLD_PROCESS")
				?.metrics.map((item) => item.code)
		).toContain("UNDERSTAT_NPXG_PER_90");
		expect(queries.some((query) => query.includes("bridge.entity_links"))).toBe(true);
		expect(queries.some((query) => query.includes("understat.player_seasons"))).toBe(true);
		expect(redis.setCalls[0]?.slice(2)).toEqual(["EX", PLAYER_STATE_SUCCESS_CACHE_TTL_SECONDS]);
		expect(redis.setCalls[0]?.[0]).toStartWith("llm:v3:gql:v3:9:");

		const queryCount = queries.length;
		const second = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(second).toEqual(first);
		expect(queries).toHaveLength(queryCount);
		expect(snapshotLoads).toBe(1);
	});

	it("returns an explicit FPL-only profile when no verified link exists", async () => {
		const redis = new TestRedis();
		const { executor, queries } = makeExecutor({ link: null });
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(profile?.fplOnly).toBe(true);
		expect(profile?.coverage.mappingStatus).toBe("UNAVAILABLE");
		expect(profile?.coverage.limitations).toContain("PLAYER_MAPPING_UNAVAILABLE");
		expect(queries.some((query) => query.includes("player-state:understat-cohorts"))).toBe(false);
	});

	it("keeps a verified mapping but degrades to FPL-only when Understat has no row", async () => {
		const redis = new TestRedis();
		const { executor } = makeExecutor({ understatRows: [] });
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(profile?.coverage.mappingStatus).toBe("VERIFIED");
		expect(profile?.coverage.understatCurrent).toBe(false);
		expect(profile?.coverage.limitations).toContain("UNDERSTAT_PLAYER_DATA_UNAVAILABLE");
		expect(profile?.fplOnly).toBe(true);
	});

	it("preserves an ambiguous mapping without reading Understat metrics", async () => {
		const redis = new TestRedis();
		const { executor, queries } = makeExecutor({
			link: {
				status: "ambiguous",
				rule_version: "understat-fpl-player-name-v3",
				left_entity_id: "1000",
				evidence: { confirmedSeasons: ["2526"] },
			},
		});
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(profile?.coverage.mappingStatus).toBe("AMBIGUOUS");
		expect(profile?.coverage.limitations).toContain("PLAYER_MAPPING_AMBIGUOUS");
		expect(profile?.fplOnly).toBe(true);
		expect(queries.some((query) => query.includes("player-state:understat-cohorts"))).toBe(false);
	});

	it("propagates provider errors and never turns them into cached no-data", async () => {
		const redis = new TestRedis();
		const providerError = new Error("Understat provider unavailable");
		const { executor } = makeExecutor({ understatError: providerError });
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		await expect(repository.getPlayerStateProfile(makeContext(redis), 10, 5)).rejects.toBe(
			providerError
		);
		expect(redis.setCalls).toHaveLength(0);
	});

	it("caches a valid missing-player null for exactly 60 seconds", async () => {
		const redis = new TestRedis();
		const { executor, queries } = makeExecutor();
		let snapshotLoads = 0;
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => {
				snapshotLoads += 1;
				return snapshot(false);
			},
		});

		await expect(repository.getPlayerStateProfile(makeContext(redis), 999, 5)).resolves.toBeNull();
		expect(redis.setCalls[0]?.[1]).toBe("__player_state:null__");
		expect(redis.setCalls[0]?.slice(2)).toEqual(["EX", PLAYER_STATE_NULL_CACHE_TTL_SECONDS]);
		await expect(repository.getPlayerStateProfile(makeContext(redis), 999, 5)).resolves.toBeNull();
		expect(snapshotLoads).toBe(1);
		expect(queries).toHaveLength(0);
	});
});
