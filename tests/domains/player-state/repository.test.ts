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
	omitCurrentSeasonRows?: boolean;
	currentLifecycleState?: string;
	closedHistoricalSeason?: boolean;
	negativeCurrentPoints?: boolean;
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

const verifiedLink: QueryResultRow = {
	status: "auto_verified",
	rule_id: "understat-fpl-player-name",
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

const playerStateRows = (fixture: QueryFixture): QueryResultRow[] => {
	const link = fixture.link === undefined ? verifiedLink : fixture.link;
	if (fixture.understatError) throw fixture.understatError;
	const providerRows = fixture.understatRows ?? defaultUnderstatRows;
	const providerBySeasonAndCode = new Map(
		providerRows.map((row) => [`${row.season}:${row.player_code}`, row] as const)
	);
	const statusForSeason = (season: string): string => {
		if (link === null) return "UNAVAILABLE";
		if (link.status === "ambiguous") return "AMBIGUOUS";
		if (link.status === "quarantined") return "QUARANTINED";
		if (isVerifiedStatus(link.status)) {
			const confirmed =
				typeof link.evidence === "object" && link.evidence !== null
					? (link.evidence as { confirmedSeasons?: unknown }).confirmedSeasons
					: [];
			return Array.isArray(confirmed) && confirmed.includes(season) ? "VERIFIED" : "UNVERIFIED";
		}
		return "UNVERIFIED";
	};
	const rows: QueryResultRow[] = [];
	for (const [season, minutes, points, bonus, returns] of [
		["2324", 2700, 170, 20, 18],
		["2425", 2800, 185, 22, 20],
		["2526", 1000, 70, 9, 8],
	] as const) {
		if (fixture.omitCurrentSeasonRows && season === "2526") continue;
		for (const [playerCode, elementId] of [
			[100, 10],
			[200, 20],
		] as const) {
			const mappingStatus = statusForSeason(season);
			const provider =
				mappingStatus === "VERIFIED"
					? providerBySeasonAndCode.get(`${season}:${playerCode}`)
					: undefined;
			const providerMinutes = provider ? Number(provider.minutes) : null;
			const providerSourceHash: unknown = provider?.source_hash;
			const providerUpdatedAt: unknown = provider?.updated_at;
			const per90 = (value: number | string | null | undefined): number | null =>
				provider && providerMinutes && value !== null && value !== undefined
					? (Number(value) * 90) / providerMinutes
					: null;
			rows.push({
				season_id: season === "2526" ? 2025 : season === "2425" ? 2024 : 2023,
				season_code: season,
				lifecycle_state:
					season === "2526"
						? (fixture.currentLifecycleState ?? "active")
						: fixture.closedHistoricalSeason
							? "closed"
							: "completed",
				player_code: playerCode,
				element_id: elementId,
				element_type: 3,
				fpl_minutes: minutes,
				fpl_gameweeks: season === "2526" ? 10 : 38,
				fpl_total_points: fixture.negativeCurrentPoints && season === "2526" ? -5 : points,
				fpl_starts: season === "2526" ? 10 : 30,
				fpl_clean_sheets: season === "2526" ? 2 : 8,
				fpl_saves: 0,
				fpl_points_per_90: (points * 90) / minutes,
				fpl_return_rate: (returns / (season === "2526" ? 10 : 38)) * 100,
				fpl_bonus_per_90: (bonus * 90) / minutes,
				fpl_position_percentile: playerCode === 100 ? 75 : 45,
				fpl_peer_count: 2,
				expected_metrics_available: season !== "2324",
				fpl_source_hash: `${season}-${playerCode}-fpl-hash`,
				fpl_source_updated_at: "2026-08-08T00:00:00.000Z",
				understat_mapping_status: mappingStatus,
				understat_player_id: provider ? Number(provider.player_id) : null,
				understat_season_state: provider ? "complete" : null,
				understat_minutes: providerMinutes,
				understat_npxg_per_90: per90(provider?.non_penalty_xg),
				understat_xa_per_90: per90(provider?.xa),
				understat_shots_per_90: per90(provider?.shots),
				understat_key_passes_per_90: per90(provider?.key_passes),
				understat_xg_chain_per_90: per90(provider?.xg_chain),
				understat_xg_buildup_per_90: per90(provider?.xg_buildup),
				understat_npxg_percentile: provider ? 70 : null,
				understat_xa_percentile: provider ? 65 : null,
				understat_shots_percentile: provider ? 60 : null,
				understat_key_passes_percentile: provider ? 55 : null,
				understat_xg_chain_percentile: provider ? 68 : null,
				understat_xg_buildup_percentile: provider ? 62 : null,
				understat_process_percentile: provider ? 65 : null,
				understat_peer_count: provider ? 2 : 0,
				understat_source_hash: typeof providerSourceHash === "string" ? providerSourceHash : null,
				understat_source_updated_at:
					typeof providerUpdatedAt === "string" || providerUpdatedAt instanceof Date
						? providerUpdatedAt
						: null,
				refreshed_at: "2026-08-08T00:00:00.000Z",
			});
		}
	}
	return rows;
};

const makeExecutor = (
	fixture: QueryFixture = {}
): Readonly<{ executor: QueryExecutor; queries: string[] }> => {
	const queries: string[] = [];
	const executor: QueryExecutor = {
		query: async <Row extends QueryResultRow>(text: string) => {
			queries.push(text);
			let rows: QueryResultRow[];
			if (text.includes("player-state:dataset-revision")) {
				rows = [
					{
						revision: 17,
						method_version: "1",
						source_updated_at: "2026-08-08T00:00:00.000Z",
						refreshed_at: "2026-08-08T00:00:00.000Z",
					},
				];
			} else if (text.includes("player-state:season-rows")) {
				rows = playerStateRows(fixture);
			} else if (text.includes("player-state:markets-batch")) {
				rows = [
					{
						element_id: 10,
						status: "a",
						chance_this_round: 100,
						captured_at: new Date().toISOString(),
					},
				];
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
				{
					id: 20,
					code: 200,
					type: 3,
					teamId: 2,
					price: 70,
					startPrice: 70,
					firstName: "Peer",
					secondName: "Player",
					webName: "Peer",
					totalPoints: 45,
					selectedByPercent: 5,
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

const makeContext = (redis: TestRedis, lifecycleState?: "preseason" | "active"): GraphQLContext =>
	({
		currentSeason: {
			seasonId: 2025,
			seasonCode: "2526",
			...(lifecycleState ? { lifecycleState } : {}),
		},
		dataRevision: "9",
		redis,
		logger: testLogger,
		database: {},
		data: {},
	}) as unknown as GraphQLContext;

describe("Player State repository", () => {
	it("batch-reads two profile cache keys with one Redis MGET", async () => {
		const redis = new TestRedis();
		let mgetCalls = 0;
		let getCalls = 0;
		const originalMget = redis.mget;
		const originalGet = redis.get;
		redis.mget = async (...keys: string[]) => {
			mgetCalls += 1;
			return originalMget(...keys);
		};
		redis.get = async (key: string) => {
			getCalls += 1;
			return originalGet(key);
		};
		const { executor, queries } = makeExecutor();
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});
		const profiles = await repository.getPlayerStateProfiles(makeContext(redis), [10, 20], 5);

		expect(profiles.get(10)?.playerId).toBe(10);
		expect(profiles.get(20)?.playerId).toBe(20);
		expect(mgetCalls).toBe(1);
		expect(getCalls).toBe(0);
		expect(queries.filter((query) => query.includes("player-state:current-peers"))).toHaveLength(1);
		expect(
			queries.filter((query) => query.includes("player-state:current-gameweeks"))
		).toHaveLength(1);
	});

	it("uses the season projection and exposes current plus historical Understat coverage", async () => {
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
		expect(first?.providerMode).toBe("FPL_WITH_UNDERSTAT_CURRENT");
		expect(
			first?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "CURRENT"
			)?.mappingStatus
		).toBe("VERIFIED");
		expect(
			first?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "HISTORY"
			)?.seasons
		).toEqual(["2425"]);
		expect(
			first?.dimensions
				.find((dimension) => dimension.kind === "REAL_WORLD_PROCESS")
				?.metrics.map((item) => item.code)
		).toContain("UNDERSTAT_NPXG_PER_90");
		expect(queries.filter((query) => query.includes("player-state:season-rows"))).toHaveLength(1);
		expect(queries.some((query) => query.includes("bridge.entity_links"))).toBe(false);
		expect(queries.some((query) => query.includes("understat.player_seasons"))).toBe(false);
		expect(redis.setCalls[0]?.slice(2)).toEqual(["EX", PLAYER_STATE_SUCCESS_CACHE_TTL_SECONDS]);
		expect(redis.setCalls[0]?.[0]).toStartWith("llm:gql:9:");
		expect(first?.seasonTimeline.map((point) => point.season)).toEqual(["2526", "2425", "2324"]);
		expect(first?.seasonTimeline[0]).toMatchObject({
			season: "2526",
			phase: "ACTIVE",
			position: 3,
			fplTotalPoints: 70,
		});
		expect(first?.seasonTimeline[0]?.signals.map((signal) => signal.code)).toEqual([
			"UNDERSTAT_NPXG_XA_PER_90",
			"UNDERSTAT_KEY_PASSES_PER_90",
		]);
		expect(
			first?.seasonTimeline[0]?.signals.every((signal) => signal.analysisStatus === "READY")
		).toBe(true);
		expect(
			first?.seasonTimeline[2]?.signals.every((signal) => signal.analysisStatus === "UNAVAILABLE")
		).toBe(true);

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
		expect(profile?.providerMode).toBe("FPL_ONLY");
		expect(
			profile?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "CURRENT"
			)?.mappingStatus
		).toBe("UNAVAILABLE");
		expect(
			profile?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "HISTORY"
			)?.dataStatus
		).toBe("UNAVAILABLE");
		expect(profile?.coverage.limitations).not.toContain("PLAYER_MAPPING_UNAVAILABLE");
		expect(queries.some((query) => query.includes("player-state:understat-cohorts"))).toBe(false);
	});

	it("keeps Understat history when the current Understat season has no row", async () => {
		const redis = new TestRedis();
		const { executor } = makeExecutor({
			understatRows: defaultUnderstatRows.filter((row) => row.season === "2425"),
		});
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(profile?.providerMode).toBe("FPL_WITH_UNDERSTAT_HISTORY");
		expect(
			profile?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "CURRENT"
			)?.dataStatus
		).toBe("UNAVAILABLE");
		expect(
			profile?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "HISTORY"
			)?.seasons
		).toEqual(["2425"]);
		expect(profile?.coverage.limitations).not.toContain("UNDERSTAT_PLAYER_DATA_UNAVAILABLE");
	});

	it("does not infer preseason when a current FPL projection row is missing", async () => {
		const redis = new TestRedis();
		const { executor } = makeExecutor({ omitCurrentSeasonRows: true });
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis, "active"), 10, 5);
		const current = profile?.seasonTimeline[0];
		expect(current).toMatchObject({
			season: "2526",
			phase: "ACTIVE",
			fplTotalPoints: null,
		});
		expect(
			current?.signals.every((signal) => signal.reasonCodes.includes("FPL_SEASON_ROW_UNAVAILABLE"))
		).toBe(true);

		const preseason = await repository.getPlayerStateProfile(
			makeContext(new TestRedis(), "preseason"),
			10,
			5
		);
		expect(preseason?.seasonTimeline[0]).toMatchObject({
			season: "2526",
			phase: "PRESEASON",
			fplTotalPoints: null,
		});
	});

	it("keeps closed history and reference-only current seasons out of active analysis", async () => {
		const redis = new TestRedis();
		const { executor } = makeExecutor({
			closedHistoricalSeason: true,
			currentLifecycleState: "reference_only",
		});
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(profile?.seasonTimeline.map((point) => point.season)).toEqual(["2526", "2425", "2324"]);
		expect(profile?.seasonTimeline[0]).toMatchObject({
			phase: "PRESEASON",
			fplTotalPoints: null,
		});
	});

	it("accepts negative FPL totals in a completed season timeline", async () => {
		const redis = new TestRedis();
		const { executor } = makeExecutor({ negativeCurrentPoints: true });
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(profile?.seasonTimeline[0]?.fplTotalPoints).toBe(-5);
	});

	it("preserves an ambiguous mapping without reading Understat metrics", async () => {
		const redis = new TestRedis();
		const { executor, queries } = makeExecutor({
			link: {
				status: "ambiguous",
				rule_id: "understat-fpl-player-name",
				left_entity_id: "1000",
				evidence: { confirmedSeasons: ["2526"] },
			},
		});
		const repository = createPlayerStateRepository({
			executor,
			loadCoreSnapshot: async () => snapshot(),
		});

		const profile = await repository.getPlayerStateProfile(makeContext(redis), 10, 5);
		expect(profile?.providerMode).toBe("FPL_ONLY");
		expect(
			profile?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "CURRENT"
			)?.mappingStatus
		).toBe("AMBIGUOUS");
		expect(profile?.coverage.limitations).not.toContain("PLAYER_MAPPING_AMBIGUOUS");
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
