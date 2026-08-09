#!/usr/bin/env bun
/**
 * Temporary benchmark script for all GraphQL queries.
 *
 * Runs every Query resolver repeatedly against the existing Redis cache state.
 * This script is read-only from Redis' perspective: cache-delete and cache-write
 * commands are blocked so benchmark runs do not mutate verified live keys.
 *
 * Reports are grouped by domain and printed to stdout + saved as JSON.
 */

import { ApolloServer } from "@apollo/server";
import type Redis from "ioredis";
import type { QueryResultRow } from "pg";
import type { GraphQLContext } from "../src/graphql/context";
import { schema } from "../src/graphql/schema";
import { validateDatabaseContract } from "../src/infra/database-contract";
import { database } from "../src/infra/database";
import { env } from "../src/infra/env";
import { logger } from "../src/infra/logger";
import { connectRedis, getRedis } from "../src/infra/redis";
import { V3ReadClient } from "../src/infra/v3-read-client";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type BenchmarkResult = {
	domain: string;
	query: string;
	variables: Record<string, unknown>;
	iterations: number;
	timeoutMs: number;
	samplesMs: number[];
	medianMs: number | null;
	p95Ms: number | null;
	minMs: number | null;
	maxMs: number | null;
	status: "OK" | "ERROR" | "TIMEOUT" | "PARTIAL";
	resultCount: number | null;
	error: string | null;
};

type QueryDefinition = {
	domain: string;
	name: string;
	operation: string;
	variables: Record<string, unknown>;
	resultExtractor: (data: Record<string, unknown> | null) => number | null;
};

type TimedOperationResult =
	| { status: "OK"; ms: number; resultCount: number | null; error: null }
	| { status: "ERROR" | "TIMEOUT"; ms: null; resultCount: null; error: string };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const readBoundedInt = (
	value: string | undefined,
	fallback: number,
	min: number,
	max: number
): number => {
	const parsed = Number(value ?? fallback);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(Math.trunc(parsed), max));
};

const BENCHMARK_ITERATIONS = readBoundedInt(Bun.env.BENCHMARK_ITERATIONS, 5, 1, 20);
const QUERY_TIMEOUT_MS = readBoundedInt(Bun.env.BENCHMARK_TIMEOUT_MS, 30_000, 1000, 300_000);

const nowIso = (): string => new Date().toISOString();

const countValue = (val: unknown): number => {
	if (val === null || val === undefined) return 0;
	if (Array.isArray(val)) return val.length;

	if (
		val &&
		typeof val === "object" &&
		"items" in val &&
		Array.isArray((val as Record<string, unknown>).items)
	) {
		return ((val as Record<string, unknown>).items as unknown[]).length;
	}

	if (
		val &&
		typeof val === "object" &&
		"results" in val &&
		Array.isArray((val as Record<string, unknown>).results)
	) {
		return ((val as Record<string, unknown>).results as unknown[]).length;
	}

	if (val && typeof val === "object") {
		const directArrays = Object.values(val as Record<string, unknown>).filter(Array.isArray);
		if (directArrays.length > 0) {
			return directArrays.reduce((sum, arr) => sum + arr.length, 0);
		}
	}

	return 1;
};

const extractResultCount = (data: Record<string, unknown> | null, field: string): number | null => {
	if (!data) return null;
	return countValue(data[field]);
};

const percentile = (values: number[], pct: number): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.ceil((pct / 100) * sorted.length) - 1;
	return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
};

const formatMs = (value: number | null): string => (value !== null ? value.toFixed(1) : "N/A");

const WRITE_COMMANDS = new Set([
	"del",
	"unlink",
	"set",
	"setex",
	"psetex",
	"mset",
	"hset",
	"hmset",
	"hdel",
	"expire",
	"pexpire",
	"expireat",
	"pexpireat",
	"persist",
	"incr",
	"incrby",
	"decr",
	"decrby",
	"sadd",
	"srem",
	"zadd",
	"lpush",
	"rpush",
	"flushdb",
	"flushall",
]);

