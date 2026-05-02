#!/usr/bin/env bun
/**
 * Temporary benchmark script for all GraphQL queries.
 *
 * Runs every Query resolver twice:
 *   1. WARM  – uses existing Redis cache state
 *   2. COLD  – clears domain-specific Redis keys first, then runs
 *
 * Reports are grouped by domain and printed to stdout + saved as JSON.
 */

import { ApolloServer } from "@apollo/server";
import type Redis from "ioredis";
import type { GraphQLContext } from "../src/graphql/context";
import { schema } from "../src/graphql/schema";
import { env } from "../src/infra/env";
import { logger } from "../src/infra/logger";
import { connectRedis, getRedis } from "../src/infra/redis";
import { supabase } from "../src/infra/supabase";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type BenchmarkResult = {
	domain: string;
	query: string;
	variables: Record<string, unknown>;
	warmMs: number | null;
	coldMs: number | null;
	warmStatus: "OK" | "ERROR" | "TIMEOUT";
	coldStatus: "OK" | "ERROR" | "TIMEOUT" | "SKIPPED";
	warmResultCount: number | null;
	coldResultCount: number | null;
	warmError: string | null;
	coldError: string | null;
};

type QueryDefinition = {
	domain: string;
	name: string;
	operation: string;
	variables: Record<string, unknown>;
	resultExtractor: (data: Record<string, unknown> | null) => number | null;
	keyPatterns: string[]; // Redis key patterns to delete before cold run
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const nowIso = (): string => new Date().toISOString();

const _extractListCount = (
	data: Record<string, unknown> | null,
	field: string,
): number | null => {
	if (!data) return null;
	const val = data[field];
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
	return val === null ? 0 : 1;
};

const countTopLevel = (
	data: Record<string, unknown> | null,
	field: string,
): number | null => {
	if (!data) return null;
	const val = data[field];
	if (Array.isArray(val)) return val.length;
	return val === null ? 0 : 1;
};

/* ------------------------------------------------------------------ */
/* ID Discovery (real data from DB)                                    */
/* ------------------------------------------------------------------ */

async function discoverIds(): Promise<{
	eventId: number | null;
	playerId: number | null;
	entryId: number | null;
	teamId: number | null;
	leagueId: number | null;
	tournamentId: number | null;
	fixtureEventId: number | null;
	entryEventId: number | null;
	entryEventEntryId: number | null;
	playerStatEventId: number | null;
}> {
	const result = {
		eventId: null as number | null,
		playerId: null as number | null,
		entryId: null as number | null,
		teamId: null as number | null,
		leagueId: null as number | null,
		tournamentId: null as number | null,
		fixtureEventId: null as number | null,
		entryEventId: null as number | null,
		entryEventEntryId: null as number | null,
		playerStatEventId: null as number | null,
	};

	// Current event
	try {
		const { data } = await supabase
			.from("events")
			.select("id")
			.eq("is_current", true)
			.limit(1);
		if (data && data.length > 0)
			result.eventId = (data[0] as { id: number }).id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover current event");
	}

	// Fallback: any event
	if (!result.eventId) {
		try {
			const { data } = await supabase.from("events").select("id").limit(1);
			if (data && data.length > 0)
				result.eventId = (data[0] as { id: number }).id;
		} catch (e) {
			logger.warn({ err: e }, "Failed to discover any event");
		}
	}

	// Player
	try {
		const { data } = await supabase.from("players").select("id").limit(1);
		if (data && data.length > 0)
			result.playerId = (data[0] as { id: number }).id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover player");
	}

	// Entry
	try {
		const { data } = await supabase.from("entry_infos").select("id").limit(1);
		if (data && data.length > 0)
			result.entryId = (data[0] as { id: number }).id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover entry");
	}

	// Team
	try {
		const { data } = await supabase.from("teams").select("id").limit(1);
		if (data && data.length > 0) result.teamId = (data[0] as { id: number }).id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover team");
	}

	// League
	try {
		const { data } = await supabase
			.from("entry_league_infos")
			.select("league_id")
			.limit(1);
		if (data && data.length > 0)
			result.leagueId = (data[0] as { league_id: number }).league_id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover league");
	}

	// Tournament
	try {
		const { data } = await supabase
			.from("tournament_infos")
			.select("id")
			.limit(1);
		if (data && data.length > 0)
			result.tournamentId = (data[0] as { id: number }).id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover tournament");
	}

	// Fixture event
	try {
		const { data } = await supabase
			.from("event_fixtures")
			.select("event_id")
			.limit(1);
		if (data && data.length > 0)
			result.fixtureEventId = (data[0] as { event_id: number }).event_id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover fixture event");
	}

	// Entry-event pair
	try {
		const { data } = await supabase
			.from("entry_event_results")
			.select("entry_id,event_id")
			.limit(1);
		if (data && data.length > 0) {
			const row = data[0] as { entry_id: number; event_id: number };
			result.entryEventEntryId = row.entry_id;
			result.entryEventId = row.event_id;
		}
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover entry-event pair");
	}

	// Player stat event
	try {
		const { data } = await supabase
			.from("player_stats")
			.select("event_id")
			.limit(1);
		if (data && data.length > 0)
			result.playerStatEventId = (data[0] as { event_id: number }).event_id;
	} catch (e) {
		logger.warn({ err: e }, "Failed to discover player stat event");
	}

	logger.info(result, "Discovered sample IDs");
	return result;
}

/* ------------------------------------------------------------------ */
/* Redis key clearing                                                  */
/* ------------------------------------------------------------------ */

async function clearRedisKeys(
	redis: Redis,
	patterns: string[],
): Promise<number> {
	let total = 0;
	for (const pattern of patterns) {
		try {
			const keys = await redis.keys(pattern);
			if (keys.length > 0) {
				await redis.del(...keys);
				total += keys.length;
			}
		} catch (e) {
			logger.warn({ err: e, pattern }, "Failed to clear Redis keys");
		}
	}
	return total;
}

/* ------------------------------------------------------------------ */
/* Build query definitions                                             */
/* ------------------------------------------------------------------ */

function buildQueries(
	ids: Awaited<ReturnType<typeof discoverIds>>,
): QueryDefinition[] {
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
		keyPatterns: string[],
	) => {
		q.push({
			domain,
			name,
			operation,
			variables,
			resultExtractor: (data) => countTopLevel(data, resultField),
			keyPatterns,
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
			["event:current", "season:current"],
		);
	}
	add(
		"events",
		"events",
		"query Events { events(limit: 10) { id name } }",
		{},
		"events",
		["event:current", "season:current"],
	);
	add(
		"events",
		"currentEventInfo",
		"query CurrentEventInfo { currentEventInfo { currentEvent nextUtcDeadline } }",
		{},
		"currentEventInfo",
		["event:current", "season:current"],
	);

	/* players */
	if (ids.playerId) {
		add(
			"players",
			"player",
			"query Player($id: Int!) { player(id: $id) { id webName } }",
			{ id: ids.playerId },
			"player",
			["players:*"],
		);
	}
	add(
		"players",
		"players",
		"query Players { players(limit: 10) { id webName } }",
		{},
		"players",
		["players:*"],
	);
	add(
		"players",
		"playersForPicker",
		"query PlayersForPicker { playersForPicker(limit: 10) { items { id webName } nextCursor } }",
		{},
		"playersForPicker",
		["players:picker:*"],
	);
	if (ids.teamId) {
		add(
			"players",
			"team",
			"query Team($id: Int!) { team(id: $id) { id name } }",
			{ id: ids.teamId },
			"team",
			[],
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
			["players:transfer-stats:raw:*", "players:top-transfers-in:*"],
		);
		add(
			"players",
			"topTransfersOut",
			"query TopTransfersOut($eventId: Int!) { topTransfersOut(eventId: $eventId, limit: 5) { transfersInEvent transfersOutEvent player { id webName } } }",
			{ eventId: ids.playerStatEventId },
			"topTransfersOut",
			["players:transfer-stats:raw:*", "players:top-transfers-out:*"],
		);
	}

	/* playerValues */
	add(
		"playerValues",
		"playerValues",
		`query PlayerValues($changeDate: Date!) { playerValues(changeDate: $changeDate) { playerId playerName } }`,
		{ changeDate: todayStr },
		"playerValues",
		["player-value-history:*"],
	);
	if (ids.playerId) {
		add(
			"playerValues",
			"playerValueHistory",
			"query PlayerValueHistory($playerId: Int!) { playerValueHistory(playerId: $playerId) { playerId changeDate } }",
			{ playerId: ids.playerId },
			"playerValueHistory",
			["player-value-history:*"],
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
			["player_detail:*", "FixturesByTeam:*"],
		);
	}

	/* fixtures */
	add(
		"fixtures",
		"fixtures",
		"query Fixtures { fixtures(limit: 10) { id code } }",
		{},
		"fixtures",
		["fixtures:*"],
	);
	if (ids.fixtureEventId) {
		add(
			"fixtures",
			"eventFixtures",
			"query EventFixtures($eventId: Int!) { eventFixtures(eventId: $eventId) { id code } }",
			{ eventId: ids.fixtureEventId },
			"eventFixtures",
			[],
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
			["PlayerStatsSelected:*"],
		);
		if (ids.playerId) {
			add(
				"live",
				"playerLive",
				"query PlayerLive($playerId: Int!, $eventId: Int!) { playerLive(playerId: $playerId, eventId: $eventId) { totalPoints minutes } }",
				{ playerId: ids.playerId, eventId: ids.eventId },
				"playerLive",
				[],
			);
		}
		add(
			"live",
			"eventLive",
			"query EventLive($eventId: Int!) { eventLive(eventId: $eventId) { event { id } performances { totalPoints minutes } } }",
			{ eventId: ids.eventId },
			"eventLive",
			[],
		);
		if (ids.playerId) {
			add(
				"live",
				"eventLiveExplain",
				"query EventLiveExplain($eventId: Int!, $elementId: Int!) { eventLiveExplain(eventId: $eventId, elementId: $elementId) { elementId stats { totalPoints } } }",
				{ eventId: ids.eventId, elementId: ids.playerId },
				"eventLiveExplain",
				["live:explain:*", "PlayerStatsSelected:*"],
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
		["LiveFixture:*", "live-matches:*"],
	);
	add(
		"liveMatches",
		"liveMatchesUpcoming",
		"query LiveMatchesUpcoming { liveMatches(upcoming: true) { nextEvent { matchId } notStarted { matchId } } }",
		{},
		"liveMatches",
		["LiveFixture:*", "live-matches:*"],
	);

	/* entries */
	if (ids.entryId) {
		add(
			"entries",
			"entry",
			"query Entry($id: Int!) { entry(id: $id) { id entryName } }",
			{ id: ids.entryId },
			"entry",
			["entries:*"],
		);
		add(
			"entries",
			"entryHistory",
			"query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { results { eventId } history { season } } }",
			{ entryId: ids.entryId },
			"entryHistory",
			["entries:history:*", "entries:history-info:*"],
		);
	}
	if (ids.entryEventEntryId && ids.entryEventId) {
		add(
			"entries",
			"entryEventResult",
			"query EntryEventResult($entryId: Int!, $eventId: Int!) { entryEventResult(entryId: $entryId, eventId: $eventId) { eventPoints eventRank } }",
			{ entryId: ids.entryEventEntryId, eventId: ids.entryEventId },
			"entryEventResult",
			["entries:event-result:*"],
		);
		add(
			"entries",
			"entryTransferHistory",
			"query EntryTransferHistory($entryId: Int!) { entryTransferHistory(entryId: $entryId) { eventId transfers { elementIn elementOut } } }",
			{ entryId: ids.entryEventEntryId },
			"entryTransferHistory",
			["entries:transfers:history:*", "entries:transfer-history:enriched:*"],
		);
	}

	/* entryLive */
	if (ids.entryEventEntryId && ids.entryEventId) {
		add(
			"entryLive",
			"entryLive",
			"query EntryLive($entryId: Int!, $eventId: Int!) { entryLive(entryId: $entryId, eventId: $eventId) { eventPoints overallPoints } }",
			{ entryId: ids.entryEventEntryId, eventId: ids.entryEventId },
			"entryLive",
			["entry-live:*", "entries:picks:*", "entries:transfers:*"],
		);
		add(
			"entryLive",
			"calcLivePointsByEntry",
			"query CalcLivePointsByEntry($eventId: Int!, $entryId: Int!) { calcLivePointsByEntry(eventId: $eventId, entryId: $entryId) { rank livePoints pickList { element webName } } }",
			{ eventId: ids.entryEventId, entryId: ids.entryEventEntryId },
			"calcLivePointsByEntry",
			["entry-live:*", "entries:picks:*", "entries:transfers:*"],
		);
		add(
			"entryLive",
			"calcLivePointsForEntries_single",
			"query CalcLivePointsForEntries($eventId: Int!, $entryIds: [Int!]!) { calcLivePointsForEntries(eventId: $eventId, entryIds: $entryIds) { results { rank livePoints } meta { totalEntries succeededCount } } }",
			{ eventId: ids.entryEventId, entryIds: [ids.entryEventEntryId] },
			"calcLivePointsForEntries",
			["entry-live:*", "entries:picks:*", "entries:transfers:*"],
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
				["entry-live:*", "entries:picks:*", "entries:transfers:*"],
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
			[
				"entry-live:*",
				"entries:picks:*",
				"entries:transfers:*",
				"tournaments:entry-ids:*",
			],
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
			["leagues:entry:v2:*", "League:*"],
		);
	}
	if (ids.leagueId && ids.eventId) {
		add(
			"leagues",
			"leagueEventResults",
			"query LeagueEventResults($leagueId: Int!, $eventId: Int!) { leagueEventResults(leagueId: $leagueId, eventId: $eventId) { eventPoints overallPoints } }",
			{ leagueId: ids.leagueId, eventId: ids.eventId },
			"leagueEventResults",
			["leagues:results:v2:*"],
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
			["tournaments:entry:*", "tournament:info:*"],
		);
	}
	if (ids.tournamentId) {
		add(
			"tournaments",
			"tournamentEntryIds",
			"query TournamentEntryIds($tournamentId: Int!) { tournamentEntryIds(tournamentId: $tournamentId) }",
			{ tournamentId: ids.tournamentId },
			"tournamentEntryIds",
			["tournaments:entry-ids:*"],
		);
	}
	if (ids.tournamentId && ids.eventId) {
		add(
			"tournaments",
			"tournamentEventResults",
			"query TournamentEventResults($tournamentId: Int!, $eventId: Int!) { tournamentEventResults(tournamentId: $tournamentId, eventId: $eventId) { eventPoints overallPoints } }",
			{ tournamentId: ids.tournamentId, eventId: ids.eventId },
			"tournamentEventResults",
			["tournaments:event-results:*"],
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
			["tournaments:ranking-summary:*"],
		);
	}

	/* eventOverallResult */
	add(
		"eventOverallResult",
		"eventOverallResult",
		"query EventOverallResult { eventOverallResult { event averageScore highestScore } }",
		{},
		"eventOverallResult",
		[],
	);

	/* eventStats */
	if (ids.tournamentId && ids.eventId) {
		add(
			"eventStats",
			"tournamentSelectionStats",
			"query TournamentSelectionStats($tournamentId: Int!, $eventId: Int!) { tournamentSelectionStats(tournamentId: $tournamentId, eventId: $eventId, limit: 5) { totalEntries goalkeepers { id } defenders { id } } }",
			{ tournamentId: ids.tournamentId, eventId: ids.eventId },
			"tournamentSelectionStats",
			["tournament-selection-stats:*", "tournaments:entry-ids:*"],
		);
	}

	/* miniProgram */
	add(
		"miniProgram",
		"miniProgramNotice",
		"query MiniProgramNotice { miniProgramNotice }",
		{},
		"miniProgramNotice",
		["mini-program:*", "notice:*"],
	);

	return q;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

async function runBenchmark(): Promise<void> {
	logger.info("Starting benchmark...");

	// Bootstrap
	await connectRedis();
	const redis = getRedis();

	const apollo = new ApolloServer<GraphQLContext>({ schema });
	await apollo.start();

	const ids = await discoverIds();
	const queries = buildQueries(ids);

	const results: BenchmarkResult[] = [];

	// Warm-up: run all queries once to prime any lazy connections
	logger.info("Priming connections with a warm-up query...");
	try {
		await apollo.executeOperation(
			{ query: "query Warmup { currentEventInfo { currentEvent } }" },
			{ contextValue: { supabase, redis, logger } },
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
			warmMs: null,
			coldMs: null,
			warmStatus: "OK",
			coldStatus: "OK",
			warmResultCount: null,
			coldResultCount: null,
			warmError: null,
			coldError: null,
		};

		/* ---- WARM ---- */
		try {
			const warmStart = performance.now();
			const warmResponse = await apollo.executeOperation(
				{ query: q.operation, variables: q.variables },
				{ contextValue: { supabase, redis, logger } },
			);
			result.warmMs = performance.now() - warmStart;

			if (warmResponse.body.kind === "single") {
				const body = warmResponse.body.singleResult;
				if (body.errors && body.errors.length > 0) {
					result.warmStatus = "ERROR";
					result.warmError = body.errors.map((e) => e.message).join("; ");
				} else {
					result.warmResultCount = q.resultExtractor(
						body.data as Record<string, unknown> | null,
					);
				}
			}
		} catch (e) {
			result.warmStatus = "ERROR";
			result.warmError = e instanceof Error ? e.message : String(e);
		}

		/* ---- COLD ---- */
		// Clear relevant Redis keys
		const cleared = await clearRedisKeys(redis, q.keyPatterns);
		logger.debug({ query: q.name, cleared }, "Cleared Redis keys for cold run");

		try {
			const coldStart = performance.now();
			const coldResponse = await apollo.executeOperation(
				{ query: q.operation, variables: q.variables },
				{ contextValue: { supabase, redis, logger } },
			);
			result.coldMs = performance.now() - coldStart;

			if (coldResponse.body.kind === "single") {
				const body = coldResponse.body.singleResult;
				if (body.errors && body.errors.length > 0) {
					result.coldStatus = "ERROR";
					result.coldError = body.errors.map((e) => e.message).join("; ");
				} else {
					result.coldResultCount = q.resultExtractor(
						body.data as Record<string, unknown> | null,
					);
				}
			}
		} catch (e) {
			result.coldStatus = "ERROR";
			result.coldError = e instanceof Error ? e.message : String(e);
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
	console.log(`Supabase:  ${env.SUPABASE_URL}`);
	console.log("=".repeat(100));

	const domains = Array.from(grouped.keys()).sort();
	for (const domain of domains) {
		const rows = grouped.get(domain) ?? [];
		console.log(`\n📦 Domain: ${domain}`);
		console.log("─".repeat(100));
		console.log(
			`  ${"Query".padEnd(40)} ${"Warm(ms)".padStart(10)} ${"Cold(ms)".padStart(10)} ${"Δ(ms)".padStart(10)} ${"Warm".padStart(8)} ${"Cold".padStart(8)} ${"Count".padStart(8)}`,
		);
		console.log("─".repeat(100));
		for (const r of rows) {
			const delta =
				r.warmMs !== null && r.coldMs !== null
					? (r.coldMs - r.warmMs).toFixed(1)
					: "N/A";
			const warmMs = r.warmMs !== null ? r.warmMs.toFixed(1) : "N/A";
			const coldMs = r.coldMs !== null ? r.coldMs.toFixed(1) : "N/A";
			const count =
				r.warmResultCount !== null ? String(r.warmResultCount) : "N/A";
			const queryName =
				r.query.length > 38 ? `${r.query.slice(0, 35)}...` : r.query;
			console.log(
				`  ${queryName.padEnd(40)} ${warmMs.padStart(10)} ${coldMs.padStart(10)} ${String(delta).padStart(10)} ${r.warmStatus.padStart(8)} ${r.coldStatus.padStart(8)} ${count.padStart(8)}`,
			);
			if (r.warmError) {
				console.log(`    ⚠️  warm error: ${r.warmError}`);
			}
			if (r.coldError) {
				console.log(`    ⚠️  cold error: ${r.coldError}`);
			}
		}
	}

	// Summary
	const okWarm = results.filter((r) => r.warmStatus === "OK").length;
	const okCold = results.filter((r) => r.coldStatus === "OK").length;
	const totalWarmMs = results.reduce((sum, r) => sum + (r.warmMs ?? 0), 0);
	const totalColdMs = results.reduce((sum, r) => sum + (r.coldMs ?? 0), 0);

	console.log(`\n${"=".repeat(100)}`);
	console.log("SUMMARY");
	console.log("=".repeat(100));
	console.log(`Total queries:      ${results.length}`);
	console.log(`Warm OK:            ${okWarm} / ${results.length}`);
	console.log(`Cold OK:            ${okCold} / ${results.length}`);
	console.log(`Total warm time:    ${totalWarmMs.toFixed(1)} ms`);
	console.log(`Total cold time:    ${totalColdMs.toFixed(1)} ms`);
	console.log(
		`Average warm time:  ${(totalWarmMs / results.length).toFixed(1)} ms`,
	);
	console.log(
		`Average cold time:  ${(totalColdMs / results.length).toFixed(1)} ms`,
	);
	console.log("=".repeat(100));

	// Write JSON report
	const reportFile = `benchmark-results-${Date.now()}.json`;
	const report = {
		meta: {
			timestamp: nowIso(),
			redisHost: env.REDIS_HOST,
			redisPort: env.REDIS_PORT,
			supabaseUrl: env.SUPABASE_URL,
			totalQueries: results.length,
		},
		summary: {
			okWarm,
			okCold,
			totalWarmMs,
			totalColdMs,
			avgWarmMs: totalWarmMs / results.length,
			avgColdMs: totalColdMs / results.length,
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
