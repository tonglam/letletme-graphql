import { describe, expect, test } from "bun:test";
import {
	DIRECT_DATA_SQL_CONTRACT,
	allowedResultTypes,
	validateDirectDataSqlContract,
	validateTournamentSelectionIndexContractRows,
} from "../../scripts/lib/validate-direct-data-sql-contract";
import type { QueryResult, QueryResultRow } from "pg";
import type { QueryExecutor } from "../../src/infra/database";
import { SEARCH_ENTRIES_SQL } from "../../src/domains/entries/repository";
import {
	GAMEWEEK_HISTORICAL_TEAM_AS_OF_SQL,
	GAMEWEEK_HISTORICAL_TEAM_EXACT_SQL,
} from "../../src/domains/gameweek/service";
import {
	HOME_MARKET_AVAILABILITY_SQL,
	HOME_MARKET_OWNERSHIP_SQL,
	HOME_MARKET_PRICE_CHANGES_SQL,
} from "../../src/domains/home/market-repository";
import { HOME_PERSONAL_DESK_SQL } from "../../src/domains/home/repository";
import { MARKET_QUERY } from "../../src/domains/market/repository";
import { PLAYER_DETAIL_HISTORICAL_TEAMS_SQL } from "../../src/domains/player-detail/repository";
import {
	CORE_FALLBACK_SQL,
	CORE_LIVE_IDENTITY_FALLBACK_SQL,
	CORE_PHASE_SHAPE_SQL,
} from "../../src/infra/data-snapshot";
import { createHash } from "node:crypto";
import {
	PUBLICATION_BY_ID_SQL,
	PUBLICATION_CANDIDATES_SQL,
	PUBLICATION_CONTEXT_ITEMS_SQL,
	PUBLICATION_ITEM_METADATA_SQL,
	PUBLICATION_ITEMS_SQL,
	PRICE_CHANGE_PUBLICATION_CONTRACT_SQL,
} from "../../src/infra/price-change-predictions-client";
import { TRENDS_CONTRACT_PUBLICATION_ID_SQL } from "../../src/domains/trends/repository";

const mockContractResultType = (relation: string, column: string, jsonType: string): string => {
	const assertion = DIRECT_DATA_SQL_CONTRACT.flatMap((probe) => probe.resultTypes ?? []).find(
		(candidate) => candidate.relation === relation && candidate.column === column
	);
	return assertion?.pgType === "jsonb" ? jsonType : (assertion?.pgType ?? jsonType);
};

const mockSnapshotEntryPayload = {
	contractVersion: 2,
	entry: {
		id: 1,
		entryName: "Contract Entry",
		playerName: "Contract Player",
		region: null,
		startedEvent: null,
		overallPoints: 0,
		overallRank: 1,
		bank: 0,
		teamValue: 1000,
		totalTransfers: 0,
		transfersSyncedThroughEventId: null,
	},
	pastSeasons: [],
	gameweek: { state: "EMPTY", eventId: 1, result: null },
	review: {
		throughEventId: 1,
		timeline: [],
		summary: {
			gameweeksReviewed: 0,
			provisionalGameweeks: 0,
			totalNetPoints: 0,
			averageNetPoints: 0,
			medianNetPoints: 0,
			bestGameweekId: null,
			bestNetPoints: null,
			worstGameweekId: null,
			worstNetPoints: null,
			totalHitPoints: 0,
			hitGameweeks: 0,
			totalBenchPoints: 0,
			averageBenchPoints: 0,
			zeroBenchGameweeks: 0,
			highBenchGameweeks: 0,
			totalAutoSubPoints: 0,
			autoSubGameweeks: 0,
			totalCaptainPoints: 0,
			uniqueCaptains: 0,
			captainBlankGameweeks: 0,
			topCaptainWebName: null,
			topCaptainGameweeks: 0,
			topCaptainRate: 0,
			bestOverallRank: null,
			worstOverallRank: null,
			overallRankChange: null,
			currentImprovementStreak: 0,
			longestImprovementStreak: 0,
			formations: [],
			positionPoints: {
				goalkeeper: 0,
				defender: 0,
				midfielder: 0,
				forward: 0,
				assistantManager: 0,
				total: 0,
			},
			chips: [],
		},
		holdings: [],
		transfers: [],
	},
} as const;

const mockEntrySearchRow = {
	id: 1,
	entry_name: "Contract Entry",
	player_name: "Contract Player",
	region: null,
	started_event: 1,
	overall_points: 42,
	overall_rank: 1,
	bank: 0,
	team_value: 1000,
	total_transfers: 0,
	last_event_id: 1,
	last_overall_points: 42,
	last_overall_rank: 1,
	last_team_value: 1000,
	last_bank: 0,
} as const;

const CONTRACT_PUBLICATION_ID = "00000000-0000-4000-8000-000000000001";
const CONTRACT_CORE_PUBLICATION_ID = "00000000-0000-4000-8000-000000000007";

const canonicalValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalValue(record[key])])
		);
	}
	return value;
};

const canonicalJson = (value: unknown): string => {
	const serialized = JSON.stringify(canonicalValue(value));
	if (serialized === undefined) throw new Error("Mock payload is not JSON serializable");
	return serialized;
};

const mockBriefingPayload = (locale: "en" | "zh-CN") => ({
	schemaVersion: 1,
	scopeKind: "SURFACE",
	scopeKey: "week",
	revision: 1,
	publicationId: CONTRACT_PUBLICATION_ID,
	state: "EMPTY",
	locale,
	publishedAt: "2026-08-10T00:00:00.000Z",
	sourceCheckedAt: "2026-08-10T00:00:00.000Z",
	validUntil: null,
	event: null,
	featured: [],
	sections: [],
});

const mockBriefingFallbackRow = (locale: "en" | "zh-CN" = "en") => {
	const payload = mockBriefingPayload(locale);
	const canonical = canonicalJson(payload);
	return {
		payload,
		payload_bytes: Buffer.byteLength(canonical, "utf8"),
		payload_sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
	};
};