const isWriteCommand = (command: string): boolean => WRITE_COMMANDS.has(command.toLowerCase());

const simulatedWriteResult = (command: string): Promise<unknown> => {
	const normalized = command.toLowerCase();
	if (["set", "setex", "psetex", "mset", "hmset"].includes(normalized)) {
		return Promise.resolve("OK");
	}
	return Promise.resolve(0);
};

const createReadOnlyPipeline = (
	pipeline: ReturnType<Redis["pipeline"]>
): ReturnType<Redis["pipeline"]> =>
	new Proxy(pipeline, {
		get(target, prop, receiver): unknown {
			if (typeof prop === "string" && isWriteCommand(prop)) {
				return () => receiver as ReturnType<Redis["pipeline"]>;
			}
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const callable = value as (...args: unknown[]) => unknown;
			return (...args: unknown[]): unknown => callable.apply(target, args);
		},
	});

const createReadOnlyRedis = (redis: Redis): Redis =>
	new Proxy(redis, {
		get(target, prop, receiver): unknown {
			if (prop === "pipeline") {
				return (...args: Parameters<Redis["pipeline"]>) =>
					createReadOnlyPipeline(target.pipeline(...args));
			}
			if (typeof prop === "string" && isWriteCommand(prop)) {
				return (..._args: unknown[]) => simulatedWriteResult(prop);
			}
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const callable = value as (...args: unknown[]) => unknown;
			return (...args: unknown[]): unknown => callable.apply(target, args);
		},
	}) as Redis;

class QueryTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Query timed out after ${timeoutMs}ms`);
		this.name = "QueryTimeoutError";
	}
}

async function runTimedOperation(
	apollo: ApolloServer<GraphQLContext>,
	context: GraphQLContext,
	query: QueryDefinition
): Promise<TimedOperationResult> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const start = performance.now();
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(
				() => reject(new QueryTimeoutError(QUERY_TIMEOUT_MS)),
				QUERY_TIMEOUT_MS
			);
		});
		const response = await Promise.race([
			apollo.executeOperation(
				{ query: query.operation, variables: query.variables },
				{ contextValue: context }
			),
			timeout,
		]);
		const ms = performance.now() - start;

		if (response.body.kind !== "single") {
			return {
				status: "ERROR",
				ms: null,
				resultCount: null,
				error: "Unexpected multipart GraphQL response",
			};
		}

		const body = response.body.singleResult;
		if (body.errors && body.errors.length > 0) {
			return {
				status: "ERROR",
				ms: null,
				resultCount: null,
				error: body.errors.map((e) => e.message).join("; "),
			};
		}

		return {
			status: "OK",
			ms,
			resultCount: query.resultExtractor(body.data as Record<string, unknown> | null),
			error: null,
		};
	} catch (e) {
		const isTimeout = e instanceof QueryTimeoutError;
		return {
			status: isTimeout ? "TIMEOUT" : "ERROR",
			ms: null,
			resultCount: null,
			error: e instanceof Error ? e.message : String(e),
		};
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

/* ------------------------------------------------------------------ */
/* ID Discovery (real data from DB)                                    */
/* ------------------------------------------------------------------ */

type DiscoveryRow = QueryResultRow & {
	event_id: number | null;
	player_id: number | null;
	entry_id: number | null;
	team_id: number | null;
	league_id: number | null;
	tournament_id: number | null;
	fixture_event_id: number | null;
	next_fixture_event_id: number | null;
	entry_event_id: number | null;
	entry_event_entry_id: number | null;
	player_stat_event_id: number | null;
};

async function discoverIds(seasonId: number): Promise<{
	eventId: number | null;
	playerId: number | null;
	entryId: number | null;
	teamId: number | null;
	leagueId: number | null;
	tournamentId: number | null;
	fixtureEventId: number | null;
	nextFixtureEventId: number | null;
	entryEventId: number | null;
	entryEventEntryId: number | null;
	playerStatEventId: number | null;
}> {
	const row = (
		await database.query<DiscoveryRow>(
			`WITH chosen_event AS (
				SELECT COALESCE(
					MAX(event_id) FILTER (WHERE is_current),
					MIN(event_id)
				) AS event_id
				FROM fpl.events
				WHERE season_id = $1
			), entry_event AS (
				SELECT entry_id, event_id
				FROM competition.entry_event_results
				WHERE season_id = $1
				ORDER BY event_id DESC, entry_id
				LIMIT 1
			)
			SELECT
				(SELECT event_id FROM chosen_event) AS event_id,
				(SELECT MIN(element_id) FROM fpl.players WHERE season_id = $1) AS player_id,
				(SELECT MIN(entry_id) FROM competition.entries WHERE season_id = $1) AS entry_id,
				(SELECT MIN(team_id) FROM fpl.teams WHERE season_id = $1) AS team_id,
				(SELECT MIN(league_id) FROM competition.entry_leagues WHERE season_id = $1) AS league_id,
				(SELECT MIN(tournament_id) FROM competition.tournaments WHERE season_id = $1) AS tournament_id,
				(SELECT MIN(event_id) FROM fpl.fixtures WHERE season_id = $1) AS fixture_event_id,
				(
					SELECT MIN(event_id)
					FROM fpl.fixtures
					WHERE season_id = $1
					  AND event_id > (SELECT event_id FROM chosen_event)
				) AS next_fixture_event_id,
				(SELECT event_id FROM entry_event) AS entry_event_id,
				(SELECT entry_id FROM entry_event) AS entry_event_entry_id,
				(SELECT MAX(event_id) FROM fpl.player_event_snapshots WHERE season_id = $1)
					AS player_stat_event_id`,
			[seasonId]
		)
	).rows[0];
	if (!row) throw new Error("Unable to discover benchmark identifiers");
	const numberOrNull = (value: number | null): number | null =>
		value === null ? null : Number(value);
	const result = {
		eventId: numberOrNull(row.event_id),
		playerId: numberOrNull(row.player_id),
		entryId: numberOrNull(row.entry_id),
		teamId: numberOrNull(row.team_id),
		leagueId: numberOrNull(row.league_id),
		tournamentId: numberOrNull(row.tournament_id),
		fixtureEventId: numberOrNull(row.fixture_event_id),
		nextFixtureEventId: numberOrNull(row.next_fixture_event_id),
		entryEventId: numberOrNull(row.entry_event_id),
		entryEventEntryId: numberOrNull(row.entry_event_entry_id),
		playerStatEventId: numberOrNull(row.player_stat_event_id),
	};

	logger.info(result, "Discovered sample IDs");
	return result;
}

/* ------------------------------------------------------------------ */
/* Build query definitions                                             */
/* ------------------------------------------------------------------ */

function buildQueries(ids: Awaited<ReturnType<typeof discoverIds>>): QueryDefinition[] {
	const today = new Date();
	const todayStr = today.toISOString().split("T")[0];

	const q: QueryDefinition[] = [];

	// Helper to push queries
	const add = (
		domain: string,
		name: string,
		operation: string,
		variables: Record<string, unknown>,
		resultField: string,
		_cacheKeyPatterns: string[]
	): void => {
		q.push({
			domain,
			name,
			operation,
			variables,
			resultExtractor: (data) => extractResultCount(data, resultField),
		});
	};

	/* events */
	if (ids.eventId) {
		add(
			"events",
			"event",
			"query Event($id: Int!) { event(id: $id) { id name } }",
			{ id: ids.eventId },
			"event",
			["event:current"]
		);
	}
	add("events", "events", "query Events { events(limit: 10) { id name } }", {}, "events", [
		"event:current",
	]);
	add(
		"events",
		"currentEventInfo",
		"query CurrentEventInfo { currentEventInfo { currentEvent nextUtcDeadline } }",
		{},
		"currentEventInfo",
		["event:current"]
	);

	/* players */
	if (ids.playerId) {
		add(
			"players",
			"player",
			"query Player($id: Int!) { player(id: $id) { id webName } }",
			{ id: ids.playerId },
			"player",
			["players:*"]
		);
	}
	add("players", "players", "query Players { players(limit: 10) { id webName } }", {}, "players", [
		"players:*",
	]);
	add(
		"players",
		"playersForPicker",
		"query PlayersForPicker { playersForPicker(limit: 10) { items { id webName } nextCursor } }",
		{},
		"playersForPicker",
		["players:picker:*"]
	);
	if (ids.teamId) {
		add(
			"players",
			"team",
			"query Team($id: Int!) { team(id: $id) { id name } }",
			{ id: ids.teamId },
			"team",
			[]
		);
	}
	add("players", "teams", "query Teams { teams { id name } }", {}, "teams", []);
	if (ids.playerStatEventId) {
		add(
			"players",
			"topTransfersIn",
			"query TopTransfersIn($eventId: Int!) { topTransfersIn(eventId: $eventId, limit: 5) { transfersInEvent transfersOutEvent player { id webName } } }",
			{ eventId: ids.playerStatEventId },
			"topTransfersIn",
			["players:transfer-stats:raw:*", "players:top-transfers-in:*"]
		);
		add(
			"players",
			"topTransfersOut",
			"query TopTransfersOut($eventId: Int!) { topTransfersOut(eventId: $eventId, limit: 5) { transfersInEvent transfersOutEvent player { id webName } } }",
			{ eventId: ids.playerStatEventId },
			"topTransfersOut",
			["players:transfer-stats:raw:*", "players:top-transfers-out:*"]
		);
	}

	/* playerValues */
	add(
		"playerValues",
		"playerValues",
		`query PlayerValues($changeDate: Date!) { playerValues(changeDate: $changeDate) { playerId playerName } }`,
		{ changeDate: todayStr },
		"playerValues",
		["player-value-history:*"]
	);
	if (ids.playerId) {
		add(
			"playerValues",
			"playerValueHistory",
			"query PlayerValueHistory($playerId: Int!) { playerValueHistory(playerId: $playerId) { playerId changeDate } }",
			{ playerId: ids.playerId },
			"playerValueHistory",
			["player-value-history:*"]
		);
	}

	/* playerDetail */
	if (ids.playerId && ids.eventId) {
		add(
			"playerDetail",
			"playerDetail",
			"query PlayerDetail($playerId: Int!, $eventId: Int!) { playerDetail(playerId: $playerId, eventId: $eventId) { id webName } }",
			{ playerId: ids.playerId, eventId: ids.eventId },
			"playerDetail",
			["player_detail:*", "FixturesByTeam:*"]
		);
	}

	/* fixtures */
	add(
		"fixtures",
		"fixtures",
		"query Fixtures { fixtures(limit: 10) { id code } }",
		{},
		"fixtures",
		["fixtures:*"]
	);
	if (ids.fixtureEventId) {
		add(
			"fixtures",
			"eventFixtures",
			"query EventFixtures($eventId: Int!) { eventFixtures(eventId: $eventId) { id code } }",
			{ eventId: ids.fixtureEventId },
			"eventFixtures",
			[]
		);
	}

	/* live */
	if (ids.eventId) {
		add(
			"live",
			"liveScores",
			"query LiveScores($eventId: Int!) { liveScores(eventId: $eventId) { totalPoints minutes } }",
			{ eventId: ids.eventId },
			"liveScores",
			["PlayerStatsSelected:*"]
		);
		if (ids.playerId) {
			add(
				"live",
				"playerLive",
				"query PlayerLive($playerId: Int!, $eventId: Int!) { playerLive(playerId: $playerId, eventId: $eventId) { totalPoints minutes } }",
				{ playerId: ids.playerId, eventId: ids.eventId },
				"playerLive",
				[]
			);
		}
		add(
			"live",
			"eventLive",
			"query EventLive($eventId: Int!) { eventLive(eventId: $eventId) { event { id } performances { totalPoints minutes } } }",
			{ eventId: ids.eventId },
			"eventLive",
			[]
		);
		if (ids.playerId) {
			add(
				"live",
				"eventLiveExplain",
				"query EventLiveExplain($eventId: Int!, $elementId: Int!) { eventLiveExplain(eventId: $eventId, elementId: $elementId) { elementId stats { totalPoints } } }",
				{ eventId: ids.eventId, elementId: ids.playerId },
				"eventLiveExplain",
				["live:explain:*", "PlayerStatsSelected:*"]
			);
		}
	}

	/* liveMatches */
	add(
		"liveMatches",
		"liveMatches",
		"query LiveMatches { liveMatches { playing { matchId } finished { matchId } } }",
		{},
		"liveMatches",
		["LiveFixture:*", "live-matches:*"]
	);
	if (ids.nextFixtureEventId) {
		add(
			"liveMatches",
			"nextEventFixtures",
			"query NextEventFixtures($eventId: Int!) { eventFixtures(eventId: $eventId) { id code } }",
			{ eventId: ids.nextFixtureEventId },
			"eventFixtures",
			[]
		);
	}

	/* entries */
	if (ids.entryId) {
		add(
			"entries",
			"entry",
			"query Entry($id: Int!) { entry(id: $id) { id entryName } }",
			{ id: ids.entryId },
			"entry",
			["entries:*"]
		);
		add(
			"entries",
			"entryHistory",
			"query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { results { eventId } history { season } } }",
			{ entryId: ids.entryId },
			"entryHistory",
			["entries:history:*", "entries:history-info:*"]
		);
	}
	if (ids.entryEventEntryId && ids.entryEventId) {
		add(
			"entries",
			"entryEventResult",
			"query EntryEventResult($entryId: Int!, $eventId: Int!) { entryEventResult(entryId: $entryId, eventId: $eventId) { eventPoints eventRank } }",
			{ entryId: ids.entryEventEntryId, eventId: ids.entryEventId },
			"entryEventResult",
			["entries:event-result:*"]
		);
		add(
			"entries",
			"entryTransferHistory",
			"query EntryTransferHistory($entryId: Int!) { entryTransferHistory(entryId: $entryId) { eventId transfers { elementIn elementOut } } }",
			{ entryId: ids.entryEventEntryId },
			"entryTransferHistory",
			["entries:transfers:history:*", "entries:transfer-history:enriched:*"]
		);
		if (ids.entryEventEntryId) {
			add(
				"entries",
				"entryTransferHistory_live",
				"query EntryTransferHistoryLive($entryId: Int!, $live: Boolean!) { entryTransferHistory(entryId: $entryId, live: $live) { eventId transfers { elementIn elementOut elementInPoints elementOutPoints elementInPlayed elementOutPlayed } } }",
				{ entryId: ids.entryEventEntryId, live: true },
				"entryTransferHistory",
				["entries:transfers:history:*", "entries:transfer-history:enriched:*"]
			);
		}
	}

	/* entryLive */
	if (ids.entryEventEntryId && ids.entryEventId) {
		add(
			"entryLive",
			"entryLive",
			"query EntryLive($entryId: Int!, $eventId: Int!) { entryLive(entryId: $entryId, eventId: $eventId) { eventPoints overallPoints } }",
			{ entryId: ids.entryEventEntryId, eventId: ids.entryEventId },
			"entryLive",
			["entry-live:*", "entries:picks:*", "entries:transfers:*"]
		);
		add(
			"entryLive",
			"calcLivePointsByEntry",
			"query CalcLivePointsByEntry($eventId: Int!, $entryId: Int!) { calcLivePointsByEntry(eventId: $eventId, entryId: $entryId) { rank livePoints pickList { element webName } } }",
			{ eventId: ids.entryEventId, entryId: ids.entryEventEntryId },
			"calcLivePointsByEntry",
			["entry-live:*", "entries:picks:*", "entries:transfers:*"]
		);
		add(
			"entryLive",
			"calcLivePointsForEntries_single",
			"query CalcLivePointsForEntries($eventId: Int!, $entryIds: [Int!]!) { calcLivePointsForEntries(eventId: $eventId, entryIds: $entryIds) { results { rank livePoints } meta { totalEntries succeededCount } } }",
			{ eventId: ids.entryEventId, entryIds: [ids.entryEventEntryId] },
			"calcLivePointsForEntries",
			["entry-live:*", "entries:picks:*", "entries:transfers:*"]
		);
		if (ids.entryId && ids.entryId !== ids.entryEventEntryId) {
			add(
				"entryLive",
				"calcLivePointsForEntries_batch",
				"query CalcLivePointsForEntriesBatch($eventId: Int!, $entryIds: [Int!]!) { calcLivePointsForEntries(eventId: $eventId, entryIds: $entryIds) { results { rank livePoints } meta { totalEntries succeededCount } } }",
				{
					eventId: ids.entryEventId,
					entryIds: [ids.entryEventEntryId, ids.entryId],
				},
				"calcLivePointsForEntries",
				["entry-live:*", "entries:picks:*", "entries:transfers:*"]
			);
		}
	}
	if (ids.tournamentId && ids.entryEventId) {
		add(
			"entryLive",
			"calcLivePointsForTournament",
			"query CalcLivePointsForTournament($eventId: Int!, $tournamentId: Int!) { calcLivePointsForTournament(eventId: $eventId, tournamentId: $tournamentId) { results { rank livePoints } meta { totalEntries succeededCount } } }",
			{ eventId: ids.entryEventId, tournamentId: ids.tournamentId },
			"calcLivePointsForTournament",
			["entry-live:*", "entries:picks:*", "entries:transfers:*", "tournaments:entry-ids:*"]
		);
	}

	/* leagues */
	if (ids.entryId) {
		add(
			"leagues",
			"entryLeagues",
			"query EntryLeagues($entryId: Int!) { entryLeagues(entryId: $entryId) { id name } }",
			{ entryId: ids.entryId },
			"entryLeagues",
			["leagues:entry:v2:*", "League:*"]
		);
	}
	if (ids.leagueId && ids.eventId) {
		add(
			"leagues",
			"leagueEventResults",
			"query LeagueEventResults($leagueId: Int!, $eventId: Int!) { leagueEventResults(leagueId: $leagueId, eventId: $eventId) { eventPoints overallPoints } }",
			{ leagueId: ids.leagueId, eventId: ids.eventId },
			"leagueEventResults",
			["leagues:results:v2:*"]
		);
	}

	/* tournaments */
	if (ids.entryId) {
		add(
			"tournaments",
			"entryTournaments",
			"query EntryTournaments($entryId: Int!) { entryTournaments(entryId: $entryId) { id name } }",
			{ entryId: ids.entryId },
			"entryTournaments",
			["tournaments:entry:*", "tournament:info:*"]
		);
	}
	if (ids.tournamentId) {
		add(
			"tournaments",
			"tournamentEntryIds",
			"query TournamentEntryIds($tournamentId: Int!) { tournamentEntryIds(tournamentId: $tournamentId) }",
			{ tournamentId: ids.tournamentId },
			"tournamentEntryIds",
			["tournaments:entry-ids:*"]
		);
	}
	if (ids.tournamentId && ids.eventId) {
		add(
			"tournaments",
			"tournamentEventResults",
			"query TournamentEventResults($tournamentId: Int!, $eventId: Int!) { tournamentEventResults(tournamentId: $tournamentId, eventId: $eventId) { eventPoints overallPoints } }",
			{ tournamentId: ids.tournamentId, eventId: ids.eventId },
			"tournamentEventResults",
			["tournaments:event-results:*"]
		);
	}
	if (ids.tournamentId && ids.eventId && ids.entryId) {
		add(
			"tournaments",
			"tournamentEntryRankingSummary",
			"query TournamentEntryRankingSummary($tournamentId: Int!, $eventId: Int!, $entryId: Int!) { tournamentEntryRankingSummary(tournamentId: $tournamentId, eventId: $eventId, entryId: $entryId) { overallRank tournamentOverallRank } }",
			{
				tournamentId: ids.tournamentId,
				eventId: ids.eventId,
				entryId: ids.entryId,
			},
			"tournamentEntryRankingSummary",
			["tournaments:ranking-summary:*"]
		);
	}

	/* eventOverallResult */
	add(
		"eventOverallResult",
		"eventOverallResult",
		"query EventOverallResult { eventOverallResult { event averageScore highestScore } }",
		{},
		"eventOverallResult",
		[]
	);

	/* eventStats */
	if (ids.tournamentId && ids.eventId) {
		add(
			"eventStats",
			"tournamentSelectionStats",
			"query TournamentSelectionStats($tournamentId: Int!, $eventId: Int!) { tournamentSelectionStats(tournamentId: $tournamentId, eventId: $eventId, limit: 5) { totalEntries goalkeepers { id } defenders { id } } }",
			{ tournamentId: ids.tournamentId, eventId: ids.eventId },
			"tournamentSelectionStats",
			["tournament-selection-stats:*", "tournaments:entry-ids:*"]
		);
	}

	/* miniProgram */
	add(
		"miniProgram",
		"miniProgramNotice",
		"query MiniProgramNotice { miniProgramNotice }",
		{},
		"miniProgramNotice",
		["mini-program:*", "notice:*"]
	);

	return q;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

async function runBenchmark(): Promise<void> {
	logger.info("Starting benchmark...");

	// Bootstrap
	const contract = await validateDatabaseContract(database);
	await connectRedis();
	const redis = createReadOnlyRedis(getRedis());
	const context: GraphQLContext = {
		data: new V3ReadClient(database, contract.currentSeason),
		database,
		currentSeason: contract.currentSeason,
		redis,
		logger,
	};

	const apollo = new ApolloServer<GraphQLContext>({ schema });
	await apollo.start();

	const ids = await discoverIds(contract.currentSeason.seasonId);
	const queries = buildQueries(ids);

	const results: BenchmarkResult[] = [];

	// Warm-up: run all queries once to prime any lazy connections
	logger.info("Priming connections with a warm-up query...");
	try {
		await apollo.executeOperation(
			{ query: "query Warmup { currentEventInfo { currentEvent } }" },
			{ contextValue: context }
		);
	} catch {
		// ignore
	}

	for (const q of queries) {
		logger.info({ domain: q.domain, query: q.name }, "Benchmarking query");

		const result: BenchmarkResult = {
			domain: q.domain,
			query: q.name,
			variables: q.variables,
			iterations: BENCHMARK_ITERATIONS,
			timeoutMs: QUERY_TIMEOUT_MS,
			samplesMs: [],
			medianMs: null,
			p95Ms: null,
			minMs: null,
			maxMs: null,
			status: "OK",
			resultCount: null,
			error: null,
		};

		const failures: TimedOperationResult[] = [];
		for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
			const sample = await runTimedOperation(apollo, context, q);
			if (sample.status === "OK") {
				result.samplesMs.push(sample.ms);
				result.resultCount = sample.resultCount;
			} else {
				failures.push(sample);
			}
		}

		result.medianMs = percentile(result.samplesMs, 50);
		result.p95Ms = percentile(result.samplesMs, 95);
		result.minMs = result.samplesMs.length > 0 ? Math.min(...result.samplesMs) : null;
		result.maxMs = result.samplesMs.length > 0 ? Math.max(...result.samplesMs) : null;

		if (failures.length > 0) {
			result.status = result.samplesMs.length > 0 ? "PARTIAL" : failures[0].status;
			result.error = failures
				.slice(0, 3)
				.map((failure) => failure.error)
				.join("; ");
		}

		results.push(result);
	}

	await apollo.stop();

	/* ---------------------------------------------------------------- */
	/* Reporting                                                         */
	/* ---------------------------------------------------------------- */

	// Group by domain
	const grouped = new Map<string, BenchmarkResult[]>();
	for (const r of results) {
		const list = grouped.get(r.domain) ?? [];
		list.push(r);
		grouped.set(r.domain, list);
	}

	// Console output
	console.log(`\n${"=".repeat(100)}`);
	console.log("GRAPHQL QUERY BENCHMARK RESULTS");
	console.log(`Timestamp: ${nowIso()}`);
	console.log(`Redis:     ${env.REDIS_HOST}:${env.REDIS_PORT}`);
	console.log(`Postgres:  read-only Data Platform ${contract.schemaVersion}`);
	console.log(`Mode:      read-only Redis, ${BENCHMARK_ITERATIONS} samples/query`);
	console.log(`Timeout:   ${QUERY_TIMEOUT_MS} ms/query sample`);
	console.log("=".repeat(100));

	const domains = Array.from(grouped.keys()).sort();
	for (const domain of domains) {
		const rows = grouped.get(domain) ?? [];
		console.log(`\n📦 Domain: ${domain}`);
		console.log("─".repeat(100));
		console.log(
			`  ${"Query".padEnd(40)} ${"Median".padStart(10)} ${"P95".padStart(10)} ${"Min".padStart(10)} ${"Max".padStart(10)} ${"Status".padStart(8)} ${"Count".padStart(8)}`
		);
		console.log("─".repeat(100));
		for (const r of rows) {
			const count = r.resultCount !== null ? String(r.resultCount) : "N/A";
			const queryName = r.query.length > 38 ? `${r.query.slice(0, 35)}...` : r.query;
			console.log(
				`  ${queryName.padEnd(40)} ${formatMs(r.medianMs).padStart(10)} ${formatMs(r.p95Ms).padStart(10)} ${formatMs(r.minMs).padStart(10)} ${formatMs(r.maxMs).padStart(10)} ${r.status.padStart(8)} ${count.padStart(8)}`
			);
			if (r.error) {
				console.log(`    error: ${r.error}`);
			}
		}
	}

	// Summary
	const okQueries = results.filter((r) => r.status === "OK").length;
	const partialQueries = results.filter((r) => r.status === "PARTIAL").length;
	const failedQueries = results.length - okQueries - partialQueries;
	const totalSamples = results.reduce((sum, r) => sum + r.samplesMs.length, 0);
	const totalMedianMs = results.reduce((sum, r) => sum + (r.medianMs ?? 0), 0);
	const totalP95Ms = results.reduce((sum, r) => sum + (r.p95Ms ?? 0), 0);

	console.log(`\n${"=".repeat(100)}`);
	console.log("SUMMARY");
	console.log("=".repeat(100));
	console.log(`Total queries:      ${results.length}`);
	console.log(`Iterations/query:   ${BENCHMARK_ITERATIONS}`);
	console.log(`Collected samples:  ${totalSamples}`);
	console.log(`OK queries:         ${okQueries} / ${results.length}`);
	console.log(`Partial queries:    ${partialQueries} / ${results.length}`);
	console.log(`Failed queries:     ${failedQueries} / ${results.length}`);
	console.log(`Avg median time:    ${(totalMedianMs / results.length).toFixed(1)} ms`);
	console.log(`Avg p95 time:       ${(totalP95Ms / results.length).toFixed(1)} ms`);
	console.log("=".repeat(100));

	// Write JSON report
	const reportFile = `benchmark-results-${Date.now()}.json`;
	const report = {
		meta: {
			timestamp: nowIso(),
			redisHost: env.REDIS_HOST,
			redisPort: env.REDIS_PORT,
			databaseMode: "read-only-v3",
			datasetRevision: contract.datasetRevision,
			totalQueries: results.length,
			iterations: BENCHMARK_ITERATIONS,
			timeoutMs: QUERY_TIMEOUT_MS,
			redisMode: "read-only",
		},
		summary: {
			okQueries,
			partialQueries,
			failedQueries,
			totalSamples,
			avgMedianMs: totalMedianMs / results.length,
			avgP95Ms: totalP95Ms / results.length,
		},
		results,
	};

	await Bun.write(reportFile, JSON.stringify(report, null, 2));
	console.log(`\n📄 JSON report saved to: ${reportFile}\n`);
}

runBenchmark().catch((err) => {
	logger.error({ err }, "Benchmark failed");
	process.exit(1);
});
