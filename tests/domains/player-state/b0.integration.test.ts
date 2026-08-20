import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { Pool, type QueryResultRow } from "pg";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	createPlayerStateRepository,
	type PlayerStateRepository,
} from "../../../src/domains/player-state/repository";
import {
	coreDatasetRevision,
	getCoreDataSnapshot,
	type CoreDataSnapshot,
} from "../../../src/infra/data-snapshot";
import { gqlCacheKey } from "../../../src/infra/cache-key";
import { ReadModelClient } from "../../../src/infra/read-model-client";
import { TestRedis, testLogger } from "../../helpers/data-publication";

const enabled = process.env.RUN_B0_PLAYER_STATE === "1";
const databaseUrl = process.env.B0_DATABASE_URL;
const hasPgEnvironment = Boolean(
	process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE
);
const redisHost = process.env.B0_REDIS_HOST;
const redisPort = Number(process.env.B0_REDIS_PORT);
const hasRedisEnvironment = Boolean(redisHost && Number.isSafeInteger(redisPort) && redisPort > 0);

type SeasonRow = QueryResultRow & {
	season_id: number;
	season_code: string;
};

type SubjectRow = QueryResultRow & {
	element_id: number;
	code: number;
	element_type: number;
	team_id: number;
};

type EventRow = QueryResultRow & {
	event_id: number;
};

type TeamRow = QueryResultRow & {
	team_id: number;
	short_name: string;
};

type FixtureRow = QueryResultRow & {
	fixture_id: number;
	event_id: number | null;
	team_h_id: number;
	team_a_id: number;
	team_h_difficulty: number | null;
	team_a_difficulty: number | null;
	kickoff_time: Date | string | null;
};

const percentile95 = (samples: number[]): number => {
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
};