const mockCompetitionAggregatePayload = {
	eventId: 1,
	entryCount: 1,
	leaderOverallPoints: null,
	secondOverallPoints: null,
	gapFirstSecond: null,
	averageOverallPoints: null,
	metrics: [
		"OVERALL_POINTS",
		"TEAM_VALUE",
		"TRANSFERS",
		"TOTAL_COSTS",
		"BENCH_POINTS",
		"AUTO_SUB_POINTS",
	].map((key) => ({
		key,
		leaderValue: null,
		leaderEntryId: null,
		leaderEntryName: null,
		leaderPlayerName: null,
		averageValue: null,
		higherIsBetter: true,
	})),
	viewers: {
		"1": {
			entryId: 1,
			overallRank: null,
			tournamentOverallRank: null,
			teamValue: null,
			tournamentTeamValueRank: null,
			transfersNum: 0,
			tournamentTransfersRank: null,
			totalCosts: 0,
			tournamentCostsRank: null,
			totalBenchPoints: 0,
			tournamentBenchPointsRank: null,
			autoSubPoints: 0,
			tournamentAutoSubRank: null,
			overallPoints: null,
			leaderOverallPoints: null,
			gapToLeader: null,
			pointsBehindNext: null,
			pointsAheadOfPrev: null,
		},
	},
	topPerformers: [],
	risers: [],
	fallers: [],
	captainDistribution: [],
	chipDistribution: [],
} as const;

const mockPriceChangePublication = {
	publication_id: CONTRACT_PUBLICATION_ID,
	revision: "1",
	manifest: {
		dataset: "fpl:price-changes",
		seasonCode: "2627",
		eventId: null,
		revision: 1,
		publicationId: CONTRACT_PUBLICATION_ID,
		sourceCheckedAt: "2026-08-10T00:00:00.000Z",
		publishedAt: "2026-08-10T00:00:00.000Z",
		state: "active",
		items: ["context", "players"].map((name) => ({
			name,
			key: `llm:data:fpl:price-changes:2627:1:${name}`,
			type: "string",
			count: name === "context" ? 10 : 1,
			bytes: name === "context" ? 313 : 402,
			sha256:
				name === "context"
					? "27f14e433ab759b4e348f43c61a4d0770653bbb041f99da28face3c5dd797ee2"
					: "a7c6d5db29d03c28c312029d420f6a8554f458d25be6d0db602966bd32ad1cc6",
		})),
	},
	item_rows: [
		{
			name: "context",
			itemCount: 10,
			checksum: "27f14e433ab759b4e348f43c61a4d0770653bbb041f99da28face3c5dd797ee2",
			payload: {
				schemaVersion: 2,
				source: "FPL_BOOTSTRAP",
				fetchedAt: "2026-08-10T00:00:00.000Z",
				staleAt: "2026-08-10T00:10:00.000Z",
				hardExpiresAt: "2026-08-10T01:00:00.000Z",
				deadline: "2026-08-10T00:30:00.000Z",
				nextDeadlines: ["2026-08-10T00:30:00.000Z"],
				expectedPlayerCount: 1,
				observedPlayerCount: 1,
				latestEvent: null,
			},
		},
		{
			name: "players",
			itemCount: 1,
			checksum: "a7c6d5db29d03c28c312029d420f6a8554f458d25be6d0db602966bd32ad1cc6",
			payload: [
				{
					playerId: 1,
					playerCode: 1,
					webName: "Contract Player",
					teamId: 1,
					teamName: "Contract Team",
					teamShortName: "GCT",
					position: "GKP",
					currentPrice: 50,
					selectedByPercent: 1,
					progressPercent: 0,
					hourlyRate: 0,
					status: "UNLIKELY",
					ownershipTrend: "FLAT",
					transfersInEvent: 0,
					transfersOutEvent: 0,
					lockedUntil: null,
					calibrating: false,
					projections: [{ offset: 0, projectedPercent: 0, likelihood: 0 }],
				},
			],
		},
	],
} as const;

const mockBriefingMetadata = {
	publication_id: CONTRACT_PUBLICATION_ID,
	scope_key: "week",
	revision: 1,
	schema_version: 1,
	season_code: "2627",
	target_event_id: null,
	event_name: null,
	deadline_time: null,
	state: "EMPTY",
	servable: true,
	source_checked_at: "2026-08-10T00:00:00.000Z",
	published_at: "2026-08-10T00:00:00.000Z",
	valid_until: null,
	locale_manifest: {
		en: {
			bytes: mockBriefingFallbackRow("en").payload_bytes,
			sha256: mockBriefingFallbackRow("en").payload_sha256,
		},
		"zh-CN": {
			bytes: mockBriefingFallbackRow("zh-CN").payload_bytes,
			sha256: mockBriefingFallbackRow("zh-CN").payload_sha256,
		},
	},
};

const mockCompetitionBoardRow = {
	eventId: 1,
	entryId: 1,
	__snapshotEntryId: 1,
	groupId: 1,
	rank: 1,
} as const;

const mockCompetitionBoardProbe = {
	field_size: 1,
	total_rows: 1,
	expected_field_size: 1,
	invalid_row_count: 0,
	rows: [mockCompetitionBoardRow],
	viewer_row: mockCompetitionBoardRow,
} as const;

const mockSeasonPathPayload = {
	seasonPaths: {
		"1": [
			{
				gameweek: 1,
				fieldSize: 1,
				tournamentRank: 1,
				gapToLeader: 0,
				pointsVsAverage: 0,
				overallPoints: 0,
				leaderOverallPoints: 0,
				averageOverallPoints: 0,
			},
		],
	},
} as const;

const mockMarketRow = {
	snapshot_date: "2025-08-28",
	captured_at: "2025-08-28T00:00:00.000Z",
	element_id: 1,
	player_code: 26001,
	web_name: "GC1",
	team_id: 1,
	team_name: "GraphQL Contract Team",
	team_short_name: "GCT",
	element_type: 1,
	position: "GKP",
	price: 50,
	selected_by_percent: 1,
	transfers_in: 0,
	transfers_out: 0,
	status: "a",
	news: "",
	news_added: null,
	chance_of_playing_this_round: 100,
	chance_of_playing_next_round: 100,
	baseline_date: "2025-08-28",
	first_observed_date: "2025-08-28",
	previous_price: null,
	previous_transfers_in: null,
	previous_transfers_out: null,
	previous_status: null,
	previous_news: null,
	previous_chance_this_round: null,
	previous_chance_next_round: null,
} as const;

const mockMarketAuthority = {
	snapshot_date: "2025-08-28",
	captured_at: "2025-08-28T00:00:00.000Z",
	row_count: 1,
	capture_count: 1,
} as const;

const mockPlayerStateRevision = {
	revision: "1",
	method_version: "1",
	source_updated_at: "2026-08-10T00:00:00.000Z",
	refreshed_at: "2026-08-10T00:00:00.000Z",
} as const;

const mockPlayerStateCurrentPeer = {
	element_id: 1,
	total_points: 42,
	minutes: 90,
	bonus: 0,
	starts: 1,
	goals_scored: 0,
	assists: 0,
	clean_sheets: 1,
	saves: 0,
	bps: 10,
	return_count: 1,
	gameweeks_available: 1,
} as const;

const mockPlayerStateGameweek = {
	element_id: 1,
	event_id: 1,
	total_points: 42,
	minutes: 90,
	started: true,
	bonus: 0,
} as const;

const mockHistoricalTeam = {
	player_code: 26001,
	team_id: 1,
} as const;

const mockSetupStatus = {
	setup_status: "ready",
	setup_phase: "ready",
	setup_progress_updated_at: "2026-08-10T00:00:00.000Z",
	standings_ready_at: "2026-08-10T00:00:00.000Z",
	insights_ready_at: "2026-08-10T00:00:00.000Z",
} as const;

const mockSnapshotPublication = {
	season_id: 2026,
	event_id: 1,
	revision: "7",
	snapshot_date: "2026-08-10",
	source_checked_at: "2026-08-10T00:00:00.000Z",
	published_at: "2026-08-10T00:00:01.000Z",
	kind: "FINAL",
	expected_entry_count: 0,
	ready_entry_count: 0,
	empty_entry_count: 0,
	not_applicable_entry_count: 0,
	expected_tournament_count: 2,
	ready_tournament_count: 2,
	content_sha256: "a".repeat(64),
	entry_scope_sha256: "b".repeat(64),
	tournament_scope_sha256: "c".repeat(64),
	score_source: "FPL_FINAL_RESULT",
	live_publication_id: null,
	live_revision: null,
	algorithm_version: null,
	source_min_checked_at: "2026-08-10T00:00:00.000Z",
	source_max_checked_at: "2026-08-10T00:00:00.000Z",
	lifecycle_finished: true,
	lifecycle_data_checked: true,
	finalization_started_at: "2026-08-10T00:00:00.000Z",
	finalization_due_at: "2026-08-10T01:15:00.000Z",
	status_expected_entry_count: 0,
	observed_entry_count: 0,
	pending_correction_entry_count: 0,
	status_expected_tournament_count: 2,
	observed_tournament_count: 2,
	coverage_state: "COMPLETE",
	expected_entry_scope_sha256: "b".repeat(64),
	observed_entry_scope_sha256: "b".repeat(64),
	expected_tournament_scope_sha256: "c".repeat(64),
	observed_tournament_scope_sha256: "c".repeat(64),
} as const;

const mockPlayerPickerRow = {
	id: 1,
	web_name: "GC1",
	element_type: 1,
	team_id: 1,
	team_name: "GraphQL Contract Team",
	team_short_name: "GCT",
	price: 50,
	selected_by_percent: 1,
	total_points: 42,
	form: 4.2,
	total_count: 1,
	event_stats_revision: "1",
	event_stats_present: true,
	market_snapshot_present: true,
} as const;

const mockPlayerStateSeasonRow = {
	season_id: 2026,
	season_code: "2627",
	lifecycle_state: "active",
	player_code: 26001,
	element_id: 1,
	element_type: 1,
	fpl_minutes: 90,
	fpl_gameweeks: 1,
	fpl_total_points: 42,
	fpl_starts: 1,
	fpl_clean_sheets: 1,
	fpl_saves: 0,
	fpl_points_per_90: 42,
	fpl_return_rate: 100,
	fpl_bonus_per_90: 0,
	fpl_position_percentile: 75,
	fpl_peer_count: 1,
	expected_metrics_available: true,
	fpl_source_hash: "graphql-contract-player-state-2627",
	fpl_source_updated_at: "2026-08-10T00:00:00.000Z",
	understat_mapping_status: "UNAVAILABLE",
	understat_player_id: null,
	understat_season_state: null,
	understat_minutes: null,
	understat_npxg_per_90: null,
	understat_xa_per_90: null,
	understat_shots_per_90: null,
	understat_key_passes_per_90: null,
	understat_xg_chain_per_90: null,
	understat_xg_buildup_per_90: null,
	understat_npxg_percentile: null,
	understat_xa_percentile: null,
	understat_shots_percentile: null,
	understat_key_passes_percentile: null,
	understat_xg_chain_percentile: null,
	understat_xg_buildup_percentile: null,
	understat_process_percentile: null,
	understat_peer_count: 0,
	understat_source_hash: null,
	understat_source_updated_at: null,
	refreshed_at: "2026-08-10T00:00:00.000Z",
} as const;