describe.skipIf(!enabled || (!databaseUrl && !hasPgEnvironment))(
	"Player State restored-B0 integration",
	() => {
		const pool = new Pool({ ...(databaseUrl ? { connectionString: databaseUrl } : {}), max: 4 });
		let repository: PlayerStateRepository;
		let coreSnapshot: CoreDataSnapshot;
		let season: SeasonRow;
		let subject: SubjectRow;
		let playerStateDatasetRevision: string;

		beforeAll(async () => {
			season = (
				await pool.query<SeasonRow>(
					`SELECT season_id, season_code
				 FROM fpl.seasons
				 WHERE season_code = '2526'`
				)
			).rows[0]!;
			playerStateDatasetRevision = String(
				(
					await pool.query<{ revision: number | string }>(
						`SELECT revision
						 FROM reporting.player_state_dataset_metadata
						 WHERE dataset_key = 'player_state'`
					)
				).rows[0]?.revision ?? ""
			);
			if (!playerStateDatasetRevision) {
				throw new Error("Player State dataset metadata is not published");
			}
			subject = (
				await pool.query<SubjectRow>(
					`SELECT player.element_id, player.code, player.element_type, player.team_id
				 FROM fpl.players player
				 JOIN bridge.entity_links link
				   ON link.entity_type = 'player'
				  AND link.left_provider = 'understat'
				  AND link.right_provider = 'fpl'
				  AND link.right_entity_id = player.code::text
				  AND link.status IN ('auto_verified', 'manual_verified')
				  AND link.evidence -> 'confirmedSeasons' ? $2
				 JOIN understat.player_seasons metrics
				   ON metrics.season_code = $2
				  AND metrics.player_id = link.left_entity_id::integer
				 WHERE player.season_id = $1
				   AND player.element_type <> 1
				   AND metrics.time_minutes >= 900
				 ORDER BY metrics.time_minutes DESC, player.element_id
				 LIMIT 1`,
					[season.season_id, season.season_code]
				)
			).rows[0]!;
			const [events, teams, fixtures] = await Promise.all([
				pool.query<EventRow>(
					`SELECT event_id FROM fpl.events WHERE season_id = $1 ORDER BY event_id`,
					[season.season_id]
				),
				pool.query<TeamRow>(
					`SELECT team_id, short_name FROM fpl.teams WHERE season_id = $1 ORDER BY team_id`,
					[season.season_id]
				),
				pool.query<FixtureRow>(
					`SELECT fixture_id, event_id, team_h_id, team_a_id, team_h_difficulty,
				        team_a_difficulty, kickoff_time
				 FROM fpl.fixtures
				 WHERE season_id = $1
				 ORDER BY fixture_id`,
					[season.season_id]
				),
			]);
			const finalEventId = events.rows.at(-1)?.event_id ?? 38;
			coreSnapshot = {
				source: "postgres",
				seasonCode: season.season_code,
				revision: "b0-2526",
				publicationId: "00000000-0000-4000-8000-000000002526",
				sourceCheckedAt: new Date().toISOString(),
				currentEventId: finalEventId,
				events: events.rows.map((row) => ({
					id: row.event_id,
					finished: true,
					isCurrent: row.event_id === finalEventId,
					isNext: false,
				})),
				teams: teams.rows.map((row) => ({ id: row.team_id, shortName: row.short_name })),
				players: [
					{
						id: subject.element_id,
						code: subject.code,
						type: subject.element_type,
						teamId: subject.team_id,
					},
				],
				fixtures: fixtures.rows.map((row) => ({
					id: row.fixture_id,
					eventId: row.event_id,
					teamHId: row.team_h_id,
					teamAId: row.team_a_id,
					teamHDifficulty: row.team_h_difficulty,
					teamADifficulty: row.team_a_difficulty,
					kickoffTime:
						row.kickoff_time instanceof Date ? row.kickoff_time.toISOString() : row.kickoff_time,
				})),
			} as unknown as CoreDataSnapshot;
			repository = createPlayerStateRepository({
				executor: pool,
				loadCoreSnapshot: async () => coreSnapshot,
			});
		}, 30_000);

		afterAll(async () => {
			await pool.end();
		});

		const context = (redis: Redis | TestRedis): GraphQLContext =>
			({
				currentSeason: { seasonId: season.season_id, seasonCode: season.season_code },
				dataRevision: "b0-2526",
				redis,
				logger: testLogger,
				database: pool,
				data: {},
			}) as unknown as GraphQLContext;

		const profileCacheKey = (contextValue: GraphQLContext, playerId: number, horizon: number) =>
			gqlCacheKey(
				contextValue,
				`player-state-profile:v3:${playerStateDatasetRevision}:${playerId}:${horizon}`
			);

		it("returns a cross-provider profile from canonical relations", async () => {
			const profile = await repository.getPlayerStateProfile(
				context(new TestRedis()),
				subject.element_id,
				5
			);
			const understatCurrent = profile?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "CURRENT"
			);
			const understatHistory = profile?.coverage.sources.find(
				(source) => source.provider === "UNDERSTAT" && source.scope === "HISTORY"
			);
			expect(understatCurrent?.mappingStatus).toBe("VERIFIED");
			expect(understatCurrent?.dataStatus).toBe("AVAILABLE");
			expect(profile?.providerMode).toBe("FPL_WITH_UNDERSTAT_CURRENT");
			expect(understatHistory?.seasons).not.toContain("2526");
		}, 30_000);

		it.skipIf(!hasRedisEnvironment)(
			"returns an honest current-season FPL-only profile from the real core publication",
			async () => {
				const currentSeason = (
					await pool.query<SeasonRow>(
						`SELECT season_id, season_code
						 FROM fpl.seasons
						 WHERE is_current IS TRUE`
					)
				).rows[0]!;
				const currentSubject = (
					await pool.query<SubjectRow>(
						`SELECT player.element_id, player.code, player.element_type, player.team_id
						 FROM fpl.players player
						 JOIN bridge.entity_links link
						   ON link.entity_type = 'player'
						  AND link.left_provider = 'understat'
						  AND link.right_provider = 'fpl'
						  AND link.right_entity_id = player.code::text
						  AND link.status IN ('auto_verified', 'manual_verified')
						  AND NOT (link.evidence -> 'confirmedSeasons' ? $2)
						  AND link.left_entity_id ~ '^[0-9]+$'
						 WHERE player.season_id = $1
						   AND player.element_type <> 1
						   AND EXISTS (
						     SELECT 1
						     FROM understat.player_seasons metrics
						     WHERE metrics.player_id = link.left_entity_id::integer
						       AND link.evidence -> 'confirmedSeasons' ? metrics.season_code
						   )
						 ORDER BY player.element_id
						 LIMIT 1`,
						[currentSeason.season_id, currentSeason.season_code]
					)
				).rows[0]!;
				const redis = new Redis({ host: redisHost, port: redisPort, maxRetriesPerRequest: 1 });
				const currentContext = {
					currentSeason: {
						seasonId: currentSeason.season_id,
						seasonCode: currentSeason.season_code,
					},
					dataRevision: "bootstrap",
					redis,
					logger: testLogger,
					database: pool,
					data: new ReadModelClient(pool, {
						seasonId: currentSeason.season_id,
						seasonCode: currentSeason.season_code,
					}),
				} as unknown as GraphQLContext;
				let cacheKey: string | null = null;
				try {
					const currentCore = await getCoreDataSnapshot(currentContext);
					expect(currentCore.source).toBe("redis");
					expect(
						currentCore.players.some((player) => player.id === currentSubject.element_id)
					).toBe(true);
					currentContext.dataRevision = coreDatasetRevision(currentCore);
					cacheKey = profileCacheKey(currentContext, currentSubject.element_id, 5);
					await redis.del(cacheKey);
					const currentRepository = createPlayerStateRepository({ executor: pool });
					const profile = await currentRepository.getPlayerStateProfile(
						currentContext,
						currentSubject.element_id,
						5
					);
					expect(profile?.season).toBe(currentSeason.season_code);
					const understatCurrent = profile?.coverage.sources.find(
						(source) => source.provider === "UNDERSTAT" && source.scope === "CURRENT"
					);
					const understatHistory = profile?.coverage.sources.find(
						(source) => source.provider === "UNDERSTAT" && source.scope === "HISTORY"
					);
					expect(understatCurrent?.mappingStatus).toBe("UNVERIFIED");
					expect(understatCurrent?.dataStatus).toBe("UNAVAILABLE");
					expect(understatHistory?.seasons).toEqual([]);
					expect(profile?.providerMode).toBe("FPL_ONLY");
				} finally {
					if (cacheKey !== null) await redis.del(cacheKey);
					await redis.quit();
				}
			},
			30_000
		);

		it.skipIf(!hasRedisEnvironment)(
			"persists bounded success and valid-null TTLs in Redis",
			async () => {
				const redis = new Redis({ host: redisHost, port: redisPort, maxRetriesPerRequest: 1 });
				const redisContext = context(redis);
				const successKey = profileCacheKey(redisContext, subject.element_id, 5);
				const nullKey = profileCacheKey(redisContext, 999999, 5);
				try {
					await redis.del(successKey, nullKey);
					await repository.getPlayerStateProfile(redisContext, subject.element_id, 5);
					await repository.getPlayerStateProfile(redisContext, 999999, 5);
					const [successTtl, nullTtl] = await Promise.all([
						redis.ttl(successKey),
						redis.ttl(nullKey),
					]);
					expect(successTtl).toBeGreaterThanOrEqual(899);
					expect(successTtl).toBeLessThanOrEqual(900);
					expect(nullTtl).toBeGreaterThanOrEqual(59);
					expect(nullTtl).toBeLessThanOrEqual(60);
				} finally {
					await redis.del(successKey, nullKey);
					await redis.quit();
				}
			},
			30_000
		);

		it("meets the restored-B0 cold and warm p95 budgets", async () => {
			for (let iteration = 0; iteration < 5; iteration += 1) {
				await repository.getPlayerStateProfile(context(new TestRedis()), subject.element_id, 5);
			}
			const coldSamples: number[] = [];
			for (let iteration = 0; iteration < 30; iteration += 1) {
				const startedAt = performance.now();
				await repository.getPlayerStateProfile(context(new TestRedis()), subject.element_id, 5);
				coldSamples.push(performance.now() - startedAt);
			}

			const warmRedis = new TestRedis();
			await repository.getPlayerStateProfile(context(warmRedis), subject.element_id, 5);
			const warmSamples: number[] = [];
			for (let iteration = 0; iteration < 30; iteration += 1) {
				const startedAt = performance.now();
				await repository.getPlayerStateProfile(context(warmRedis), subject.element_id, 5);
				warmSamples.push(performance.now() - startedAt);
			}

			const coldP95 = percentile95(coldSamples);
			const warmP95 = percentile95(warmSamples);
			process.stdout.write(
				`player-state-b0-benchmark cold_p95_ms=${coldP95.toFixed(3)} warm_p95_ms=${warmP95.toFixed(3)} samples=30\n`
			);
			expect(coldP95).toBeLessThanOrEqual(500);
			expect(warmP95).toBeLessThanOrEqual(50);
		}, 60_000);
	}
);