const mockTrendsPersonalRows = Array.from({ length: 15 }, (_, index) => ({
	capability: "PERSONAL_EXPOSURE",
	element_id: index + 1,
	player_name: `Contract Player ${index + 1}`,
	player_position: (index % 4) + 1,
	team_short_name: "GCT",
	pick_position: index + 1,
	count: index === 0 ? 2 : 1,
}));

const mockTrendsAggregateRows = [
	"OWNERSHIP",
	"EFFECTIVE_OWNERSHIP",
	"TEMPLATE",
	"CAPTAINCY",
	"VICE_CAPTAINCY",
	"TRANSFERS",
].map((capability) => ({
	capability,
	element_id: 1,
	player_name: "Contract Player 1",
	player_position: 1,
	team_short_name: "GCT",
	count: 1,
	pick_position: null,
}));

const mockTrendsRows = [...mockTrendsPersonalRows, ...mockTrendsAggregateRows];

const mockCoreFallbackRow = (() => {
	const events = Array.from({ length: 38 }, (_, index) => ({
		event_id: index + 1,
		name: `Gameweek ${index + 1}`,
		deadline_time: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T11:00:00.000Z`,
		finished: true,
		data_checked: true,
		data_checked_at: "2026-08-10T00:00:00.000Z",
		is_previous: index === 0,
		is_current: index === 1,
		is_next: index === 2,
		cup_league_create: false,
		h2h_ko_matches_created: false,
		average_entry_score: null,
		highest_scoring_entry: null,
		deadline_time_epoch: null,
		deadline_time_game_offset: null,
		highest_score: null,
		chip_plays: [],
		most_selected: null,
		most_transferred_in: null,
		top_element: null,
		top_element_info: null,
		transfers_made: null,
		most_captained: null,
		most_vice_captained: null,
	}));
	const teams = Array.from({ length: 20 }, (_, index) => ({
		team_id: index + 1,
		code: 100 + index,
		name: `Contract Team ${index + 1}`,
		short_name: `C${String(index + 1).padStart(2, "0")}`,
		strength: null,
		position: index + 1,
		points: 0,
		played: 0,
		win: 0,
		draw: 0,
		loss: 0,
		form: null,
		strength_overall_home: 1000,
		strength_overall_away: 1000,
		strength_attack_home: 1000,
		strength_attack_away: 1000,
		strength_defence_home: 1000,
		strength_defence_away: 1000,
	}));
	const players = Array.from({ length: 20 * 11 }, (_, index) => {
		const teamId = Math.floor(index / 11) + 1;
		return {
			element_id: index + 1,
			code: 1000 + index,
			element_type: (index % 4) + 1,
			team_id: teamId,
			price: 50,
			start_price: 50,
			first_name: "Contract",
			second_name: `Player ${index + 1}`,
			web_name: `CP${index + 1}`,
			total_points: 0,
		};
	});
	const phases = [
		{ phase_id: 1, name: "Overall", start_event: 1, stop_event: 38, highest_score: null },
	];
	const fixtures: Record<string, unknown>[] = [];
	let fixtureId = 1;
	for (let home = 1; home <= 20; home += 1) {
		for (let away = home + 1; away <= 20; away += 1) {
			for (const [teamHId, teamAId] of [
				[home, away],
				[away, home],
			] as const) {
				fixtures.push({
					fixture_id: fixtureId,
					code: 5000 + fixtureId,
					event_id: ((fixtureId - 1) % 38) + 1,
					kickoff_time: null,
					started: false,
					finished: false,
					finished_provisional: false,
					minutes: 0,
					team_h_id: teamHId,
					team_a_id: teamAId,
					team_h_score: null,
					team_a_score: null,
					team_h_difficulty: null,
					team_a_difficulty: null,
				});
				fixtureId += 1;
			}
		}
	}
	const manifestItems = [
		"events",
		"teams",
		"players",
		"phases",
		"fixtures",
		"currentEventId",
		"selectionRules",
	];
	return {
		authority_count: "1",
		publication_id: CONTRACT_CORE_PUBLICATION_ID,
		revision: "7",
		manifest: {
			dataset: "fpl:core",
			seasonCode: "2627",
			eventId: null,
			revision: 7,
			publicationId: CONTRACT_CORE_PUBLICATION_ID,
			sourceCheckedAt: "2026-08-10T00:00:00.000Z",
			publishedAt: "2026-08-10T00:00:00.000Z",
			state: "active",
			items: manifestItems.map((name) => ({
				name,
				key: `llm:data:fpl:core:2627:7:${name}`,
				type: "string",
				count: 0,
				bytes: 0,
				sha256: "0".repeat(64),
			})),
		},
		source_checked_at: "2026-08-10T00:00:00.000Z",
		events,
		teams,
		players,
		phases,
		fixtures,
		source_metadata: {},
	};
})();

describe("direct Data SQL contract", () => {
	test("has unique named planner probes for every hard-cut consumer family", () => {
		const names = DIRECT_DATA_SQL_CONTRACT.map((probe) => probe.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.some((name) => name.startsWith("briefing."))).toBe(true);
		expect(names).toContain("entries.search");
		expect(names.some((name) => name.startsWith("gameweek."))).toBe(true);
		expect(names).toContain("home.personal-desk");
		expect(names.some((name) => name.startsWith("home-market."))).toBe(true);
		expect(names.some((name) => name.startsWith("market."))).toBe(true);
		expect(names.some((name) => name.startsWith("my-fpl."))).toBe(true);
		expect(names.some((name) => name.startsWith("player-detail."))).toBe(true);
		expect(names.some((name) => name.startsWith("players."))).toBe(true);
		expect(names.some((name) => name.startsWith("player-values."))).toBe(true);
		expect(names.some((name) => name.startsWith("player-state."))).toBe(true);
		expect(names).toContain("live-tournament.selection-index");
		expect(names.some((name) => name.startsWith("public-league-trends."))).toBe(true);
		expect(names.some((name) => name.startsWith("trends."))).toBe(true);
		expect(names.some((name) => name.startsWith("data-snapshot."))).toBe(true);
		expect(names.some((name) => name.startsWith("price-change."))).toBe(true);
		expect(names).toContain("live-matches-v3.checkpoint-fallback");
	});

	test("gates Live Matches checkpoint shape with the runtime reader role", () => {
		const probe = DIRECT_DATA_SQL_CONTRACT.find(
			(candidate) => candidate.name === "live-matches-v3.checkpoint-fallback"
		);
		expect(probe?.sql).toContain("fpl.live_match_desk_checkpoints");
		expect(probe?.sql).toContain("fpl.live_match_detail_checkpoints");
		expect(probe?.runtime).toBe("must-return-row");
		expect(probe?.resultTypes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relation: "fpl.live_match_desk_checkpoints",
					column: "manifest",
					pgType: "jsonb",
				}),
				expect.objectContaining({
					relation: "fpl.live_match_detail_checkpoints",
					column: "payload",
					pgType: "jsonb",
				}),
			])
		);
	});

	test("contains the direct reporting relations and only read statements", () => {
		const sql = DIRECT_DATA_SQL_CONTRACT.map((probe) => probe.sql).join("\n");
		expect(sql).toContain("content.publication_payloads");
		expect(sql).toContain("payload_bytes");
		expect(sql).toContain("payload_sha256");
		expect(sql).toContain("reporting.player_season_summary_rows");
		expect(sql).toContain("reporting.tournament_selection_stat_publications");
		expect(sql).toContain("reporting.tournament_selection_stat_rows");
		expect(sql).toContain("captured_at = $3::timestamptz");
		for (const probe of DIRECT_DATA_SQL_CONTRACT) {
			const statement = probe.sql.trimStart().replace(/^\/\*[\s\S]*?\*\/\s*/, "");
			expect(statement).toMatch(/^(SELECT|WITH)\b/);
			expect(Array.isArray(probe.values)).toBe(true);
		}
	});

	test("asserts JSON-compatible types for payload columns decoded by the runtime", () => {
		const payloadAssertions = DIRECT_DATA_SQL_CONTRACT.flatMap(
			(probe) => probe.resultTypes ?? []
		).filter(({ column }) => column === "payload");
		expect(payloadAssertions.length).toBeGreaterThan(0);
		expect(payloadAssertions.every(({ pgType }) => pgType === "jsonb")).toBe(true);
		expect(
			payloadAssertions.every(
				({ acceptedPgTypes }) =>
					JSON.stringify(acceptedPgTypes) === JSON.stringify(["json", "jsonb"])
			)
		).toBe(true);
		expect(payloadAssertions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relation: "ops.dataset_publication_items",
					column: "payload",
					pgType: "jsonb",
					acceptedPgTypes: ["json", "jsonb"],
				}),
				expect.objectContaining({
					relation: "content.publication_payloads",
					column: "payload",
					pgType: "jsonb",
					acceptedPgTypes: ["json", "jsonb"],
				}),
			])
		);
		const expectedRelations = new Set(payloadAssertions.map(({ relation }) => relation));
		expect(expectedRelations).toEqual(
			new Set([
				"content.publication_payloads",
				"ops.dataset_publication_items",
				"competition.tournament_review_publications",
				"competition.my_fpl_snapshot_entries",
				"competition.my_fpl_snapshot_tournament_rows",
				"competition.my_fpl_snapshot_tournament_aggregates",
				"fpl.live_match_desk_checkpoints",
				"fpl.live_match_detail_checkpoints",
			])
		);
	});

	test("fails the candidate contract when a decoded payload column is text", async () => {
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, NULL)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type:
								relation === "content.publication_payloads" && columns[index] === "payload"
									? "text"
									: mockContractResultType(relation, columns[index]!, "jsonb"),
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				if (text === TRENDS_CONTRACT_PUBLICATION_ID_SQL) {
					return { rows: [{ publication_id: 2 }] } as unknown as QueryResult<Row>;
				}
				const runtimeProbe = DIRECT_DATA_SQL_CONTRACT.find(
					(probe) => probe.runtime && probe.sql === text
				);
				if (runtimeProbe?.runtime === "must-return-entry-search") {
					return { rows: [mockEntrySearchRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-publication") {
					return { rows: [mockSnapshotPublication] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-briefing") {
					return {
						rows: [mockBriefingFallbackRow(values[1] === "zh-CN" ? "zh-CN" : "en")],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-briefing-metadata") {
					return { rows: [mockBriefingMetadata] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-core") {
					return { rows: [mockCoreFallbackRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-competition-aggregate") {
					return {
						rows: [{ payload: mockCompetitionAggregatePayload }],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-price-change") {
					return { rows: [mockPriceChangePublication] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-trends-personal") {
					return { rows: mockTrendsRows } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-market") {
					return { rows: [{ market_rows: [mockMarketRow] }] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-market-authority") {
					return { rows: [mockMarketAuthority] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-revision") {
					return { rows: [mockPlayerStateRevision] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-current-peers") {
					return { rows: [mockPlayerStateCurrentPeer] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-gameweeks") {
					return { rows: [mockPlayerStateGameweek] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-picker") {
					return { rows: [mockPlayerPickerRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-row") {
					return { rows: [mockPlayerStateSeasonRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-historical-team") {
					return { rows: [mockHistoricalTeam] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-setup-status") {
					return { rows: [mockSetupStatus] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-snapshot-entry") {
					return {
						rows: [
							{
								payload: mockSnapshotEntryPayload,
								is_empty: true,
								picks_count: 0,
								entry_row_count: 0,
								aggregate_row_count: 2,
							},
						],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-board") {
					return { rows: [mockCompetitionBoardProbe] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-season-path") {
					return { rows: [{ payload: mockSeasonPathPayload }] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-tournament") {
					return {
						rows: [{ tournament_id: values[2] }],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-selection-row") {
					return {
						rows: [
							{
								publication_id: "1",
								expected_entries: "1",
								complete_pick_entries: "1",
								revision: "1",
								publication_state: "READY",
								ownership_state: "READY",
								captaincy_state: "READY",
								vice_captaincy_state: "READY",
								transfers_state: "READY",
								element_id: 1,
								selected_count: 1,
								effective_selection_count: 1,
								captain_count: 1,
								vice_captain_count: 0,
								transfer_in_count: 0,
								transfer_out_count: 0,
								player_position: 1,
								player_name: "Contract Player",
								team_short_name: "GCT",
							},
						],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-row") {
					return { rows: [{}] } as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		await expect(validateDirectDataSqlContract(database)).rejects.toThrow(
			/expected json or jsonb, got text/
		);
	});

	test("allows equivalent JSON and JSONB decoded types only where declared", () => {
		const metadata = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "briefing.active-metadata"
		);
		expect(metadata?.resultTypes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relation: "content.briefing_active_publication",
					column: "servable",
					pgType: "boolean",
				}),
				expect.objectContaining({
					relation: "content.briefing_active_publication",
					column: "locale_manifest",
					pgType: "jsonb",
					acceptedPgTypes: ["json", "jsonb"],
				}),
			])
		);
	});

	test("always keeps the primary PostgreSQL type in the accepted type set", () => {
		expect(
			allowedResultTypes({
				relation: "content.publication_payloads",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json"],
			})
		).toEqual(["json", "jsonb"]);
	});

	test("accepts character varying for the decoded Market position", () => {
		const market = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "market.snapshot-window"
		);
		const position = market?.resultTypes?.find((assertion) => assertion.column === "position");
		expect(position && allowedResultTypes(position)).toEqual(["character varying", "text"]);
	});

	test("covers decoder-sensitive Core, publication, catalog and price metadata fields", () => {
		const core = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "data-snapshot.core-fallback"
		)?.resultTypes;
		for (const column of [
			"name",
			"short_name",
			"form",
			"strength_overall_home",
			"strength_overall_away",
			"strength_attack_home",
			"strength_attack_away",
			"strength_defence_home",
			"strength_defence_away",
		]) {
			expect(core).toEqual(expect.arrayContaining([expect.objectContaining({ column })]));
		}
		for (const column of [
			"cup_league_create",
			"h2h_ko_matches_created",
			"average_entry_score",
			"highest_scoring_entry",
			"deadline_time_epoch",
			"deadline_time_game_offset",
			"highest_score",
			"chip_plays",
			"most_selected",
			"most_transferred_in",
			"top_element",
			"top_element_info",
			"transfers_made",
			"most_captained",
			"most_vice_captained",
		]) {
			expect(core).toEqual(expect.arrayContaining([expect.objectContaining({ column })]));
		}
		for (const column of [
			"source_checked_at",
			"published_at",
			"source_min_checked_at",
			"source_max_checked_at",
		]) {
			expect(
				DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "my-fpl.active-publications")
					?.resultTypes
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						relation: "competition.my_fpl_snapshot_publications",
						column,
						pgType: "timestamp with time zone",
					}),
				])
			);
		}
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "public-league-trends.catalog")
				?.resultTypes
		).toEqual(
			expect.arrayContaining([
				{
					relation: "competition.public_league_trends",
					column: "published_at",
					pgType: "timestamp with time zone",
				},
				{
					relation: "competition.public_league_trends",
					column: "updated_at",
					pgType: "timestamp with time zone",
				},
			])
		);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find(
				(probe) => probe.name === "price-change.publication-item-metadata"
			)?.resultTypes
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relation: "ops.dataset_publication_items",
					column: "publication_id",
					pgType: "uuid",
				}),
				expect.objectContaining({
					relation: "ops.dataset_publication_items",
					column: "item_count",
					pgType: "integer",
				}),
				expect.objectContaining({
					relation: "ops.dataset_publication_items",
					column: "checksum",
					pgType: "text",
				}),
			])
		);
	});

	test("accepts JSON for every decoded JSON contract column", async () => {
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, NULL)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type: mockContractResultType(relation, columns[index]!, "json"),
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				if (text === TRENDS_CONTRACT_PUBLICATION_ID_SQL) {
					return { rows: [{ publication_id: 2 }] } as unknown as QueryResult<Row>;
				}
				const runtimeProbe = DIRECT_DATA_SQL_CONTRACT.find(
					(probe) => probe.runtime && probe.sql === text
				);
				if (runtimeProbe?.runtime === "must-return-entry-search") {
					return { rows: [mockEntrySearchRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-publication") {
					return { rows: [mockSnapshotPublication] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-briefing") {
					return {
						rows: [mockBriefingFallbackRow(values[1] === "zh-CN" ? "zh-CN" : "en")],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-briefing-metadata") {
					return { rows: [mockBriefingMetadata] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-core") {
					return { rows: [mockCoreFallbackRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-competition-aggregate") {
					return {
						rows: [{ payload: mockCompetitionAggregatePayload }],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-price-change") {
					return { rows: [mockPriceChangePublication] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-trends-personal") {
					return { rows: mockTrendsRows } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-snapshot-entry") {
					return {
						rows: [
							{
								payload: mockSnapshotEntryPayload,
								is_empty: true,
								picks_count: 0,
								entry_row_count: 0,
								aggregate_row_count: 2,
							},
						],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-board") {
					return { rows: [mockCompetitionBoardProbe] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-season-path") {
					return { rows: [{ payload: mockSeasonPathPayload }] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-market") {
					return { rows: [{ market_rows: [mockMarketRow] }] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-market-authority") {
					return { rows: [mockMarketAuthority] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-revision") {
					return { rows: [mockPlayerStateRevision] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-current-peers") {
					return { rows: [mockPlayerStateCurrentPeer] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-gameweeks") {
					return { rows: [mockPlayerStateGameweek] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-picker") {
					return { rows: [mockPlayerPickerRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-row") {
					return { rows: [mockPlayerStateSeasonRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-historical-team") {
					return { rows: [mockHistoricalTeam] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-setup-status") {
					return { rows: [mockSetupStatus] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-tournament") {
					return {
						rows: [{ tournament_id: values[2] }],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-selection-row") {
					return {
						rows: [
							{
								publication_id: "1",
								expected_entries: "1",
								complete_pick_entries: "1",
								revision: "1",
								publication_state: "READY",
								ownership_state: "READY",
								captaincy_state: "READY",
								vice_captaincy_state: "READY",
								transfers_state: "READY",
								element_id: 1,
								selected_count: 1,
								effective_selection_count: 1,
								captain_count: 1,
								vice_captain_count: 0,
								transfer_in_count: 0,
								transfer_out_count: 0,
								player_position: 1,
								player_name: "Contract Player",
								team_short_name: "GCT",
							},
						],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-row") {
					return { rows: [{}] } as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		expect(await validateDirectDataSqlContract(database)).toBe(DIRECT_DATA_SQL_CONTRACT.length);
	});

	test("fails closed when the runtime reader cannot see the authority fixture", async () => {
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, NULL)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type: mockContractResultType(relation, columns[index]!, "jsonb"),
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		await expect(validateDirectDataSqlContract(database)).rejects.toThrow(/runtime visibility/);
	});

	test("fails closed when the runtime board join is empty or has no viewer row", async () => {
		const boardSql = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "my-fpl.competition-board"
		)?.sql;
		const database: QueryExecutor = {
			query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
				if (text.includes("format_type(attribute.atttypid, NULL)")) {
					const relations = values[0] as readonly string[];
					const columns = values[1] as readonly string[];
					return {
						rows: relations.map((relation, index) => ({
							relation_name: relation,
							column_name: columns[index],
							actual_type: mockContractResultType(relation, columns[index]!, "jsonb"),
						})) as unknown as Row[],
					} as unknown as QueryResult<Row>;
				}
				if (text === boardSql) {
					return { rows: [{ field_size: 0, viewer_row: null }] } as unknown as QueryResult<Row>;
				}
				if (text === TRENDS_CONTRACT_PUBLICATION_ID_SQL) {
					return { rows: [{ publication_id: 2 }] } as unknown as QueryResult<Row>;
				}
				const runtimeProbe = DIRECT_DATA_SQL_CONTRACT.find(
					(probe) => probe.runtime && probe.sql === text
				);
				if (runtimeProbe?.runtime === "must-return-entry-search") {
					return { rows: [mockEntrySearchRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-publication") {
					return { rows: [mockSnapshotPublication] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-briefing") {
					return {
						rows: [mockBriefingFallbackRow(values[1] === "zh-CN" ? "zh-CN" : "en")],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-briefing-metadata") {
					return { rows: [mockBriefingMetadata] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-core") {
					return { rows: [mockCoreFallbackRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-competition-aggregate") {
					return {
						rows: [{ payload: mockCompetitionAggregatePayload }],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-price-change") {
					return { rows: [mockPriceChangePublication] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-trends-personal") {
					return { rows: mockTrendsRows } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-market") {
					return { rows: [{ market_rows: [mockMarketRow] }] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-market-authority") {
					return { rows: [mockMarketAuthority] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-revision") {
					return { rows: [mockPlayerStateRevision] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-current-peers") {
					return { rows: [mockPlayerStateCurrentPeer] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-gameweeks") {
					return { rows: [mockPlayerStateGameweek] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-picker") {
					return { rows: [mockPlayerPickerRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-player-state-row") {
					return { rows: [mockPlayerStateSeasonRow] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-historical-team") {
					return { rows: [mockHistoricalTeam] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-setup-status") {
					return { rows: [mockSetupStatus] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-snapshot-entry") {
					return {
						rows: [
							{
								payload: mockSnapshotEntryPayload,
								is_empty: true,
								picks_count: 0,
								entry_row_count: 0,
								aggregate_row_count: 2,
							},
						],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-tournament") {
					return { rows: [{ tournament_id: values[2] }] } as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime === "must-return-selection-row") {
					return {
						rows: [
							{
								publication_id: "1",
								expected_entries: "1",
								complete_pick_entries: "1",
								revision: "1",
								publication_state: "READY",
								ownership_state: "READY",
								captaincy_state: "READY",
								vice_captaincy_state: "READY",
								transfers_state: "READY",
								element_id: 1,
								selected_count: 1,
								effective_selection_count: 1,
								captain_count: 1,
								vice_captain_count: 0,
								transfer_in_count: 0,
								transfer_out_count: 0,
								player_position: 1,
								player_name: "Contract Player",
								team_short_name: "GCT",
							},
						],
					} as unknown as QueryResult<Row>;
				}
				if (runtimeProbe?.runtime) {
					return { rows: [{}] } as unknown as QueryResult<Row>;
				}
				return { rows: [] } as unknown as QueryResult<Row>;
			},
		};
		await expect(validateDirectDataSqlContract(database)).rejects.toThrow(
			/my-fpl\.competition-board/
		);
	});

	test("uses the runtime Briefing payload fallback as a planner probe", () => {
		const fallback = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "briefing.payload-fallback"
		);
		expect(fallback?.values).toEqual(["week", "en"]);
		expect(fallback?.runtime).toBe("must-return-briefing");
	});

	test("uses the runtime historical-team statements as planner probes", () => {
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "gameweek.historical-team-exact")?.sql
		).toBe(GAMEWEEK_HISTORICAL_TEAM_EXACT_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "gameweek.historical-team-as-of")?.sql
		).toBe(GAMEWEEK_HISTORICAL_TEAM_AS_OF_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "player-detail.historical-teams")?.sql
		).toBe(PLAYER_DETAIL_HISTORICAL_TEAMS_SQL);
	});

	test("uses the runtime Entry search and Home desk statements as planner probes", () => {
		expect(DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "entries.search")?.sql).toBe(
			SEARCH_ENTRIES_SQL
		);
		expect(DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home.personal-desk")?.sql).toBe(
			HOME_PERSONAL_DESK_SQL
		);
	});

	test("uses the runtime Market statements as planner probes", () => {
		const market = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "market.snapshot-window"
		);
		expect(market?.sql).toBe(MARKET_QUERY);
		expect(market?.resultTypes).toEqual([
			expect.objectContaining({
				relation: "fpl.player_market_snapshots",
				column: "position",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			}),
		]);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home-market.ownership")?.sql
		).toBe(HOME_MARKET_OWNERSHIP_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home-market.price-changes")?.sql
		).toBe(HOME_MARKET_PRICE_CHANGES_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "home-market.availability")?.sql
		).toBe(HOME_MARKET_AVAILABILITY_SQL);
	});

	test("uses the runtime publication and snapshot fallback statements as planner probes", () => {
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "price-change.publication-candidates")
				?.sql
		).toBe(PUBLICATION_CANDIDATES_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "price-change.publication-by-id")?.sql
		).toBe(PUBLICATION_BY_ID_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "price-change.publication-decoder")
				?.sql
		).toBe(PRICE_CHANGE_PUBLICATION_CONTRACT_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "price-change.publication-items")?.sql
		).toBe(PUBLICATION_ITEMS_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find(
				(probe) => probe.name === "price-change.publication-context-items"
			)?.sql
		).toBe(PUBLICATION_CONTEXT_ITEMS_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find(
				(probe) => probe.name === "price-change.publication-item-metadata"
			)?.sql
		).toBe(PUBLICATION_ITEM_METADATA_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "data-snapshot.core-fallback")?.sql
		).toBe(CORE_FALLBACK_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find((probe) => probe.name === "data-snapshot.core-phase-shape")?.sql
		).toBe(CORE_PHASE_SHAPE_SQL);
		expect(
			DIRECT_DATA_SQL_CONTRACT.find(
				(probe) => probe.name === "data-snapshot.core-live-identity-fallback"
			)?.sql
		).toBe(CORE_LIVE_IDENTITY_FALLBACK_SQL);
	});

	test("requires the My FPL authority fixture to be visible to the runtime reader", () => {
		const runtimeProbes = DIRECT_DATA_SQL_CONTRACT.filter((probe) => probe.runtime);
		expect(runtimeProbes.map((probe) => probe.name)).toEqual(
			expect.arrayContaining([
				"my-fpl.active-publications",
				"my-fpl.snapshot-entry",
				"my-fpl.snapshot-tournament-row-visibility",
				"my-fpl.competition-aggregate",
				"my-fpl.competition-board",
				"my-fpl.competition-season-path",
				"my-fpl.assert-tournament-membership",
				"my-fpl.assert-league-only-membership",
				"my-fpl.list-tournament-memberships",
			])
		);
		expect(runtimeProbes.map((probe) => probe.name)).toContain("public-league-trends.catalog");
		expect(runtimeProbes.map((probe) => probe.name)).toContain("public-league-trends.selection");
		expect(runtimeProbes.map((probe) => probe.name)).toContain("players.picker");
		expect(runtimeProbes.map((probe) => probe.name)).toContain("player-state.season-rows");
		expect(
			runtimeProbes.every(
				(probe) =>
					probe.runtime === "must-return-row" ||
					probe.runtime === "must-return-entry-search" ||
					probe.runtime === "must-return-publication" ||
					probe.runtime === "must-return-snapshot-entry" ||
					probe.runtime === "must-return-briefing" ||
					probe.runtime === "must-return-core" ||
					probe.runtime === "must-return-competition-aggregate" ||
					probe.runtime === "must-return-price-change" ||
					probe.runtime === "must-return-trends-personal" ||
					probe.runtime === "must-return-board" ||
					probe.runtime === "must-return-season-path" ||
					probe.runtime === "must-return-briefing-metadata" ||
					probe.runtime === "must-return-market" ||
					probe.runtime === "must-return-market-authority" ||
					probe.runtime === "must-return-player-state-revision" ||
					probe.runtime === "must-return-player-state-current-peers" ||
					probe.runtime === "must-return-player-state-gameweeks" ||
					probe.runtime === "must-return-historical-team" ||
					probe.runtime === "must-return-setup-status" ||
					probe.runtime === "must-return-tournament" ||
					probe.runtime === "must-return-selection-row" ||
					probe.runtime === "must-return-player-picker" ||
					probe.runtime === "must-return-player-state-row"
			)
		).toBe(true);
	});

	test("validates live picker publication identity and player uniqueness", () => {
		const row = {
			publication_id: "1",
			expected_entries: "2",
			complete_pick_entries: "2",
			revision: "7",
			publication_state: "READY",
			ownership_state: "READY",
			element_id: 1,
			selected_count: 1,
		};
		expect(validateTournamentSelectionIndexContractRows([row])).toBe(true);
		expect(
			validateTournamentSelectionIndexContractRows([
				row,
				{ ...row, publication_id: "2", element_id: 2 },
			])
		).toBe(false);
		expect(validateTournamentSelectionIndexContractRows([row, { ...row, element_id: 1 }])).toBe(
			false
		);
	});

	test("lets PostgreSQL infer the opaque Trends publication identity", () => {
		const aggregate = DIRECT_DATA_SQL_CONTRACT.find(
			(probe) => probe.name === "trends.aggregate-union"
		);
		expect(aggregate?.values).toEqual([null, 12, 2026, 1, 2]);
		expect(aggregate?.runtime).toBe("must-return-trends-personal");
	});
});
