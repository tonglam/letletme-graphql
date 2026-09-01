import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";

import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID } from "../../contracts/data-fixture-identities";
import type { GraphQLContext } from "../../graphql/context";
import {
	hasPlatformAdminAccess,
	hasVerifiedEntry,
	viewerEntryIdForPrincipal,
} from "../../graphql/authorization";
import { gqlCacheKey } from "../../infra/cache-key";
import { env } from "../../infra/env";
import { readJsonQueryCache, writeJsonQueryCache } from "../../infra/query-cache";

export type MyTournamentReviewScope = "ACCESSIBLE" | "MANAGED" | "ALL";
export type MyTournamentReviewFormat = "POINTS" | "H2H" | "KNOCKOUT";
export const MY_TOURNAMENT_REVIEW_CONTRACT = "my-tournament-review-v2.1" as const;
export const MY_TOURNAMENT_REVIEW_METRIC_VERSION = "settled-review-v2" as const;
export type MyTournamentReviewState =
	"NOT_STARTED" | "PENDING" | "WAITING_SOURCE" | "READY" | "DEGRADED" | "UNAVAILABLE";

export type MyTournamentReviewSeasonSection =
	| "POINTS_STANDINGS"
	| "POINTS_TRAJECTORIES"
	| "H2H_STANDINGS"
	| "H2H_FIXTURES"
	| "KNOCKOUT_BRACKET";

export type MyTournamentReviewCatalogItem = {
	tournamentId: number;
	name: string;
	creator: string;
	leagueId: number;
	leagueType: string;
	totalTeamNum: number;
	latestFinalizedEventId: number | null;
	state: MyTournamentReviewState;
	previousReadyEventId: number | null;
	setupStatus: string;
	latestFinalizedScope: MyTournamentReviewEventStatus | null;
	phaseSummaries: Array<{
		phaseId: string;
		format: MyTournamentReviewFormat;
		startEventId: number;
		endEventId: number | null;
		state: MyTournamentReviewState;
	}>;
};

export type MyTournamentReviewCatalog = {
	state: MyTournamentReviewState;
	asOf: string;
	viewerEntryId: number | null;
	adminReadAll: boolean;
	tournaments: MyTournamentReviewCatalogItem[];
};

export type MyTournamentReviewCatalogConnection = Omit<MyTournamentReviewCatalog, "tournaments"> & {
	tournaments: MyTournamentReviewCatalogItem[];
	edges: Array<{ cursor: string; node: MyTournamentReviewCatalogItem }>;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type MyTournamentSeasonSection = {
	state: MyTournamentReviewState;
	tournamentId: number;
	throughEventId: number;
	phaseId: string;
	section: MyTournamentReviewSeasonSection;
	revision: string;
	semanticSha256: string;
	points: MyTournamentReviewPoints | null;
	h2h: MyTournamentReviewH2H | null;
	knockout: MyTournamentReviewKnockout | null;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type MyTournamentReviewFreshness = {
	eventDataCheckedAt: string;
	sourceMinCheckedAt: string;
	sourceMaxCheckedAt: string;
	publishedAt: string;
	ageSeconds: number;
};

export type MyTournamentReviewScopeMeta = {
	tournamentId: number;
	eventId: number;
	revision: string;
	format: MyTournamentReviewFormat;
	state: MyTournamentReviewState;
	freshness: MyTournamentReviewFreshness | null;
	rowCount: number;
	expectedSubjectCount: number;
	readySubjectCount: number;
	notApplicableSubjectCount: number;
	contentSha256: string | null;
	correctedAt?: string | null;
};

export type MyTournamentReviewPointsRow = {
	entryId: number;
	entryName: string;
	playerName: string;
	applicable: boolean;
	groupId: number | null;
	rank: number | null;
	previousRank: number | null;
	grossPoints: number | null;
	transferCost: number | null;
	netPoints: number | null;
	tournamentScore: number | null;
	seasonGrossPoints: number | null;
	seasonNetPoints: number | null;
	eventRank: number | null;
	overallPoints: number | null;
	overallRank: number | null;
};

type MyTournamentReviewPointsAggregateWitness = {
	view: "GAMEWEEK" | "SEASON";
	rowCount: number;
	applicableRowCount: number;
	pageOffset: number;
	pageLength: number;
	grossPointsTotal: number;
	grossPointsAverage: number;
	netPointsTotal: number;
	seasonGrossPointsTotal: number;
	seasonGrossPointsAverage: number;
	seasonNetPointsTotal: number;
	selectedGrossPointsTotal: number;
	selectedGrossPointsAverage: number;
	selectedNetPointsTotal: number;
	rows: MyTournamentReviewPointsAggregateRow[];
};

type MyTournamentReviewPointsAggregateRow = {
	entryId: number;
	applicable: boolean;
	/** Source Gameweek metrics, retained so Season caches can still witness both views. */
	sourceGrossPoints: number | null;
	sourceTransferCost: number | null;
	sourceNetPoints: number | null;
	/** Metrics returned by this cached view (Gameweek or Season projection). */
	grossPoints: number | null;
	transferCost: number | null;
	netPoints: number | null;
	seasonGrossPoints: number | null;
	seasonNetPoints: number | null;
};

export type MyTournamentReviewPoints = {
	headlineMetric: string;
	grossPointsTotal: number;
	grossPointsAverage: number;
	netPointsTotal: number;
	seasonGrossPointsTotal: number;
	seasonGrossPointsAverage: number;
	seasonNetPointsTotal: number;
	rows: MyTournamentReviewPointsRow[];
	nextCursor: string | null;
	hasNextPage: boolean;
	/** Full-scope aggregate witness retained only for revisioned query-cache validation. */
	aggregateWitness: MyTournamentReviewPointsAggregateWitness;
};

export type MyTournamentReviewH2HSide = {
	entryId: number | null;
	entryName: string;
	isAverage: boolean;
	grossPoints: number | null;
	transferCost: number | null;
	netPoints: number | null;
	matchPoints: number | null;
	rank: number | null;
};

export type MyTournamentReviewH2HMatch = {
	matchId: string;
	groupId: number;
	home: MyTournamentReviewH2HSide | null;
	away: MyTournamentReviewH2HSide | null;
	isBye: boolean;
};

export type MyTournamentReviewH2HStanding = {
	groupId: number;
	entryId: number;
	entryName: string;
	rank: number;
	played: number;
	won: number;
	drawn: number;
	lost: number;
	matchPoints: number;
	pointsFor: number;
	pointsAgainst: number;
};

export type MyTournamentReviewH2H = {
	matches: MyTournamentReviewH2HMatch[];
	standings: MyTournamentReviewH2HStanding[];
	nextCursor: string | null;
	hasNextPage: boolean;
	/** Full-scope fixture/standing identity witness retained for cache validation. */
	coverageWitness: MyTournamentReviewH2HCoverageWitness;
};

type MyTournamentReviewH2HCoverageWitness = {
	matchIdentities: string[];
	matchParticipantIdentities: string[];
	standingIdentities: string[];
	pageOffset: number;
	pageMatchParticipantIdentities: string[];
	pageStandingIdentities: string[];
};

export type MyTournamentReviewKnockoutSide = {
	entryId: number;
	entryName: string;
	/** Internal publication coverage marker; GraphQL does not expose it. */
	applicable?: boolean;
	grossPoints: number | null;
	transferCost: number | null;
	netPoints: number | null;
	goalsScored: number | null;
	goalsConceded: number | null;
};

export type MyTournamentReviewKnockoutMatch = {
	round: number | null;
	name: string | null;
	matchId: number;
	playAgainstId: number;
	home: MyTournamentReviewKnockoutSide | null;
	away: MyTournamentReviewKnockoutSide | null;
	winnerEntryId: number | null;
};

export type MyTournamentReviewKnockout = {
	matches: MyTournamentReviewKnockoutMatch[];
	nextCursor: string | null;
	hasNextPage: boolean;
};

export type MyTournamentGameweekReview = {
	state: MyTournamentReviewState;
	scope: MyTournamentReviewScopeMeta | null;
	points: MyTournamentReviewPoints | null;
	h2h: MyTournamentReviewH2H | null;
	knockout: MyTournamentReviewKnockout | null;
};

export type MyTournamentSeasonReview = {
	state: MyTournamentReviewState;
	tournamentId: number;
	throughEventId: number;
	latestEventId: number | null;
	latestRevision: string | null;
	format: MyTournamentReviewFormat | null;
	freshness: MyTournamentReviewFreshness | null;
	finalizedEventIds: number[];
	points: MyTournamentReviewPoints | null;
	h2h: MyTournamentReviewH2H | null;
	knockout: MyTournamentReviewKnockout | null;
	phases?: Array<{
		phaseId: string;
		format: MyTournamentReviewFormat;
		startEventId: number;
		endEventId: number;
		state: MyTournamentReviewState;
		settledAt: string | null;
		publishedAt: string | null;
		correctedAt: string | null;
		revision: string | null;
		semanticSha256: string | null;
	}>;
	/** Internal publication identity used by the V2.1 resolver adapter. */
	semanticSha256?: string | null;
};

export type MyTournamentReviewEventStatus = {
	eventId: number;
	format: MyTournamentReviewFormat;
	state: MyTournamentReviewState;
	nextAttemptAt: string | null;
	executionAttempts: number;
	sourceRechecks: number;
	degradedAt: string | null;
	revision: string | null;
	publishedAt: string | null;
};

export type MyTournamentReviewStatus = {
	tournamentId: number;
	latestFinalizedEventId: number | null;
	events: MyTournamentReviewEventStatus[];
};

type CatalogRow = {
	tournament_id: number;
	name: string;
	creator: string;
	league_id: number;
	league_type: string;
	total_team_num: number;
	group_mode: string | null;
	group_started_event_id: number | null;
	group_ended_event_id: number | null;
	knockout_mode: string | null;
	knockout_started_event_id: number | null;
	knockout_ended_event_id: number | null;
	latest_finalized_event_id: number | null;
	latest_ready_event_id: number | null;
	latest_revision: number | string | null;
	latest_format: string | null;
	latest_state: string | null;
	published_at: Date | string | null;
	setup_status: string | null;
	previous_ready_event_id: number | null;
	finalized_format: string | null;
	finalized_state: string | null;
	finalized_next_attempt_at: Date | string | null;
	finalized_execution_attempts: number | null;
	finalized_source_rechecks: number | null;
	finalized_degraded_at: Date | string | null;
	finalized_revision: number | string | null;
	finalized_published_at: Date | string | null;
};

type PublicationRow = {
	season_id: number;
	tournament_id: number;
	event_id: number;
	revision: number | string;
	format: string;
	schema_version: string;
	metric_version: string;
	event_data_checked_at: Date | string;
	source_min_checked_at: Date | string;
	source_max_checked_at: Date | string;
	expected_subject_count: number;
	ready_subject_count: number;
	not_applicable_subject_count: number;
	row_count: number;
	content_sha256: string;
	payload: unknown;
	published_at: Date | string;
	correction_change_id?: string | null;
	finalized_event_ids?: unknown;
};

type PublicationChunkRow = {
	section_key: string;
	chunk_index: number | string;
	item_count: number | string;
	chunk_sha256: string;
	items: unknown;
};

type ObligationRow = {
	event_id: number | null;
	format: string | null;
	state: string | null;
	next_attempt_at: Date | string | null;
	execution_attempts: number | null;
	source_rechecks: number | null;
	degraded_at: Date | string | null;
	revision: number | string | null;
	published_at: Date | string | null;
	latest_finalized_event_id: number | null;
};

export const MY_TOURNAMENT_REVIEW_CATALOG_SQL = `
	SELECT tournament.tournament_id,
	       tournament.name,
	       tournament.creator,
	       tournament.league_id,
	       tournament.league_type::text AS league_type,
	       tournament.total_team_num,
	       tournament.group_mode::text AS group_mode,
	       tournament.group_started_event_id,
	       tournament.group_ended_event_id,
	       tournament.knockout_mode::text AS knockout_mode,
	       tournament.knockout_started_event_id,
	       tournament.knockout_ended_event_id,
	       finalized.latest_finalized_event_id,
	       head.latest_ready_event_id,
	       head.latest_revision,
	       head.latest_format,
	       COALESCE(obligation.latest_state, 'UNAVAILABLE') AS latest_state,
	       head.published_at,
	       tournament.setup_status::text AS setup_status,
	       previous_ready.previous_ready_event_id,
	       finalized_obligation.format AS finalized_format,
	       CASE
	         WHEN finalized.latest_finalized_event_id IS NULL THEN 'NOT_STARTED'
	         WHEN finalized_obligation.state = 'READY'
	          AND head.latest_ready_event_id = finalized.latest_finalized_event_id THEN 'READY'
	         WHEN finalized_obligation.state = 'READY' THEN 'DEGRADED'
	         ELSE COALESCE(finalized_obligation.state, 'UNAVAILABLE')
	       END AS finalized_state,
	       finalized_obligation.next_attempt_at AS finalized_next_attempt_at,
	       finalized_obligation.execution_attempts AS finalized_execution_attempts,
	       finalized_obligation.source_rechecks AS finalized_source_rechecks,
	       finalized_obligation.degraded_at AS finalized_degraded_at,
	       CASE
	         WHEN finalized_obligation.state = 'READY'
	          AND head.latest_ready_event_id = finalized.latest_finalized_event_id
	         THEN finalized_obligation.ready_revision
	         ELSE NULL
	       END AS finalized_revision,
	       CASE
	         WHEN finalized_obligation.state = 'READY'
	          AND head.latest_ready_event_id = finalized.latest_finalized_event_id
	         THEN finalized_obligation.published_at
	         ELSE NULL
	       END AS finalized_published_at
	FROM competition.tournaments tournament
	LEFT JOIN LATERAL (
		SELECT max(event.event_id)::integer AS latest_finalized_event_id
		FROM fpl.events event
		WHERE event.season_id = tournament.season_id
		  AND event.finished = true
		  AND event.data_checked = true
		  AND event.data_checked_at IS NOT NULL
		  AND (
			(
				tournament.knockout_mode::text <> 'no_knockout'
				AND tournament.knockout_started_event_id IS NOT NULL
				AND event.event_id >= tournament.knockout_started_event_id
				AND (tournament.knockout_ended_event_id IS NULL OR event.event_id <= tournament.knockout_ended_event_id)
			)
			OR (
				tournament.group_mode::text IN ('points_races', 'battle_races')
				AND tournament.group_started_event_id IS NOT NULL
				AND event.event_id >= tournament.group_started_event_id
				AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)
			)
		  )
	) finalized ON true
	LEFT JOIN LATERAL (
		SELECT publication.event_id AS latest_ready_event_id,
		       publication.revision AS latest_revision,
		       publication.format AS latest_format,
		       publication.published_at
		FROM competition.tournament_review_heads review_head
		JOIN competition.tournament_review_publications publication
		  ON publication.season_id = review_head.season_id
		 AND publication.tournament_id = review_head.tournament_id
		 AND publication.event_id = review_head.event_id
		 AND publication.revision = review_head.revision
		 AND publication.content_sha256 = review_head.content_sha256
		JOIN competition.tournament_review_obligations head_obligation
		  ON head_obligation.season_id = review_head.season_id
		 AND head_obligation.tournament_id = review_head.tournament_id
		 AND head_obligation.event_id = review_head.event_id
		 AND head_obligation.format = publication.format
		 AND head_obligation.state = 'READY'
		 AND head_obligation.ready_revision = review_head.revision
		JOIN fpl.events head_event
		  ON head_event.season_id = publication.season_id
		 AND head_event.event_id = publication.event_id
		 AND head_event.finished = true
		 AND head_event.data_checked = true
		 AND head_event.data_checked_at IS NOT NULL
		WHERE review_head.season_id = tournament.season_id
		  AND review_head.tournament_id = tournament.tournament_id
		  -- Data serializes the checkpoint through JavaScript Date (millisecond
		  -- precision), while PostgreSQL can retain microseconds on fpl.events.
		  -- Match the canonical millisecond bucket so a sub-millisecond storage
		  -- difference does not make every otherwise coherent head disappear.
		  AND date_trunc('milliseconds', publication.event_data_checked_at) =
		      date_trunc('milliseconds', head_event.data_checked_at)
		  AND jsonb_typeof(publication.payload) = 'object'
		  AND jsonb_typeof(publication.payload->'manifest') = 'object'
		  AND jsonb_typeof(publication.payload->'manifest'->'sections') = 'array'
		  AND publication.payload->'manifest'->>'sectionCount' ~ '^[0-9]+$'
		  AND publication.payload->'manifest'->>'chunkCount' ~ '^[0-9]+$'
		  AND (publication.payload->'manifest'->>'sectionCount')::integer =
		      jsonb_array_length(publication.payload->'manifest'->'sections')
		  AND (publication.payload->'manifest'->>'chunkCount')::integer = (
		    SELECT count(*)::integer
		    FROM competition.tournament_review_publication_chunks chunk
		    WHERE chunk.season_id = publication.season_id
		      AND chunk.tournament_id = publication.tournament_id
		      AND chunk.event_id = publication.event_id
		      AND chunk.revision = publication.revision
		  )
		  AND NOT EXISTS (
		    SELECT 1
		    FROM jsonb_array_elements(publication.payload->'manifest'->'sections') descriptor
		    WHERE jsonb_typeof(descriptor) <> 'object'
		       OR descriptor->>'sectionKey' IS NULL
		       OR descriptor->>'chunkCount' !~ '^[0-9]+$'
		       OR descriptor->>'itemCount' !~ '^[0-9]+$'
		       OR jsonb_typeof(descriptor->'chunkHashes') <> 'array'
		       OR (descriptor->>'chunkCount')::integer <> jsonb_array_length(descriptor->'chunkHashes')
		       OR (descriptor->>'chunkCount')::integer <> (
		         SELECT count(*)::integer
		         FROM competition.tournament_review_publication_chunks chunk
		         WHERE chunk.season_id = publication.season_id
		           AND chunk.tournament_id = publication.tournament_id
		           AND chunk.event_id = publication.event_id
		           AND chunk.revision = publication.revision
		           AND chunk.section_key = descriptor->>'sectionKey'
		       )
		  )
		  AND NOT EXISTS (
		    SELECT 1
		    FROM competition.tournament_review_publication_chunks chunk
		    WHERE chunk.season_id = publication.season_id
		      AND chunk.tournament_id = publication.tournament_id
		      AND chunk.event_id = publication.event_id
		      AND chunk.revision = publication.revision
		      AND (
		        chunk.item_count < 0
		        OR chunk.item_count > 100
		        OR jsonb_typeof(chunk.items) <> 'array'
		        OR jsonb_array_length(chunk.items) <> chunk.item_count
		        OR chunk.chunk_sha256 <> encode(extensions.digest(convert_to(chunk.items::text, 'UTF8'), 'sha256'), 'hex')
		      )
		  )
		ORDER BY review_head.event_id DESC
		LIMIT 1
	) head ON true
	LEFT JOIN LATERAL (
		SELECT max(review_head.event_id)::integer AS previous_ready_event_id
		FROM competition.tournament_review_heads review_head
		JOIN competition.tournament_review_obligations ready_obligation
		  ON ready_obligation.season_id = review_head.season_id
		 AND ready_obligation.tournament_id = review_head.tournament_id
		 AND ready_obligation.event_id = review_head.event_id
		 AND ready_obligation.state = 'READY'
		 AND ready_obligation.ready_revision = review_head.revision
		WHERE review_head.season_id = tournament.season_id
		  AND review_head.tournament_id = tournament.tournament_id
		  AND (finalized.latest_finalized_event_id IS NULL OR review_head.event_id < finalized.latest_finalized_event_id)
	) previous_ready ON true
	LEFT JOIN LATERAL (
		SELECT state AS latest_state, format, next_attempt_at, execution_attempts,
		       source_rechecks, degraded_at, ready_revision, published_at
		FROM competition.tournament_review_obligations review_obligation
		WHERE review_obligation.season_id = tournament.season_id
		  AND review_obligation.tournament_id = tournament.tournament_id
		  AND review_obligation.event_id = finalized.latest_finalized_event_id
		ORDER BY review_obligation.event_id DESC
		LIMIT 1
	) obligation ON true
	LEFT JOIN LATERAL (
		SELECT state, format, next_attempt_at, execution_attempts,
		       source_rechecks, degraded_at, ready_revision, published_at
		FROM competition.tournament_review_obligations review_obligation
		WHERE review_obligation.season_id = tournament.season_id
		  AND review_obligation.tournament_id = tournament.tournament_id
		  AND review_obligation.event_id = finalized.latest_finalized_event_id
		LIMIT 1
	) finalized_obligation ON true
	WHERE tournament.season_id = $1
	  AND (
		$2 = 'ALL'
		OR ($2 = 'MANAGED' AND tournament.admin_entry_id = $3)
		OR (
			$2 = 'ACCESSIBLE'
			AND (
				EXISTS (
					SELECT 1
					FROM competition.tournament_entries roster
					WHERE roster.season_id = tournament.season_id
					  AND roster.tournament_id = tournament.tournament_id
					  AND roster.entry_id = $3
				)
				OR EXISTS (
					SELECT 1
					FROM competition.entry_leagues entry_league
					JOIN LATERAL (
						SELECT candidate.tournament_id
						FROM competition.tournaments candidate
						WHERE candidate.season_id = entry_league.season_id
						  AND candidate.league_id = entry_league.league_id
						  AND candidate.league_type = entry_league.league_type
						ORDER BY candidate.tournament_id
						LIMIT 1
					) mapped_tournament ON mapped_tournament.tournament_id = tournament.tournament_id
					WHERE entry_league.season_id = tournament.season_id
					  AND entry_league.entry_id = $3
					  AND entry_league.league_id = tournament.league_id
					  AND entry_league.league_type = tournament.league_type
				)
		  )
		)
	  )
	  AND ($4::integer IS NULL OR tournament.tournament_id < $4::integer)
	  AND ($5::text IS NULL OR tournament.name ILIKE '%' || $5::text || '%' OR tournament.creator ILIKE '%' || $5::text || '%')
	ORDER BY tournament.tournament_id DESC
	LIMIT $6::integer
`;

/**
 * Cache-miss payload read. The revision and content hash are captured from
 * the metadata query, so this statement intentionally does not re-join the
 * mutable active head. A concurrent head switch therefore cannot turn a
 * coherent immutable snapshot into a false disappearance.
 */
export const MY_TOURNAMENT_REVIEW_PUBLICATION_SQL = `
	SELECT publication.season_id,
	       publication.tournament_id,
	       publication.event_id,
	       publication.revision,
	       publication.format,
	       publication.schema_version,
	       publication.metric_version,
	       publication.event_data_checked_at,
	       publication.source_min_checked_at,
	       publication.source_max_checked_at,
	       publication.expected_subject_count,
	       publication.ready_subject_count,
	       publication.not_applicable_subject_count,
	       publication.row_count,
	       publication.content_sha256,
	       publication.payload,
	       publication.correction_change_id,
	       publication.published_at
	FROM competition.tournament_review_publications publication
	JOIN competition.tournament_review_obligations obligation
	  ON obligation.season_id = publication.season_id
	 AND obligation.tournament_id = publication.tournament_id
	 AND obligation.event_id = publication.event_id
	 AND obligation.format = publication.format
	JOIN fpl.events event
	  ON event.season_id = publication.season_id
	 AND event.event_id = publication.event_id
	WHERE publication.season_id = $1
	  AND publication.tournament_id = $2
	  AND publication.event_id = $3
	  AND publication.revision = $4::bigint
	  AND publication.content_sha256 = $5::text
		AND event.finished = true
		AND event.data_checked = true
				 AND event.data_checked_at IS NOT NULL
						 AND date_trunc('milliseconds', publication.event_data_checked_at) =
						     date_trunc('milliseconds', event.data_checked_at)
						 AND jsonb_typeof(publication.payload->'manifest') = 'object'
						 AND EXISTS (
					SELECT 1
					FROM competition.tournament_review_publication_chunks chunk
					WHERE chunk.season_id = publication.season_id
					  AND chunk.tournament_id = publication.tournament_id
					  AND chunk.event_id = publication.event_id
					  AND chunk.revision = publication.revision
				 )
	LIMIT 1
`;

/**
 * Read the immutable section siblings for a pinned publication.  The V2.1
 * section root reconstructs its requested projection from these bounded rows
 * and verifies the manifest/cardinality/hash contract before exposing data.
 */
export const MY_TOURNAMENT_REVIEW_SECTION_CHUNKS_SQL = `
	SELECT section_key, chunk_index, item_count, chunk_sha256, items
	FROM competition.tournament_review_publication_chunks
	WHERE season_id = $1
	  AND tournament_id = $2
	  AND event_id = $3
	  AND revision = $4::bigint
	ORDER BY section_key, chunk_index
`;

/**
 * Season cache-miss payload read by the exact immutable head identity selected
 * by MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL. The finalized event window and
 * missing-head reconciliation remain in that single metadata statement.
 */
export const MY_TOURNAMENT_REVIEW_SEASON_SQL = `
	SELECT publication.season_id,
	       publication.tournament_id,
	       publication.event_id,
	       publication.revision,
	       publication.format,
	       publication.schema_version,
	       publication.metric_version,
	       publication.event_data_checked_at,
	       publication.source_min_checked_at,
	       publication.source_max_checked_at,
	       publication.expected_subject_count,
	       publication.ready_subject_count,
	       publication.not_applicable_subject_count,
	       publication.row_count,
	       publication.content_sha256,
	       publication.payload,
	       publication.correction_change_id,
	       publication.published_at
	FROM competition.tournament_review_publications publication
	JOIN competition.tournament_review_obligations obligation
	  ON obligation.season_id = publication.season_id
	 AND obligation.tournament_id = publication.tournament_id
	 AND obligation.event_id = publication.event_id
	 AND obligation.format = publication.format
	JOIN fpl.events event
	  ON event.season_id = publication.season_id
	 AND event.event_id = publication.event_id
	WHERE publication.season_id = $1
	  AND publication.tournament_id = $2
	  AND publication.event_id = $4::integer
	  AND publication.event_id <= $3::integer
	  AND publication.revision = $5::bigint
	  AND publication.content_sha256 = $6::text
	  AND event.finished = true
	  AND event.data_checked = true
	  AND event.data_checked_at IS NOT NULL
		  AND date_trunc('milliseconds', publication.event_data_checked_at) =
		      date_trunc('milliseconds', event.data_checked_at)
		  AND jsonb_typeof(publication.payload->'manifest') = 'object'
		  AND EXISTS (
		SELECT 1
		FROM competition.tournament_review_publication_chunks chunk
		WHERE chunk.season_id = publication.season_id
		  AND chunk.tournament_id = publication.tournament_id
		  AND chunk.event_id = publication.event_id
		  AND chunk.revision = publication.revision
	  )
	LIMIT 1
`;

type ReviewHeadRow = {
	event_id: number | null;
	revision: number | string | null;
	format: string | null;
	content_sha256: string | null;
	event_data_checked_at: Date | string | null;
	published_at: Date | string | null;
	obligation_state?: string | null;
	active_revision?: number | string | null;
};

type ValidReviewHeadRow = {
	event_id: number;
	revision: number | string;
	format: string;
	content_sha256: string;
	event_data_checked_at: Date | string;
	published_at: Date | string;
};

type SeasonMetadataRow = {
	event_id: number | null;
	revision: number | string | null;
	format: string | null;
	content_sha256: string | null;
	correction_change_id: string | null;
	event_data_checked_at: Date | string | null;
	published_at: Date | string | null;
	row_count: number | null;
	ready_subject_count: number | null;
	obligation_format: string | null;
	obligation_state: string | null;
	finalized_event_ids: unknown;
};

/**
 * Metadata-only reads used to derive query-cache keys. Payload JSON is not
 * selected until the cache miss path, so a hot hit never pays the cost of
 * transferring or decoding a full immutable publication.
 */
export const MY_TOURNAMENT_REVIEW_HEAD_SQL = `
	WITH obligation AS (
		SELECT state
		FROM competition.tournament_review_obligations
		WHERE season_id = $1
		  AND tournament_id = $2
		  AND event_id = $3
		LIMIT 1
	), coherent_heads AS (
		SELECT head.event_id,
		       head.revision,
		       publication.format,
		       head.content_sha256,
		       publication.event_data_checked_at,
		       publication.published_at
		FROM competition.tournament_review_publications publication
		JOIN competition.tournament_review_heads head
		  ON publication.season_id = head.season_id
		 AND publication.tournament_id = head.tournament_id
		 AND publication.event_id = head.event_id
		 AND publication.revision = head.revision
		 AND publication.content_sha256 = head.content_sha256
		JOIN competition.tournament_review_obligations head_obligation
		  ON head_obligation.season_id = publication.season_id
		 AND head_obligation.tournament_id = publication.tournament_id
		 AND head_obligation.event_id = publication.event_id
		 AND head_obligation.format = publication.format
		 AND head_obligation.state = 'READY'
		 AND head_obligation.ready_revision = head.revision
		JOIN fpl.events event
		  ON event.season_id = publication.season_id
		 AND event.event_id = publication.event_id
		 AND event.finished = true
		 AND event.data_checked = true
		 AND event.data_checked_at IS NOT NULL
		 AND date_trunc('milliseconds', publication.event_data_checked_at) =
		     date_trunc('milliseconds', event.data_checked_at)
		 AND jsonb_typeof(publication.payload->'manifest') = 'object'
		 AND EXISTS (
			SELECT 1
			FROM competition.tournament_review_publication_chunks chunk
			WHERE chunk.season_id = publication.season_id
			  AND chunk.tournament_id = publication.tournament_id
			  AND chunk.event_id = publication.event_id
			  AND chunk.revision = publication.revision
		 )
		WHERE head.season_id = $1
		  AND head.tournament_id = $2
		  AND head.event_id = $3
	)
	SELECT selected.event_id,
	       selected.revision,
	       selected.format,
	       selected.content_sha256,
	       selected.event_data_checked_at,
	       selected.published_at,
	       obligation.state AS obligation_state,
	       active.revision AS active_revision
	FROM (SELECT 1 AS present) present
	LEFT JOIN obligation ON true
	LEFT JOIN LATERAL (
		SELECT *
		FROM coherent_heads
		WHERE $4::bigint IS NULL OR revision = $4::bigint
		LIMIT 1
	) selected ON true
	LEFT JOIN LATERAL (
		SELECT revision
		FROM coherent_heads
		LIMIT 1
	) active ON true
`;

export const MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL = `
	WITH tournament_scope AS (
		SELECT tournament.season_id,
		       tournament.tournament_id,
		       tournament.knockout_mode::text AS knockout_mode,
		       tournament.knockout_started_event_id,
		       tournament.knockout_ended_event_id,
		       tournament.group_mode::text AS group_mode,
		       tournament.group_started_event_id,
		       tournament.group_ended_event_id
		FROM competition.tournaments tournament
		WHERE tournament.season_id = $1
		  AND tournament.tournament_id = $2
		  AND tournament.setup_status = 'ready'
	), finalized_events AS (
		SELECT event.event_id
		FROM tournament_scope tournament
		JOIN fpl.events event
		  ON event.season_id = tournament.season_id
		WHERE event.event_id <= $3::integer
		  AND event.finished = true
		  AND event.data_checked = true
		  AND event.data_checked_at IS NOT NULL
		  AND (
			(
				tournament.knockout_mode <> 'no_knockout'
				AND tournament.knockout_started_event_id IS NOT NULL
				AND event.event_id >= tournament.knockout_started_event_id
				AND (tournament.knockout_ended_event_id IS NULL OR event.event_id <= tournament.knockout_ended_event_id)
			)
			OR (
				tournament.group_mode IN ('points_races', 'battle_races')
				AND tournament.group_started_event_id IS NOT NULL
				AND event.event_id >= tournament.group_started_event_id
				AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)
			)
		  )
	), finalized_window AS (
		SELECT COALESCE(array_agg(event_id ORDER BY event_id), ARRAY[]::integer[]) AS finalized_event_ids
		FROM finalized_events
	), obligations AS (
		SELECT obligation.event_id,
		       obligation.format AS obligation_format,
		       obligation.state AS obligation_state
		FROM tournament_scope tournament
		JOIN competition.tournament_review_obligations obligation
		  ON obligation.season_id = tournament.season_id
		 AND obligation.tournament_id = tournament.tournament_id
		WHERE obligation.event_id <= $3::integer
	), keys AS (
		SELECT event_id FROM finalized_events
		UNION
		SELECT event_id FROM obligations
	), coherent_heads AS (
		SELECT head.event_id,
		       head.revision,
		       publication.format,
		       head.content_sha256,
		       publication.correction_change_id,
		       publication.event_data_checked_at,
		       publication.published_at,
		       publication.row_count,
		       publication.ready_subject_count
		FROM tournament_scope tournament
		JOIN competition.tournament_review_heads head
		  ON head.season_id = tournament.season_id
		 AND head.tournament_id = tournament.tournament_id
		JOIN finalized_events finalized
		  ON finalized.event_id = head.event_id
		JOIN competition.tournament_review_publications publication
		  ON publication.season_id = head.season_id
		 AND publication.tournament_id = head.tournament_id
		 AND publication.event_id = head.event_id
		 AND publication.revision = head.revision
		 AND publication.content_sha256 = head.content_sha256
		JOIN competition.tournament_review_obligations obligation
		  ON obligation.season_id = head.season_id
		 AND obligation.tournament_id = head.tournament_id
		 AND obligation.event_id = head.event_id
		 AND obligation.format = publication.format
		 AND obligation.state = 'READY'
		 AND obligation.ready_revision = publication.revision
		JOIN fpl.events event
		  ON event.season_id = publication.season_id
		 AND event.event_id = publication.event_id
		WHERE event.finished = true
		  AND event.data_checked = true
		  AND event.data_checked_at IS NOT NULL
		  AND date_trunc('milliseconds', publication.event_data_checked_at) =
		      date_trunc('milliseconds', event.data_checked_at)
		  AND jsonb_typeof(publication.payload->'manifest') = 'object'
		  AND EXISTS (
			SELECT 1
			FROM competition.tournament_review_publication_chunks chunk
			WHERE chunk.season_id = publication.season_id
			  AND chunk.tournament_id = publication.tournament_id
			  AND chunk.event_id = publication.event_id
			  AND chunk.revision = publication.revision
		  )
	)
	SELECT keys.event_id,
	       coherent_heads.revision,
	       coherent_heads.format,
	       coherent_heads.content_sha256,
	       coherent_heads.correction_change_id,
	       coherent_heads.event_data_checked_at,
	       coherent_heads.published_at,
	       coherent_heads.row_count,
	       coherent_heads.ready_subject_count,
	       obligations.obligation_format,
	       obligations.obligation_state,
	       finalized_window.finalized_event_ids
	FROM keys
	LEFT JOIN coherent_heads
	  ON coherent_heads.event_id = keys.event_id
	LEFT JOIN obligations
	  ON obligations.event_id = keys.event_id
	CROSS JOIN finalized_window
	ORDER BY keys.event_id DESC
`;

export const MY_TOURNAMENT_REVIEW_STATUS_SQL = `
	WITH latest_finalized AS (
		SELECT max(event.event_id)::integer AS latest_finalized_event_id
		FROM competition.tournaments tournament
		JOIN fpl.events event
		  ON event.season_id = tournament.season_id
		WHERE tournament.season_id = $1
		  AND tournament.tournament_id = $2
		  AND tournament.setup_status = 'ready'
		  AND event.finished = true
		  AND event.data_checked = true
		  AND event.data_checked_at IS NOT NULL
		  AND (
			(
				tournament.knockout_mode::text <> 'no_knockout'
				AND tournament.knockout_started_event_id IS NOT NULL
				AND event.event_id >= tournament.knockout_started_event_id
				AND (tournament.knockout_ended_event_id IS NULL OR event.event_id <= tournament.knockout_ended_event_id)
			)
			OR (
				tournament.group_mode::text IN ('points_races', 'battle_races')
				AND tournament.group_started_event_id IS NOT NULL
				AND event.event_id >= tournament.group_started_event_id
				AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)
			)
		  )
	), status_rows AS (
		SELECT obligation.event_id,
		       obligation.format,
		       obligation.state,
		       obligation.next_attempt_at,
		       obligation.execution_attempts,
		       obligation.source_rechecks,
		       obligation.degraded_at,
		       head.revision,
		       head.published_at
		FROM competition.tournament_review_obligations obligation
		LEFT JOIN LATERAL (
			SELECT review_head.revision,
			       publication.published_at
			FROM competition.tournament_review_heads review_head
			JOIN competition.tournament_review_publications publication
			  ON publication.season_id = review_head.season_id
			 AND publication.tournament_id = review_head.tournament_id
			 AND publication.event_id = review_head.event_id
			 AND publication.revision = review_head.revision
			 AND publication.content_sha256 = review_head.content_sha256
			JOIN fpl.events event
			  ON event.season_id = publication.season_id
			 AND event.event_id = publication.event_id
			 AND event.finished = true
			 AND event.data_checked = true
			 AND event.data_checked_at IS NOT NULL
					 AND date_trunc('milliseconds', publication.event_data_checked_at) =
					     date_trunc('milliseconds', event.data_checked_at)
					 AND jsonb_typeof(publication.payload->'manifest') = 'object'
				WHERE review_head.season_id = obligation.season_id
			  AND review_head.tournament_id = obligation.tournament_id
			  AND review_head.event_id = obligation.event_id
			  AND publication.format = obligation.format
			  AND obligation.state = 'READY'
			  AND obligation.ready_revision = review_head.revision
			LIMIT 1
		) head ON true
		WHERE obligation.season_id = $1
		  AND obligation.tournament_id = $2
	)
	SELECT status_rows.event_id,
	       status_rows.format,
	       status_rows.state,
	       status_rows.next_attempt_at,
	       status_rows.execution_attempts,
	       status_rows.source_rechecks,
	       status_rows.degraded_at,
	       status_rows.revision,
	       status_rows.published_at,
	       latest_finalized.latest_finalized_event_id
	FROM latest_finalized
	LEFT JOIN status_rows ON true
	WHERE status_rows.event_id IS NOT NULL
	   OR latest_finalized.latest_finalized_event_id IS NOT NULL
	ORDER BY status_rows.event_id NULLS FIRST
`;

export const MY_TOURNAMENT_REVIEW_FINALIZED_EVENT_SQL = `
	SELECT max(event.event_id)::integer AS latest_finalized_event_id
	FROM competition.tournaments tournament
	JOIN fpl.events event
	  ON event.season_id = tournament.season_id
	WHERE tournament.season_id = $1
	  AND tournament.tournament_id = $2
	  AND tournament.setup_status = 'ready'
	  AND event.finished = true
	  AND event.data_checked = true
	  AND event.data_checked_at IS NOT NULL
	  AND (
		(
			tournament.knockout_mode::text <> 'no_knockout'
			AND tournament.knockout_started_event_id IS NOT NULL
			AND event.event_id >= tournament.knockout_started_event_id
			AND (tournament.knockout_ended_event_id IS NULL OR event.event_id <= tournament.knockout_ended_event_id)
		)
		OR (
			tournament.group_mode::text IN ('points_races', 'battle_races')
			AND tournament.group_started_event_id IS NOT NULL
			AND event.event_id >= tournament.group_started_event_id
			AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)
		)
	  )
`;

/** Exact SQL/result-shape probes consumed by the Data-main compatibility
 * check. These use the same statements as the production reader and are
 * intentionally EXPLAIN-only for the disposable contract fixture. */
export const MY_TOURNAMENT_REVIEW_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "my-tournament-review-v2.1.catalog",
		sql: MY_TOURNAMENT_REVIEW_CATALOG_SQL,
		values: [2026, "ALL", GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, null, null, 101],
		resultTypes: [
			{ relation: "competition.tournaments", column: "tournament_id", pgType: "integer" },
			{ relation: "competition.tournaments", column: "league_id", pgType: "integer" },
			{ relation: "competition.tournaments", column: "total_team_num", pgType: "integer" },
			{ relation: "fpl.events", column: "event_id", pgType: "integer" },
			{ relation: "competition.tournament_review_heads", column: "revision", pgType: "bigint" },
			{
				relation: "competition.tournament_review_publications",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
		],
	},
	{
		name: "my-tournament-review-v2.1.publication",
		sql: MY_TOURNAMENT_REVIEW_PUBLICATION_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 1, 1, "0".repeat(64)],
		resultTypes: [
			{
				relation: "competition.tournament_review_publications",
				column: "season_id",
				pgType: "smallint",
			},
			{
				relation: "competition.tournament_review_publications",
				column: "event_id",
				pgType: "integer",
			},
			{
				relation: "competition.tournament_review_publications",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "competition.tournament_review_publications",
				column: "event_data_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "competition.tournament_review_publications",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-tournament-review-v2.1.section-chunks",
		sql: MY_TOURNAMENT_REVIEW_SECTION_CHUNKS_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 1, 1],
		resultTypes: [
			{
				relation: "competition.tournament_review_publication_chunks",
				column: "section_key",
				pgType: "text",
			},
			{
				relation: "competition.tournament_review_publication_chunks",
				column: "items",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-tournament-review-v2.1.gameweek-head",
		sql: MY_TOURNAMENT_REVIEW_HEAD_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 4, null],
		resultTypes: [
			{
				relation: "competition.tournament_review_heads",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "competition.tournament_review_obligations",
				column: "state",
				pgType: "text",
			},
			{ relation: "fpl.events", column: "event_id", pgType: "integer" },
		],
	},
	{
		name: "my-tournament-review-v2.1.season",
		sql: MY_TOURNAMENT_REVIEW_SEASON_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 38, 38, 7, "0".repeat(64)],
		resultTypes: [
			{
				relation: "competition.tournament_review_publications",
				column: "event_id",
				pgType: "integer",
			},
			{
				relation: "competition.tournament_review_publications",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "competition.tournament_review_publications",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
		],
	},
	{
		name: "my-tournament-review-v2.1.season-head",
		sql: MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 38],
		resultTypes: [
			{
				relation: "competition.tournament_review_heads",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "competition.tournament_review_obligations",
				column: "state",
				pgType: "text",
			},
			{ relation: "fpl.events", column: "event_id", pgType: "integer" },
			{
				relation: "competition.tournament_review_publications",
				column: "row_count",
				pgType: "integer",
			},
			{
				relation: "competition.tournament_review_publications",
				column: "ready_subject_count",
				pgType: "integer",
			},
		],
	},
	{
		name: "my-tournament-review-v2.1.status",
		sql: MY_TOURNAMENT_REVIEW_STATUS_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID],
		resultTypes: [
			{
				relation: "competition.tournament_review_obligations",
				column: "event_id",
				pgType: "integer",
			},
			{
				relation: "competition.tournament_review_obligations",
				column: "execution_attempts",
				pgType: "integer",
			},
			{ relation: "competition.tournament_review_heads", column: "revision", pgType: "bigint" },
		],
	},
	{
		name: "my-tournament-review-v2.1.latest-finalized-event",
		sql: MY_TOURNAMENT_REVIEW_FINALIZED_EVENT_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID],
		resultTypes: [{ relation: "fpl.events", column: "event_id", pgType: "integer" }],
	},
];

const REVIEW_CACHE_TTL_SECONDS = 5 * 60;
const MAX_FPL_EVENT_ID = 38;
// GraphQL's built-in Int scalar is a signed 32-bit integer. PostgreSQL and
// JSON numbers can be wider, so values mapped to Int fields are bounded here.
const GRAPHQL_INT_MIN = -2147483648;
const GRAPHQL_INT_MAX = 2147483647;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function positiveInt(value: unknown): number | null {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function strictPositiveInt(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function reviewFormat(value: unknown): MyTournamentReviewFormat | null {
	return value === "POINTS" || value === "H2H" || value === "KNOCKOUT" ? value : null;
}

function reviewState(value: unknown): MyTournamentReviewState {
	if (
		value === "NOT_STARTED" ||
		value === "PENDING" ||
		value === "WAITING_SOURCE" ||
		value === "READY" ||
		value === "DEGRADED"
	) {
		return value;
	}
	return value === "PROCESSING" ? "PENDING" : "UNAVAILABLE";
}

function requiredNumber(value: unknown, label: string): number {
	if (value === null || value === undefined || value === "") {
		throw integrityError(`Review points aggregate ${label} is missing`);
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw integrityError(`Review points aggregate ${label} is invalid`);
	}
	return value;
}

function requiredInteger(value: unknown, label: string): number {
	const number = requiredNumber(value, label);
	if (!safeInteger(number)) {
		throw integrityError(`Review points aggregate ${label} is not an integer`);
	}
	return number;
}

function roundedAverage(total: number, count: number): number {
	return count === 0 ? 0 : Math.round((total / count) * 100) / 100;
}

function seasonTransferCost(row: MyTournamentReviewPointsRow): number | null {
	if (row.seasonGrossPoints === null || row.seasonNetPoints === null) return null;
	const transferCost = row.seasonGrossPoints - row.seasonNetPoints;
	if (!safeInteger(transferCost) || transferCost < 0) {
		throw integrityError("Review Season transfer cost is inconsistent with cumulative points");
	}
	return transferCost;
}

function pointsRowMetricsValid(
	row: Pick<MyTournamentReviewPointsRow, "grossPoints" | "transferCost" | "netPoints">
): boolean {
	return (
		row.grossPoints !== null &&
		row.transferCost !== null &&
		row.netPoints !== null &&
		row.transferCost >= 0 &&
		row.netPoints === row.grossPoints - row.transferCost
	);
}

function seasonPointsMetricsValid(
	row: Pick<MyTournamentReviewPointsRow, "seasonGrossPoints" | "seasonNetPoints">
): boolean {
	return (
		row.seasonGrossPoints !== null &&
		row.seasonNetPoints !== null &&
		row.seasonGrossPoints - row.seasonNetPoints >= 0 &&
		safeInteger(row.seasonGrossPoints - row.seasonNetPoints)
	);
}

function h2hMatchPointsValid(
	home: Pick<MyTournamentReviewH2HSide, "netPoints" | "matchPoints">,
	away: Pick<MyTournamentReviewH2HSide, "netPoints" | "matchPoints">
): boolean {
	if (
		home.netPoints === null ||
		home.matchPoints === null ||
		away.netPoints === null ||
		away.matchPoints === null
	) {
		return false;
	}
	const expectedHome =
		home.netPoints > away.netPoints ? 3 : home.netPoints < away.netPoints ? 0 : 1;
	const expectedAway =
		away.netPoints > home.netPoints ? 3 : away.netPoints < home.netPoints ? 0 : 1;
	return home.matchPoints === expectedHome && away.matchPoints === expectedAway;
}

function h2hScoreBreakdownValid(
	side: Pick<MyTournamentReviewH2HSide, "isAverage" | "grossPoints" | "transferCost" | "netPoints">
): boolean {
	if (side.isAverage) {
		return side.grossPoints === null && side.transferCost === null;
	}
	// H2H source rows historically expose net points without the optional
	// Gross/cost breakdown. Preserve that valid shape, but never accept a
	// partial breakdown once either component is supplied.
	if (side.grossPoints === null && side.transferCost === null) return true;
	if (side.grossPoints === null || side.transferCost === null || side.netPoints === null) {
		return false;
	}
	return side.transferCost >= 0 && side.netPoints === side.grossPoints - side.transferCost;
}

function nullableNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredSafeInteger(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	return safeInteger(value) ? value : null;
}

function boundedFirst(value: number | null | undefined, defaultValue = 50): number {
	if (value === null || value === undefined) return defaultValue;
	if (!Number.isInteger(value) || value < 1 || value > 100) {
		throw new GraphQLError("first must be between 1 and 100", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return value;
}

function validateReviewEventId(eventId: number, label: "eventId" | "throughEventId"): void {
	if (!Number.isSafeInteger(eventId) || eventId < 1 || eventId > MAX_FPL_EVENT_ID) {
		throw new GraphQLError(`${label} must be an integer between 1 and ${MAX_FPL_EVENT_ID}`, {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
}

function decodeCursor(
	value: string | null | undefined,
	expectedRevision: string,
	expectedScope: string
): ReviewCursor | null {
	if (!value) return null;
	try {
		const decoded = Buffer.from(value, "base64url").toString("utf8");
		const parsed: unknown = JSON.parse(decoded);
		if (
			isRecord(parsed) &&
			parsed.revision === expectedRevision &&
			parsed.scope === expectedScope
		) {
			const rawOffset = parsed.offset;
			const offset =
				typeof rawOffset === "number"
					? rawOffset
					: typeof rawOffset === "string" && rawOffset.trim() !== ""
						? Number(rawOffset)
						: NaN;
			if (Number.isSafeInteger(offset) && offset >= 0) {
				return {
					offset,
					canonical: encodeCursor(offset, expectedRevision, expectedScope),
				};
			}
		}
	} catch {
		// Fall through to a stable client error.
	}
	throw new GraphQLError("Review cursor does not match this publication revision", {
		extensions: { code: "BAD_USER_INPUT" },
	});
}

function encodeCursor(offset: number, revision: string, scope: string): string {
	return Buffer.from(JSON.stringify({ offset, revision, scope }), "utf8").toString("base64url");
}

function reviewCursorScope(
	row: Pick<PublicationRow, "season_id" | "tournament_id" | "event_id" | "format">,
	collection: string
): string {
	return JSON.stringify([row.season_id, row.tournament_id, row.event_id, row.format, collection]);
}

type ReviewCursor = {
	offset: number;
	canonical: string;
};

function reviewCursorCollection(
	format: MyTournamentReviewFormat,
	view: "GAMEWEEK" | "SEASON"
): string {
	if (format === "POINTS") return view === "SEASON" ? "SEASON_POINTS" : "GAMEWEEK_POINTS";
	return format === "H2H" ? "H2H" : "KNOCKOUT";
}

function decodePublicationCursor(
	row: Pick<PublicationRow, "season_id" | "tournament_id" | "event_id" | "format" | "revision">,
	after: string | null | undefined,
	view: "GAMEWEEK" | "SEASON",
	collectionOverride?: string
): ReviewCursor | null {
	const format = reviewFormat(row.format);
	if (!format) throw integrityError("Review publication format is invalid");
	return decodeCursor(
		after,
		String(row.revision),
		reviewCursorScope(row, collectionOverride ?? reviewCursorCollection(format, view))
	);
}

function reviewSectionCursorScope(
	row: Pick<PublicationRow, "season_id" | "tournament_id" | "event_id" | "format" | "revision">,
	phaseId: string,
	section: MyTournamentReviewSeasonSection,
	semanticSha256: string
): string {
	return reviewCursorScope(
		row,
		JSON.stringify(["SEASON_SECTION", phaseId, section, String(row.revision), semanticSha256])
	);
}

function serializePostgresJsonb(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(serializePostgresJsonb).join(", ")}]`;
	}
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.sort(
				(left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
			)
			.map((key) => `${JSON.stringify(key)}: ${serializePostgresJsonb(record[key])}`);
		return `{${entries.join(", ")}}`;
	}
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
	return serialized;
}

export function postgresJsonbContentHash(value: unknown): string {
	return createHash("sha256").update(serializePostgresJsonb(value), "utf8").digest("hex");
}

function stripReviewOperationalMetadata(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripReviewOperationalMetadata);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const stripped: Record<string, unknown> = {};
		for (const key of Object.keys(record)) {
			if (
				key === "freshness" ||
				key === "observation" ||
				key === "observedAt" ||
				key === "lastObservedAt" ||
				key === "publishedAt" ||
				key === "updatedAt" ||
				key === "createdAt"
			) {
				continue;
			}
			stripped[key] = stripReviewOperationalMetadata(record[key]);
		}
		return stripped;
	}
	return value;
}

/** The Data publication keeps only the aggregate/header shell in `payload`;
 * immutable rows live in bounded chunk siblings.  Hash both the manifest-only
 * form and a reader-materialized form identically so the semantic identity is
 * independent of whether a cache miss has reconstructed the rows yet. */
function stripReviewSectionArrays(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const output: Record<string, unknown> = { ...value };
	if (value.format === "POINTS" && isRecord(value.points)) {
		const { rows: _rows, ...points } = value.points;
		output.points = points;
	} else if (value.format === "H2H" && isRecord(value.h2h)) {
		const { matches: _matches, standings: _standings, ...h2h } = value.h2h;
		output.h2h = h2h;
	} else if (value.format === "KNOCKOUT" && isRecord(value.knockout)) {
		const { matches: _matches, ...knockout } = value.knockout;
		output.knockout = knockout;
	}
	return output;
}

export function tournamentReviewSemanticSha256(
	value: unknown,
	orderedChunkHashes: readonly string[] = []
): string {
	return createHash("sha256")
		.update(
			`${serializePostgresJsonb(
				stripReviewSectionArrays(stripReviewOperationalMetadata(value))
			)}\n${orderedChunkHashes.join("\n")}`,
			"utf8"
		)
		.digest("hex");
}

export function tournamentReviewChunkHashes(value: unknown): string[] {
	if (!isRecord(value)) return [];
	const sections: Array<[string, unknown]> = [];
	if (value.format === "POINTS" && isRecord(value.points)) {
		sections.push(["POINTS_STANDINGS", value.points.rows]);
		sections.push(["POINTS_TRAJECTORIES", value.points.rows]);
	} else if (value.format === "H2H" && isRecord(value.h2h)) {
		sections.push(["H2H_FIXTURES", value.h2h.matches]);
		sections.push(["H2H_STANDINGS", value.h2h.standings]);
	} else if (value.format === "KNOCKOUT" && isRecord(value.knockout)) {
		sections.push(["KNOCKOUT_BRACKET", value.knockout.matches]);
	}
	const hashes: string[] = [];
	const ordered = sections.sort(([left], [right]) => left.localeCompare(right));
	for (const [, raw] of ordered) {
		if (!Array.isArray(raw)) continue;
		// Data writes one explicit zero-item chunk for an empty section so that
		// the manifest/count/hash contract remains closed even when a format has
		// no rows yet. Keep the client-side semantic hash in lockstep with that
		// persisted representation.
		if (raw.length === 0) {
			hashes.push(postgresJsonbContentHash([]));
			continue;
		}
		for (let offset = 0; offset < raw.length; offset += 100) {
			hashes.push(postgresJsonbContentHash(raw.slice(offset, offset + 100)));
		}
	}
	return hashes;
}

function publicationSemanticSha256(value: unknown): string {
	const hashes = tournamentReviewChunkHashes(value);
	return tournamentReviewSemanticSha256(value, hashes);
}

export function tournamentReviewPublicationHash(value: unknown): string {
	return publicationSemanticSha256(value);
}

/**
 * Validate and materialize every section from the immutable chunk siblings.
 * This keeps the PostgreSQL publication row as metadata/identity while the
 * bounded chunks are the only representation used by V2.1 section paging.
 */
function materializeReviewChunks(
	payload: unknown,
	rows: readonly PublicationChunkRow[]
): Record<string, unknown> {
	if (!isRecord(payload) || !isRecord(payload.manifest)) {
		throw integrityError("Review publication chunk manifest is missing");
	}
	const manifest = payload.manifest;
	const sectionValues = manifest.sections;
	const expectedChunkCount = safeInteger(manifest.chunkCount)
		? manifest.chunkCount
		: Number(manifest.chunkCount);
	if (
		!Array.isArray(sectionValues) ||
		!Number.isSafeInteger(expectedChunkCount) ||
		expectedChunkCount < 0 ||
		expectedChunkCount !== rows.length
	) {
		throw integrityError("Review publication chunk manifest is invalid");
	}
	const expectedSections = new Map<string, { itemCount: number; chunkHashes: string[] }>();
	for (const value of sectionValues) {
		if (!isRecord(value) || typeof value.sectionKey !== "string") {
			throw integrityError("Review publication section descriptor is invalid");
		}
		const itemCount = Number(value.itemCount);
		const chunkCount = Number(value.chunkCount);
		const rawChunkHashes: unknown = value.chunkHashes;
		if (
			!Number.isSafeInteger(itemCount) ||
			itemCount < 0 ||
			!Number.isSafeInteger(chunkCount) ||
			chunkCount < 0 ||
			!Array.isArray(rawChunkHashes) ||
			rawChunkHashes.length !== chunkCount ||
			rawChunkHashes.some(
				(hash: unknown) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)
			) ||
			expectedSections.has(value.sectionKey)
		) {
			throw integrityError("Review publication section descriptor is invalid");
		}
		const chunkHashes: string[] = rawChunkHashes.map((hash: unknown) => String(hash));
		expectedSections.set(value.sectionKey, { itemCount, chunkHashes });
	}
	if (expectedSections.size !== Number(manifest.sectionCount)) {
		throw integrityError("Review publication section count is invalid");
	}
	const materialized = { ...payload };
	for (const [sectionKey, descriptor] of expectedSections) {
		const sectionRows = rows.filter((row) => row.section_key === sectionKey);
		if (sectionRows.length !== descriptor.chunkHashes.length) {
			throw integrityError("Review publication section chunk count is invalid");
		}
		const items: unknown[] = [];
		for (const [index, row] of sectionRows.entries()) {
			const chunkIndex = Number(row.chunk_index);
			const itemCount = Number(row.item_count);
			if (
				chunkIndex !== index ||
				!Array.isArray(row.items) ||
				itemCount !== row.items.length ||
				itemCount < 0 ||
				itemCount > 100 ||
				row.chunk_sha256 !== descriptor.chunkHashes[index] ||
				postgresJsonbContentHash(row.items) !== row.chunk_sha256
			) {
				throw integrityError("Review publication chunk hash or index is invalid");
			}
			items.push(...row.items);
		}
		if (items.length !== descriptor.itemCount) {
			throw integrityError("Review publication section item count is invalid");
		}
		if (sectionKey.startsWith("POINTS_")) {
			const points = isRecord(materialized.points) ? materialized.points : null;
			if (!points) throw integrityError("Review points section payload is missing");
			materialized.points = { ...points, rows: items };
		} else if (sectionKey === "H2H_FIXTURES" || sectionKey === "H2H_STANDINGS") {
			const h2h = isRecord(materialized.h2h) ? materialized.h2h : null;
			if (!h2h) throw integrityError("Review H2H section payload is missing");
			materialized.h2h = {
				...h2h,
				[sectionKey === "H2H_FIXTURES" ? "matches" : "standings"]: items,
			};
		} else if (sectionKey === "KNOCKOUT_BRACKET") {
			const knockout = isRecord(materialized.knockout) ? materialized.knockout : null;
			if (!knockout) throw integrityError("Review knockout section payload is missing");
			materialized.knockout = { ...knockout, matches: items };
		} else {
			throw integrityError("Review publication section key is invalid");
		}
	}
	return materialized;
}

async function materializePublicationRow(
	database: GraphQLContext["database"],
	row: PublicationRow
): Promise<PublicationRow> {
	// Production SQL requires a V2.1 manifest before this function is reached.
	// Unit fixtures run outside production NODE_ENV and may intentionally
	// exercise the legacy full-payload validators; keep that compatibility only
	// there. A production row without a manifest fails closed.
	if (!isRecord(row.payload) || !isRecord(row.payload.manifest)) {
		if (!env.isProduction) return row;
		throw integrityError("Review publication chunk manifest is missing");
	}
	const chunkResult = await database.query<PublicationChunkRow>(
		MY_TOURNAMENT_REVIEW_SECTION_CHUNKS_SQL,
		[row.season_id, row.tournament_id, row.event_id, row.revision]
	);
	return {
		...row,
		payload: materializeReviewChunks(row.payload, chunkResult.rows),
	};
}

function nullableSafeInteger(value: unknown): boolean {
	return value === null || safeInteger(value);
}

function safeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= GRAPHQL_INT_MIN &&
		value <= GRAPHQL_INT_MAX
	);
}

function nullableNonNegativeSafeInteger(value: unknown): boolean {
	return value === null || (safeInteger(value) && value >= 0);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isKnownReviewState(value: unknown): value is MyTournamentReviewState {
	return (
		value === "NOT_STARTED" ||
		value === "PENDING" ||
		value === "WAITING_SOURCE" ||
		value === "READY" ||
		value === "DEGRADED" ||
		value === "UNAVAILABLE"
	);
}

function freshnessCache(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const eventDataCheckedAt = Date.parse(String(value.eventDataCheckedAt));
	const sourceMinCheckedAt = Date.parse(String(value.sourceMinCheckedAt));
	const sourceMaxCheckedAt = Date.parse(String(value.sourceMaxCheckedAt));
	const publishedAt = Date.parse(String(value.publishedAt));
	return (
		nonEmptyString(value.eventDataCheckedAt) &&
		nonEmptyString(value.sourceMinCheckedAt) &&
		nonEmptyString(value.sourceMaxCheckedAt) &&
		nonEmptyString(value.publishedAt) &&
		typeof value.ageSeconds === "number" &&
		Number.isSafeInteger(value.ageSeconds) &&
		value.ageSeconds >= 0 &&
		Number.isFinite(eventDataCheckedAt) &&
		Number.isFinite(sourceMinCheckedAt) &&
		Number.isFinite(sourceMaxCheckedAt) &&
		Number.isFinite(publishedAt) &&
		eventDataCheckedAt <= sourceMinCheckedAt &&
		sourceMinCheckedAt <= sourceMaxCheckedAt &&
		sourceMaxCheckedAt <= publishedAt
	);
}

function scopeMetaCache(value: unknown): value is MyTournamentReviewScopeMeta {
	if (!isRecord(value)) return false;
	return (
		positiveInt(value.tournamentId) !== null &&
		positiveInt(value.eventId) !== null &&
		/^\d+$/.test(String(value.revision)) &&
		Number(value.revision) > 0 &&
		reviewFormat(value.format) !== null &&
		value.state === "READY" &&
		freshnessCache(value.freshness) &&
		typeof value.rowCount === "number" &&
		Number.isSafeInteger(value.rowCount) &&
		value.rowCount > 0 &&
		typeof value.expectedSubjectCount === "number" &&
		Number.isSafeInteger(value.expectedSubjectCount) &&
		value.expectedSubjectCount > 0 &&
		typeof value.readySubjectCount === "number" &&
		Number.isSafeInteger(value.readySubjectCount) &&
		value.readySubjectCount >= 0 &&
		typeof value.notApplicableSubjectCount === "number" &&
		Number.isSafeInteger(value.notApplicableSubjectCount) &&
		value.notApplicableSubjectCount >= 0 &&
		value.readySubjectCount + value.notApplicableSubjectCount === value.expectedSubjectCount &&
		(value.contentSha256 === null || /^[0-9a-f]{64}$/.test(String(value.contentSha256)))
	);
}

function pointsRowCache(value: unknown): value is MyTournamentReviewPointsRow {
	if (!isRecord(value)) return false;
	const numeric = [
		value.groupId,
		value.rank,
		value.previousRank,
		value.grossPoints,
		value.transferCost,
		value.netPoints,
		value.tournamentScore,
		value.seasonGrossPoints,
		value.seasonNetPoints,
		value.eventRank,
		value.overallPoints,
		value.overallRank,
	];
	if (
		positiveInt(value.entryId) === null ||
		!nonEmptyString(value.entryName) ||
		!nonEmptyString(value.playerName) ||
		typeof value.applicable !== "boolean" ||
		numeric.some((candidate) => !nullableSafeInteger(candidate))
	) {
		return false;
	}
	const tournamentMetrics = [
		value.groupId,
		value.rank,
		value.previousRank,
		value.grossPoints,
		value.transferCost,
		value.netPoints,
		value.tournamentScore,
		value.seasonGrossPoints,
		value.seasonNetPoints,
		value.eventRank,
	];
	const optionalRanks = [value.previousRank, value.eventRank, value.overallRank];
	if (
		optionalRanks.some((candidate) => candidate !== null && strictPositiveInt(candidate) === null)
	) {
		return false;
	}
	if (!value.applicable) return tournamentMetrics.every((candidate) => candidate === null);
	return (
		strictPositiveInt(value.groupId) !== null &&
		strictPositiveInt(value.rank) !== null &&
		value.tournamentScore !== null &&
		pointsRowMetricsValid({
			grossPoints: nullableNumber(value.grossPoints),
			transferCost: nullableNumber(value.transferCost),
			netPoints: nullableNumber(value.netPoints),
		}) &&
		seasonPointsMetricsValid({
			seasonGrossPoints: nullableNumber(value.seasonGrossPoints),
			seasonNetPoints: nullableNumber(value.seasonNetPoints),
		})
	);
}

function pointsCache(
	value: unknown,
	expectedView: MyTournamentReviewPointsAggregateWitness["view"],
	expectedScope?: Pick<MyTournamentReviewScopeMeta, "rowCount" | "readySubjectCount">
): value is MyTournamentReviewPoints {
	if (!isRecord(value)) return false;
	if (!Array.isArray(value.rows)) return false;
	const witness = value.aggregateWitness;
	if (!isRecord(witness)) return false;
	if (witness.view !== "GAMEWEEK" && witness.view !== "SEASON") return false;
	const witnessIntegers = [
		witness.rowCount,
		witness.applicableRowCount,
		witness.pageOffset,
		witness.pageLength,
		witness.grossPointsTotal,
		witness.netPointsTotal,
		witness.seasonGrossPointsTotal,
		witness.seasonNetPointsTotal,
		witness.selectedGrossPointsTotal,
		witness.selectedNetPointsTotal,
	];
	const witnessAverages = [
		witness.grossPointsAverage,
		witness.seasonGrossPointsAverage,
		witness.selectedGrossPointsAverage,
	];
	if (
		witnessIntegers.some((candidate) => !safeInteger(candidate)) ||
		witnessAverages.some(
			(candidate) => typeof candidate !== "number" || !Number.isFinite(candidate)
		)
	) {
		return false;
	}
	const typedWitness = witness as unknown as MyTournamentReviewPointsAggregateWitness;
	if (
		typedWitness.view !== expectedView ||
		(expectedScope !== undefined &&
			(typedWitness.rowCount !== expectedScope.rowCount ||
				typedWitness.applicableRowCount !== expectedScope.readySubjectCount))
	) {
		return false;
	}
	if (
		typedWitness.rowCount <= 0 ||
		typedWitness.applicableRowCount < 0 ||
		typedWitness.applicableRowCount > typedWitness.rowCount ||
		typedWitness.pageOffset < 0 ||
		typedWitness.pageLength <= 0 ||
		typedWitness.pageLength !== value.rows.length ||
		typedWitness.pageOffset + typedWitness.pageLength > typedWitness.rowCount ||
		value.hasNextPage !== typedWitness.pageOffset + typedWitness.pageLength < typedWitness.rowCount
	) {
		return false;
	}
	if (
		!Array.isArray(typedWitness.rows) ||
		typedWitness.rows.length !== typedWitness.rowCount ||
		!typedWitness.rows.every((row) => {
			if (!isRecord(row)) return false;
			const metrics = [
				row.grossPoints,
				row.transferCost,
				row.netPoints,
				row.seasonGrossPoints,
				row.seasonNetPoints,
			];
			const sourceMetrics = [row.sourceGrossPoints, row.sourceTransferCost, row.sourceNetPoints];
			if (
				positiveInt(row.entryId) === null ||
				typeof row.applicable !== "boolean" ||
				metrics.some((candidate) => !nullableSafeInteger(candidate)) ||
				sourceMetrics.some((candidate) => !nullableSafeInteger(candidate))
			) {
				return false;
			}
			if (!row.applicable) {
				return [...metrics, ...sourceMetrics].every((candidate) => candidate === null);
			}
			if (
				!pointsRowMetricsValid({
					grossPoints: row.sourceGrossPoints,
					transferCost: row.sourceTransferCost,
					netPoints: row.sourceNetPoints,
				}) ||
				!pointsRowMetricsValid({
					grossPoints: row.grossPoints,
					transferCost: row.transferCost,
					netPoints: row.netPoints,
				}) ||
				!seasonPointsMetricsValid({
					seasonGrossPoints: row.seasonGrossPoints,
					seasonNetPoints: row.seasonNetPoints,
				})
			) {
				return false;
			}
			if (typedWitness.view === "GAMEWEEK") {
				return (
					row.grossPoints === row.sourceGrossPoints &&
					row.transferCost === row.sourceTransferCost &&
					row.netPoints === row.sourceNetPoints
				);
			}
			const expectedSeasonTransferCost =
				row.seasonGrossPoints !== null && row.seasonNetPoints !== null
					? row.seasonGrossPoints - row.seasonNetPoints
					: null;
			return (
				row.grossPoints === row.seasonGrossPoints &&
				row.transferCost === expectedSeasonTransferCost &&
				row.netPoints === row.seasonNetPoints
			);
		})
	) {
		return false;
	}
	const aggregateRows = typedWitness.rows as unknown as MyTournamentReviewPointsAggregateRow[];
	if (new Set(aggregateRows.map((row) => row.entryId)).size !== aggregateRows.length) {
		return false;
	}
	const applicableRows = aggregateRows.filter((row) => row.applicable);
	if (applicableRows.length !== typedWitness.applicableRowCount) return false;
	if (
		value.rows.some((row, index) => {
			if (!isRecord(row)) return true;
			const aggregateRow = aggregateRows[typedWitness.pageOffset + index];
			return (
				!aggregateRow ||
				row.entryId !== aggregateRow.entryId ||
				row.applicable !== aggregateRow.applicable ||
				row.grossPoints !== aggregateRow.grossPoints ||
				row.transferCost !== aggregateRow.transferCost ||
				row.netPoints !== aggregateRow.netPoints ||
				row.seasonGrossPoints !== aggregateRow.seasonGrossPoints ||
				row.seasonNetPoints !== aggregateRow.seasonNetPoints
			);
		})
	) {
		return false;
	}
	const rawApplicableRows = aggregateRows.filter((row) => row.applicable);
	const rawGrossPointsTotal = rawApplicableRows.reduce(
		(sum, row) => sum + (row.sourceGrossPoints ?? 0),
		0
	);
	const rawNetPointsTotal = rawApplicableRows.reduce(
		(sum, row) => sum + (row.sourceNetPoints ?? 0),
		0
	);
	const grossPointsTotal = applicableRows.reduce((sum, row) => sum + (row.grossPoints ?? 0), 0);
	const netPointsTotal = applicableRows.reduce((sum, row) => sum + (row.netPoints ?? 0), 0);
	const seasonGrossPointsTotal = applicableRows.reduce(
		(sum, row) => sum + (row.seasonGrossPoints ?? 0),
		0
	);
	const seasonNetPointsTotal = applicableRows.reduce(
		(sum, row) => sum + (row.seasonNetPoints ?? 0),
		0
	);
	const rawGrossPointsAverage = roundedAverage(rawGrossPointsTotal, rawApplicableRows.length);
	const rawSeasonGrossPointsTotal = seasonGrossPointsTotal;
	const rawSeasonNetPointsTotal = seasonNetPointsTotal;
	const rawSeasonGrossPointsAverage = roundedAverage(
		rawSeasonGrossPointsTotal,
		rawApplicableRows.length
	);
	if (
		typedWitness.grossPointsTotal !== rawGrossPointsTotal ||
		typedWitness.grossPointsAverage !== rawGrossPointsAverage ||
		typedWitness.netPointsTotal !== rawNetPointsTotal ||
		typedWitness.seasonGrossPointsTotal !== rawSeasonGrossPointsTotal ||
		typedWitness.seasonGrossPointsAverage !== rawSeasonGrossPointsAverage ||
		typedWitness.seasonNetPointsTotal !== rawSeasonNetPointsTotal
	) {
		return false;
	}
	return (
		value.headlineMetric === "gross" &&
		safeInteger(value.grossPointsTotal) &&
		typeof value.grossPointsAverage === "number" &&
		Number.isFinite(value.grossPointsAverage) &&
		safeInteger(value.netPointsTotal) &&
		safeInteger(value.seasonGrossPointsTotal) &&
		typeof value.seasonGrossPointsAverage === "number" &&
		Number.isFinite(value.seasonGrossPointsAverage) &&
		safeInteger(value.seasonNetPointsTotal) &&
		value.rows.length > 0 &&
		value.rows.every(pointsRowCache) &&
		value.grossPointsTotal === grossPointsTotal &&
		value.grossPointsAverage === roundedAverage(grossPointsTotal, applicableRows.length) &&
		value.netPointsTotal === netPointsTotal &&
		value.seasonGrossPointsTotal === seasonGrossPointsTotal &&
		value.seasonGrossPointsAverage ===
			roundedAverage(seasonGrossPointsTotal, applicableRows.length) &&
		value.seasonNetPointsTotal === seasonNetPointsTotal &&
		value.grossPointsTotal === typedWitness.selectedGrossPointsTotal &&
		value.grossPointsAverage === typedWitness.selectedGrossPointsAverage &&
		value.netPointsTotal === typedWitness.selectedNetPointsTotal &&
		value.seasonGrossPointsTotal === typedWitness.seasonGrossPointsTotal &&
		value.seasonGrossPointsAverage === typedWitness.seasonGrossPointsAverage &&
		value.seasonNetPointsTotal === typedWitness.seasonNetPointsTotal &&
		(typedWitness.view === "GAMEWEEK"
			? typedWitness.grossPointsTotal === value.grossPointsTotal &&
				typedWitness.grossPointsAverage === value.grossPointsAverage &&
				typedWitness.netPointsTotal === value.netPointsTotal
			: true) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean"
	);
}

function h2hSideCache(value: unknown): value is MyTournamentReviewH2HSide {
	if (!isRecord(value)) return false;
	return (
		(value.isAverage === true
			? value.entryId === null
			: strictPositiveInt(value.entryId) !== null) &&
		nonEmptyString(value.entryName) &&
		typeof value.isAverage === "boolean" &&
		[value.grossPoints, value.transferCost, value.netPoints, value.rank].every((candidate) =>
			nullableSafeInteger(candidate)
		) &&
		(value.rank === null || strictPositiveInt(value.rank) !== null) &&
		nullableNonNegativeSafeInteger(value.matchPoints) &&
		h2hScoreBreakdownValid({
			isAverage: value.isAverage,
			grossPoints: nullableNumber(value.grossPoints),
			transferCost: nullableNumber(value.transferCost),
			netPoints: nullableNumber(value.netPoints),
		})
	);
}

function h2hCache(value: unknown): value is MyTournamentReviewH2H {
	if (!isRecord(value) || !Array.isArray(value.matches) || !Array.isArray(value.standings)) {
		return false;
	}
	const coverageWitness = value.coverageWitness;
	const isCoverageMatchIdentity = (candidate: unknown): candidate is string => {
		if (typeof candidate !== "string") return false;
		try {
			const parsed: unknown = JSON.parse(candidate);
			return (
				Array.isArray(parsed) &&
				parsed.length === 2 &&
				strictPositiveInt(parsed[0]) !== null &&
				nonEmptyString(parsed[1]) &&
				JSON.stringify(parsed) === candidate
			);
		} catch {
			return false;
		}
	};
	const isCoverageIdentity = (candidate: unknown): candidate is string => {
		if (typeof candidate !== "string") return false;
		const [groupId, entryId, ...rest] = candidate.split(":");
		return (
			rest.length === 0 &&
			strictPositiveInt(Number(groupId)) !== null &&
			strictPositiveInt(Number(entryId)) !== null &&
			candidate === `${Number(groupId)}:${Number(entryId)}`
		);
	};
	if (
		!isRecord(coverageWitness) ||
		!Array.isArray(coverageWitness.matchIdentities) ||
		!Array.isArray(coverageWitness.matchParticipantIdentities) ||
		!Array.isArray(coverageWitness.standingIdentities) ||
		!Array.isArray(coverageWitness.pageMatchParticipantIdentities) ||
		!Array.isArray(coverageWitness.pageStandingIdentities) ||
		!safeInteger(coverageWitness.pageOffset) ||
		coverageWitness.pageOffset < 0 ||
		!coverageWitness.matchIdentities.every(isCoverageMatchIdentity) ||
		!coverageWitness.matchParticipantIdentities.every(isCoverageIdentity) ||
		!coverageWitness.standingIdentities.every(isCoverageIdentity) ||
		!coverageWitness.pageMatchParticipantIdentities.every(isCoverageIdentity) ||
		!coverageWitness.pageStandingIdentities.every(isCoverageIdentity)
	) {
		return false;
	}
	const witnessMatchIdentities = new Set(coverageWitness.matchIdentities);
	const witnessParticipantIdentities = new Set(coverageWitness.matchParticipantIdentities);
	const witnessStandingIdentities = new Set(coverageWitness.standingIdentities);
	if (
		witnessMatchIdentities.size !== coverageWitness.matchIdentities.length ||
		witnessParticipantIdentities.size !== coverageWitness.matchParticipantIdentities.length ||
		witnessStandingIdentities.size !== coverageWitness.standingIdentities.length ||
		witnessMatchIdentities.size === 0 ||
		witnessParticipantIdentities.size !== witnessStandingIdentities.size ||
		[...witnessParticipantIdentities].some(
			(identity) => !witnessStandingIdentities.has(identity)
		) ||
		coverageWitness.pageOffset >
			Math.max(coverageWitness.matchIdentities.length, coverageWitness.standingIdentities.length) ||
		coverageWitness.pageOffset + value.matches.length > coverageWitness.matchIdentities.length ||
		coverageWitness.pageOffset + value.standings.length > coverageWitness.standingIdentities.length
	) {
		return false;
	}
	// A continuation page can legitimately contain standings only when the
	// match collection is shorter than the standings collection.  It is still
	// invalid for both collections to be empty.
	if (value.matches.length === 0 && value.standings.length === 0) return false;
	const matchIdentities = new Set<string>();
	const pageMatchIdentities: string[] = [];
	const matchParticipantIdentities = new Set<string>();
	const pageMatchParticipantIdentities: string[] = [];
	const matchesValid = value.matches.every((match) => {
		if (!isRecord(match)) return false;
		const groupId = strictPositiveInt(match.groupId);
		const identity =
			groupId !== null && typeof match.matchId === "string"
				? JSON.stringify([groupId, match.matchId])
				: null;
		if (identity === null || matchIdentities.has(identity)) return false;
		matchIdentities.add(identity);
		pageMatchIdentities.push(identity);
		const home = match.home;
		const away = match.away;
		const homeIsAverage = isRecord(home) && home.isAverage === true;
		const awayIsAverage = isRecord(away) && away.isAverage === true;
		const homeEntryId = isRecord(home) ? strictPositiveInt(home.entryId) : null;
		const awayEntryId = isRecord(away) ? strictPositiveInt(away.entryId) : null;
		const sidesValid = match.isBye
			? (home === null) !== (away === null) && !(homeIsAverage || awayIsAverage)
			: home !== null &&
				away !== null &&
				!(homeIsAverage && awayIsAverage) &&
				(homeIsAverage || awayIsAverage || homeEntryId !== awayEntryId);
		const scoresValid =
			(match.isBye === true &&
				[home, away].every(
					(side) => side === null || (isRecord(side) && side.matchPoints === null)
				)) ||
			(isRecord(home) &&
				isRecord(away) &&
				h2hSideCache(home) &&
				h2hSideCache(away) &&
				h2hMatchPointsValid(home, away));
		const participantsValid = [home, away].every((side) => {
			if (!isRecord(side) || side.isAverage === true) return true;
			const entryId = strictPositiveInt(side.entryId);
			if (entryId === null) return false;
			const participantIdentity = `${groupId}:${entryId}`;
			if (matchParticipantIdentities.has(participantIdentity)) return false;
			matchParticipantIdentities.add(participantIdentity);
			pageMatchParticipantIdentities.push(participantIdentity);
			return true;
		});
		return (
			nonEmptyString(match.matchId) &&
			groupId !== null &&
			typeof match.isBye === "boolean" &&
			(match.home === null || h2hSideCache(match.home)) &&
			(match.away === null || h2hSideCache(match.away)) &&
			sidesValid &&
			scoresValid &&
			participantsValid
		);
	});
	const standingIds = new Set<number>();
	const standingIdentities = new Set<string>();
	const pageStandingIdentities: string[] = [];
	const standingsValid = value.standings.every((standing) => {
		if (!isRecord(standing)) return false;
		const groupId = strictPositiveInt(standing.groupId);
		const entryId = strictPositiveInt(standing.entryId);
		if (
			groupId === null ||
			entryId === null ||
			standingIds.has(entryId) ||
			!nonEmptyString(standing.entryName)
		) {
			return false;
		}
		standingIds.add(entryId);
		const identity = `${groupId}:${entryId}`;
		standingIdentities.add(identity);
		pageStandingIdentities.push(identity);
		const rank = standing.rank;
		const played = standing.played;
		const won = standing.won;
		const drawn = standing.drawn;
		const lost = standing.lost;
		const matchPoints = standing.matchPoints;
		const pointsFor = standing.pointsFor;
		const pointsAgainst = standing.pointsAgainst;
		return (
			typeof rank === "number" &&
			Number.isSafeInteger(rank) &&
			rank > 0 &&
			typeof played === "number" &&
			typeof won === "number" &&
			typeof drawn === "number" &&
			typeof lost === "number" &&
			typeof matchPoints === "number" &&
			[played, won, drawn, lost, matchPoints].every(
				(candidate) =>
					typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
			) &&
			played === won + drawn + lost &&
			matchPoints === 3 * won + drawn &&
			[pointsFor, pointsAgainst].every((candidate) => safeInteger(candidate))
		);
	});
	const arraysEqual = (left: string[], right: string[]): boolean =>
		left.length === right.length && left.every((value, index) => value === right[index]);
	const participantCoverageValid =
		[...matchParticipantIdentities].every((identity) =>
			witnessParticipantIdentities.has(identity)
		) && [...standingIdentities].every((identity) => witnessStandingIdentities.has(identity));
	const pageCoverageValid =
		arraysEqual(
			pageMatchIdentities,
			coverageWitness.matchIdentities.slice(
				coverageWitness.pageOffset,
				coverageWitness.pageOffset + value.matches.length
			)
		) &&
		arraysEqual(
			pageStandingIdentities,
			coverageWitness.standingIdentities.slice(
				coverageWitness.pageOffset,
				coverageWitness.pageOffset + value.standings.length
			)
		) &&
		arraysEqual(pageMatchParticipantIdentities, coverageWitness.pageMatchParticipantIdentities) &&
		arraysEqual(pageStandingIdentities, coverageWitness.pageStandingIdentities);
	const expectedHasNextPage =
		coverageWitness.pageOffset + Math.max(value.matches.length, value.standings.length) <
		Math.max(coverageWitness.matchIdentities.length, coverageWitness.standingIdentities.length);
	return (
		matchesValid &&
		standingsValid &&
		participantCoverageValid &&
		pageCoverageValid &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean" &&
		value.hasNextPage === expectedHasNextPage &&
		(value.hasNextPage ? value.nextCursor !== null : value.nextCursor === null)
	);
}

function knockoutSideCache(value: unknown): value is MyTournamentReviewKnockoutSide {
	if (!isRecord(value)) return false;
	const scoreMetrics = [value.grossPoints, value.transferCost, value.netPoints];
	const goalMetrics = [value.goalsScored, value.goalsConceded];
	return (
		positiveInt(value.entryId) !== null &&
		nonEmptyString(value.entryName) &&
		(value.applicable === undefined || typeof value.applicable === "boolean") &&
		scoreMetrics.every((candidate) => nullableSafeInteger(candidate)) &&
		goalMetrics.every((candidate) => nullableNonNegativeSafeInteger(candidate)) &&
		(value.applicable !== false ||
			[...scoreMetrics, ...goalMetrics].every((candidate) => candidate === null)) &&
		knockoutScoreBreakdownValid({
			grossPoints: nullableNumber(value.grossPoints),
			transferCost: nullableNumber(value.transferCost),
			netPoints: nullableNumber(value.netPoints),
		})
	);
}

/**
 * A knockout publication contains fixture rows, not one row per roster
 * subject: eliminated entries can disappear from the active bracket.  The
 * distinct non-null side IDs therefore may be smaller than the ready count,
 * but they can never exceed the roster/subject counts.  When Data includes
 * its per-side applicability marker, reconcile both partitions as well.
 */
function knockoutEntryCoverageValid(
	matches: readonly MyTournamentReviewKnockoutMatch[],
	expectedSubjectCount: number,
	readySubjectCount: number,
	notApplicableSubjectCount: number
): boolean {
	const entryIds = new Set<number>();
	const applicableEntryIds = new Set<number>();
	const notApplicableEntryIds = new Set<number>();
	let hasApplicabilityForEverySide = true;
	for (const match of matches) {
		for (const side of [match.home, match.away]) {
			if (!side) continue;
			entryIds.add(side.entryId);
			if (side.applicable === true) applicableEntryIds.add(side.entryId);
			else if (side.applicable === false) notApplicableEntryIds.add(side.entryId);
			else hasApplicabilityForEverySide = false;
		}
	}
	if (
		entryIds.size > expectedSubjectCount ||
		entryIds.size > readySubjectCount + notApplicableSubjectCount
	) {
		return false;
	}
	// Without a complete applicability partition we cannot safely attribute a
	// side to the not-applicable bucket, so use the conservative ready bound.
	// Data's V2 payload includes the marker on every side; the exact partition
	// checks below then allow active brackets containing late entrants.
	if (!hasApplicabilityForEverySide && entryIds.size > readySubjectCount) return false;
	return (
		!hasApplicabilityForEverySide ||
		(applicableEntryIds.size <= readySubjectCount &&
			notApplicableEntryIds.size <= notApplicableSubjectCount &&
			applicableEntryIds.size + notApplicableEntryIds.size === entryIds.size)
	);
}

function knockoutSettledScoresValid(home: unknown, away: unknown, winnerEntryId: unknown): boolean {
	const sides = [home, away].filter(isRecord);
	if (sides.length < 2) {
		const singleSide = sides[0];
		if (!singleSide) return winnerEntryId === null;
		const singleSideScoreMetrics = [
			singleSide.netPoints,
			singleSide.goalsScored,
			singleSide.goalsConceded,
		];
		// An unscored future bye has no winner yet. Once any score/goal metric
		// is present, the sole side must be identified as the winner.
		return (
			singleSideScoreMetrics.every((value) => value === null) ||
			winnerEntryId === singleSide.entryId
		);
	}
	if (!isRecord(home) || !isRecord(away)) return true;
	const homeNetPoints = home.netPoints;
	const awayNetPoints = away.netPoints;
	const scoreMetrics = [
		homeNetPoints,
		home.goalsScored,
		home.goalsConceded,
		awayNetPoints,
		away.goalsScored,
		away.goalsConceded,
	];
	if (scoreMetrics.every((value) => value === null)) return winnerEntryId === null;
	if (winnerEntryId === null) return false;
	const settled = scoreMetrics.every((value) => value !== null);
	if (
		!settled ||
		home.goalsScored !== away.goalsConceded ||
		away.goalsScored !== home.goalsConceded ||
		typeof homeNetPoints !== "number" ||
		typeof awayNetPoints !== "number"
	) {
		return false;
	}
	if (homeNetPoints === awayNetPoints) return true;
	const higherScoringEntryId = homeNetPoints > awayNetPoints ? home.entryId : away.entryId;
	return winnerEntryId === higherScoringEntryId;
}

function knockoutScoreBreakdownValid(
	side: Pick<MyTournamentReviewKnockoutSide, "grossPoints" | "transferCost" | "netPoints">
): boolean {
	// Knockout publications may expose only net points. Once the optional
	// gross/cost breakdown starts, all three values must reconcile.
	if (side.grossPoints === null && side.transferCost === null) return true;
	if (side.grossPoints === null || side.transferCost === null || side.netPoints === null) {
		return false;
	}
	return side.transferCost >= 0 && side.netPoints === side.grossPoints - side.transferCost;
}

function knockoutCache(value: unknown): value is MyTournamentReviewKnockout {
	if (!isRecord(value) || !Array.isArray(value.matches)) return false;
	if (value.matches.length === 0) return false;
	const matchIdentities = new Set<string>();
	return (
		value.matches.every((match) => {
			if (!isRecord(match)) return false;
			const matchId = strictPositiveInt(match.matchId);
			const playAgainstId = strictPositiveInt(match.playAgainstId);
			const identity =
				matchId !== null && playAgainstId !== null ? `${matchId}:${playAgainstId}` : null;
			if (identity === null || matchIdentities.has(identity)) return false;
			matchIdentities.add(identity);
			const home = match.home;
			const away = match.away;
			const homeEntryId = isRecord(home) ? strictPositiveInt(home.entryId) : null;
			const awayEntryId = isRecord(away) ? strictPositiveInt(away.entryId) : null;
			return (
				matchId !== null &&
				playAgainstId !== null &&
				(match.round === null || strictPositiveInt(match.round) !== null) &&
				(match.name === null || typeof match.name === "string") &&
				(match.winnerEntryId === null || strictPositiveInt(match.winnerEntryId) !== null) &&
				(match.home === null || knockoutSideCache(match.home)) &&
				(match.away === null || knockoutSideCache(match.away)) &&
				(match.home !== null || match.away !== null) &&
				(home === null || away === null || homeEntryId !== awayEntryId) &&
				knockoutSettledScoresValid(home, away, match.winnerEntryId) &&
				(match.winnerEntryId === null ||
					match.winnerEntryId === match.home?.entryId ||
					match.winnerEntryId === match.away?.entryId)
			);
		}) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean"
	);
}

type GameweekCacheHead = {
	tournamentId: number;
	eventId: number;
	revision: string;
	format: MyTournamentReviewFormat;
	contentSha256: string;
};

function gameweekCache(
	value: unknown,
	expectedHead?: GameweekCacheHead
): value is MyTournamentGameweekReview {
	if (!isRecord(value)) return false;
	const state = value.state;
	if (
		state !== "NOT_STARTED" &&
		state !== "PENDING" &&
		state !== "WAITING_SOURCE" &&
		state !== "READY" &&
		state !== "DEGRADED" &&
		state !== "UNAVAILABLE"
	) {
		return false;
	}
	if (state !== "READY") {
		return (
			value.scope === null && value.points === null && value.h2h === null && value.knockout === null
		);
	}
	if (!scopeMetaCache(value.scope)) return false;
	const scope = value.scope;
	if (
		expectedHead !== undefined &&
		(scope.tournamentId !== expectedHead.tournamentId ||
			scope.eventId !== expectedHead.eventId ||
			scope.revision !== expectedHead.revision ||
			scope.format !== expectedHead.format ||
			scope.contentSha256 !== expectedHead.contentSha256)
	) {
		return false;
	}
	if (value.scope.format === "POINTS") {
		return (
			pointsCache(value.points, "GAMEWEEK", value.scope) &&
			value.h2h === null &&
			value.knockout === null
		);
	}
	if (value.scope.format === "H2H") {
		return h2hCache(value.h2h) && value.points === null && value.knockout === null;
	}
	return (
		knockoutCache(value.knockout) &&
		value.points === null &&
		value.h2h === null &&
		knockoutEntryCoverageValid(
			value.knockout.matches,
			value.scope.expectedSubjectCount,
			value.scope.readySubjectCount,
			value.scope.notApplicableSubjectCount
		)
	);
}

function seasonCache(
	value: unknown,
	expectedPointsScope?: Pick<MyTournamentReviewScopeMeta, "rowCount" | "readySubjectCount">
): value is MyTournamentSeasonReview {
	if (!isRecord(value) || !isKnownReviewState(value.state)) return false;
	if (
		positiveInt(value.tournamentId) === null ||
		positiveInt(value.throughEventId) === null ||
		(value.latestEventId !== null && positiveInt(value.latestEventId) === null) ||
		(value.latestRevision !== null &&
			(!/^\d+$/.test(String(value.latestRevision)) || Number(value.latestRevision) <= 0)) ||
		(value.format !== null && reviewFormat(value.format) === null) ||
		(value.freshness !== null && !freshnessCache(value.freshness)) ||
		!Array.isArray(value.finalizedEventIds)
	) {
		return false;
	}
	const eventIds = value.finalizedEventIds as unknown[];
	if (
		eventIds.some((eventId) => positiveInt(eventId) === null) ||
		new Set(eventIds).size !== eventIds.length ||
		eventIds.some((eventId, index) => index > 0 && Number(eventIds[index - 1]) >= Number(eventId))
	) {
		return false;
	}
	if (value.state !== "READY") {
		return value.points === null && value.h2h === null && value.knockout === null;
	}
	if (
		positiveInt(value.latestEventId) === null ||
		value.latestRevision === null ||
		value.format === null ||
		!freshnessCache(value.freshness) ||
		eventIds.length === 0 ||
		Number(value.latestEventId) !== Number(eventIds.at(-1))
	) {
		return false;
	}
	if (value.format === "POINTS") {
		return (
			expectedPointsScope !== undefined &&
			pointsCache(value.points, "SEASON", expectedPointsScope) &&
			value.h2h === null &&
			value.knockout === null
		);
	}
	if (value.format === "H2H") {
		return h2hCache(value.h2h) && value.points === null && value.knockout === null;
	}
	return knockoutCache(value.knockout) && value.points === null && value.h2h === null;
}

type SeasonSectionCacheExpectation = {
	tournamentId: number;
	throughEventId: number;
	phaseId: string;
	section: MyTournamentReviewSeasonSection;
	revision: string;
	semanticSha256: string;
};

function seasonSectionCache(
	value: unknown,
	expected: SeasonSectionCacheExpectation
): value is MyTournamentSeasonSection {
	if (!isRecord(value) || !isKnownReviewState(value.state)) return false;
	if (
		value.state !== "READY" ||
		positiveInt(value.tournamentId) !== expected.tournamentId ||
		positiveInt(value.throughEventId) !== expected.throughEventId ||
		value.phaseId !== expected.phaseId ||
		value.section !== expected.section ||
		String(value.revision) !== expected.revision ||
		value.semanticSha256 !== expected.semanticSha256 ||
		!isRecord(value.pageInfo) ||
		typeof value.pageInfo.hasNextPage !== "boolean" ||
		(value.pageInfo.endCursor !== null && typeof value.pageInfo.endCursor !== "string")
	) {
		return false;
	}
	const points = value.points;
	const h2h = value.h2h;
	const knockout = value.knockout;
	const expectedPoints = expected.section.startsWith("POINTS");
	const expectedH2H = expected.section.startsWith("H2H");
	const expectedKnockout = expected.section === "KNOCKOUT_BRACKET";
	if (
		(expectedPoints && !pointsCache(points, "SEASON")) ||
		(expectedH2H && !h2hCache(h2h)) ||
		(expectedKnockout && !knockoutCache(knockout)) ||
		(!expectedPoints && points !== null) ||
		(!expectedH2H && h2h !== null) ||
		(!expectedKnockout && knockout !== null)
	) {
		return false;
	}
	const page = points ?? h2h ?? knockout;
	if (!isRecord(page)) return false;
	return (
		value.pageInfo.hasNextPage === Boolean(page.hasNextPage) &&
		value.pageInfo.endCursor === (page.nextCursor ?? null)
	);
}

function seasonPointsScope(
	row: SeasonMetadataRow
): Pick<MyTournamentReviewScopeMeta, "rowCount" | "readySubjectCount"> {
	const rowCount = row.row_count === null ? NaN : Number(row.row_count);
	const readySubjectCount =
		row.ready_subject_count === null ? NaN : Number(row.ready_subject_count);
	if (
		!Number.isSafeInteger(rowCount) ||
		rowCount <= 0 ||
		!Number.isSafeInteger(readySubjectCount) ||
		readySubjectCount < 0 ||
		readySubjectCount > rowCount
	) {
		throw integrityError("Review season points scope metadata is invalid");
	}
	return { rowCount, readySubjectCount };
}

function seasonCountMetadataValid(row: SeasonMetadataRow): boolean {
	const rowCount = row.row_count === null ? NaN : Number(row.row_count);
	const readySubjectCount =
		row.ready_subject_count === null ? NaN : Number(row.ready_subject_count);
	const format = reviewFormat(row.format) ?? reviewFormat(row.obligation_format);
	return (
		Number.isSafeInteger(rowCount) &&
		rowCount > 0 &&
		Number.isSafeInteger(readySubjectCount) &&
		readySubjectCount >= 0 &&
		// POINTS rows are one-per-subject, so applicability cannot exceed the
		// row count. H2H and KNOCKOUT use row_count for matches/fixtures while
		// ready_subject_count counts participating entries and may be larger;
		// H2H still has a hard two-sides-per-match coverage bound.
		(format === "POINTS"
			? readySubjectCount <= rowCount
			: format === "H2H"
				? readySubjectCount <= rowCount * 2
				: true)
	);
}

function cacheDecoder<T>(value: unknown, validate: (value: unknown) => boolean): T | null {
	if (!isRecord(value) || !isKnownReviewState(value.state) || !validate(value)) return null;
	return value as T;
}

function integrityError(message: string): GraphQLError {
	return new GraphQLError(message, { extensions: { code: "DATA_INTEGRITY_ERROR" } });
}

function catalogState(value: string | null): MyTournamentReviewState {
	return value === null ? "UNAVAILABLE" : reviewState(value);
}

function mapCatalogRow(row: CatalogRow): MyTournamentReviewCatalogItem {
	const tournamentId = positiveInt(row.tournament_id);
	const leagueId = positiveInt(row.league_id);
	const totalTeamNum = positiveInt(row.total_team_num);
	const latestFinalizedEventId =
		row.latest_finalized_event_id === null ? null : positiveInt(row.latest_finalized_event_id);
	const setupStatus = row.setup_status ?? "unknown";
	const finalizedFormat = reviewFormat(row.finalized_format);
	const finalizedState =
		row.finalized_state === null || row.finalized_state === undefined
			? latestFinalizedEventId === null
				? "NOT_STARTED"
				: "UNAVAILABLE"
			: catalogState(row.finalized_state);
	const finalizedRevision =
		row.finalized_revision === null ? null : positiveInt(row.finalized_revision);
	const finalizedPublishedAt = iso(row.finalized_published_at);
	const latestFinalizedScope =
		latestFinalizedEventId !== null && finalizedFormat !== null
			? {
					eventId: latestFinalizedEventId,
					format: finalizedFormat,
					state: finalizedState,
					nextAttemptAt: iso(row.finalized_next_attempt_at),
					executionAttempts: Number(row.finalized_execution_attempts ?? 0),
					sourceRechecks: Number(row.finalized_source_rechecks ?? 0),
					degradedAt: iso(row.finalized_degraded_at),
					revision: finalizedRevision === null ? null : String(finalizedRevision),
					publishedAt: finalizedPublishedAt,
				}
			: null;
	const phaseSummaries: MyTournamentReviewCatalogItem["phaseSummaries"] = [];
	const addPhase = (
		phaseId: string,
		format: MyTournamentReviewFormat,
		startEventId: number | null,
		endEventId: number | null
	) => {
		if (startEventId === null || positiveInt(startEventId) === null) return;
		const state =
			latestFinalizedEventId === null || latestFinalizedEventId < startEventId
				? "NOT_STARTED"
				: latestFinalizedScope?.format === format
					? latestFinalizedScope.state
					: "READY";
		phaseSummaries.push({
			phaseId,
			format,
			startEventId,
			endEventId: endEventId === null ? null : positiveInt(endEventId),
			state,
		});
	};
	if (row.group_mode === "points_races") {
		addPhase("points", "POINTS", row.group_started_event_id, row.group_ended_event_id);
	} else if (row.group_mode === "battle_races") {
		addPhase("h2h", "H2H", row.group_started_event_id, row.group_ended_event_id);
	}
	if (row.knockout_mode && row.knockout_mode !== "no_knockout") {
		addPhase("knockout", "KNOCKOUT", row.knockout_started_event_id, row.knockout_ended_event_id);
	}
	if (
		!tournamentId ||
		!leagueId ||
		!totalTeamNum ||
		!row.name ||
		!row.creator ||
		!row.league_type ||
		(row.latest_finalized_event_id !== null && latestFinalizedEventId === null) ||
		(finalizedState === "READY" &&
			(latestFinalizedEventId === null ||
				finalizedFormat === null ||
				finalizedRevision === null ||
				finalizedPublishedAt === null)) ||
		(finalizedState !== "READY" && (finalizedRevision !== null || finalizedPublishedAt !== null)) ||
		(row.previous_ready_event_id !== null && positiveInt(row.previous_ready_event_id) === null)
	) {
		throw integrityError("Tournament review catalog metadata is invalid");
	}
	return {
		tournamentId,
		name: row.name,
		creator: row.creator,
		leagueId,
		leagueType: row.league_type,
		totalTeamNum,
		latestFinalizedEventId,
		state: finalizedState,
		previousReadyEventId:
			row.previous_ready_event_id === null ? null : positiveInt(row.previous_ready_event_id),
		setupStatus,
		latestFinalizedScope,
		phaseSummaries,
	};
}

function mapScopeMeta(row: PublicationRow, now = Date.now()): MyTournamentReviewScopeMeta {
	const tournamentId = positiveInt(row.tournament_id);
	const eventId = positiveInt(row.event_id);
	const revision = positiveInt(row.revision);
	const format = reviewFormat(row.format);
	const eventChecked = iso(row.event_data_checked_at);
	const sourceMin = iso(row.source_min_checked_at);
	const sourceMax = iso(row.source_max_checked_at);
	const publishedAt = iso(row.published_at);
	const expected = Number(row.expected_subject_count);
	const ready = Number(row.ready_subject_count);
	const notApplicable = Number(row.not_applicable_subject_count);
	const rowCount = Number(row.row_count);
	const eventCheckedMs = eventChecked ? Date.parse(eventChecked) : NaN;
	const sourceMinMs = sourceMin ? Date.parse(sourceMin) : NaN;
	const sourceMaxMs = sourceMax ? Date.parse(sourceMax) : NaN;
	if (
		!tournamentId ||
		!eventId ||
		!revision ||
		!format ||
		row.schema_version !== MY_TOURNAMENT_REVIEW_CONTRACT ||
		row.metric_version !== MY_TOURNAMENT_REVIEW_METRIC_VERSION ||
		!eventChecked ||
		!sourceMin ||
		!sourceMax ||
		!publishedAt ||
		!Number.isInteger(expected) ||
		!Number.isInteger(ready) ||
		!Number.isInteger(notApplicable) ||
		!Number.isInteger(rowCount) ||
		expected < 0 ||
		ready < 0 ||
		notApplicable < 0 ||
		rowCount < 0 ||
		expected === 0 ||
		rowCount === 0 ||
		ready + notApplicable !== expected ||
		!Number.isFinite(eventCheckedMs) ||
		!Number.isFinite(sourceMinMs) ||
		!Number.isFinite(sourceMaxMs) ||
		sourceMinMs < eventCheckedMs ||
		sourceMinMs > sourceMaxMs ||
		Date.parse(publishedAt) < sourceMaxMs ||
		!/^[0-9a-f]{64}$/.test(row.content_sha256) ||
		publicationSemanticSha256(row.payload) !== row.content_sha256
	) {
		throw integrityError("Review publication freshness or count metadata is invalid");
	}
	const payload = row.payload;
	if (
		!isRecord(payload) ||
		payload.schemaVersion !== MY_TOURNAMENT_REVIEW_CONTRACT ||
		typeof payload.metricVersion !== "string" ||
		payload.metricVersion !== row.metric_version ||
		payload.format !== format
	) {
		throw integrityError("Review publication payload does not match its format");
	}
	const payloadKey = format === "POINTS" ? "points" : format === "H2H" ? "h2h" : "knockout";
	const payloadKeys = ["points", "h2h", "knockout"] as const;
	if (!isRecord(payload[payloadKey]) || payloadKeys.filter((key) => key in payload).length !== 1) {
		throw integrityError("Review publication format payload is missing");
	}
	return {
		tournamentId,
		eventId,
		revision: String(revision),
		format,
		state: "READY",
		freshness: {
			eventDataCheckedAt: eventChecked,
			sourceMinCheckedAt: sourceMin,
			sourceMaxCheckedAt: sourceMax,
			publishedAt,
			ageSeconds: Math.max(0, Math.floor((now - Date.parse(publishedAt)) / 1000)),
		},
		rowCount,
		expectedSubjectCount: expected,
		readySubjectCount: ready,
		notApplicableSubjectCount: notApplicable,
		contentSha256: row.content_sha256,
		correctedAt: row.correction_change_id ? publishedAt : null,
	};
}

function refreshAgeSeconds(
	freshness: MyTournamentReviewFreshness,
	now = Date.now()
): MyTournamentReviewFreshness {
	return {
		...freshness,
		ageSeconds: Math.max(0, Math.floor((now - Date.parse(freshness.publishedAt)) / 1000)),
	};
}

function refreshGameweekAge(value: MyTournamentGameweekReview): MyTournamentGameweekReview {
	if (value.state !== "READY" || !value.scope?.freshness) return value;
	return {
		...value,
		scope: { ...value.scope, freshness: refreshAgeSeconds(value.scope.freshness) },
	};
}

function refreshSeasonAge(value: MyTournamentSeasonReview): MyTournamentSeasonReview {
	if (!value.freshness) return value;
	return { ...value, freshness: refreshAgeSeconds(value.freshness) };
}

function mapPointsRows(value: unknown): MyTournamentReviewPointsRow[] {
	if (!Array.isArray(value)) throw integrityError("Review points rows are invalid");
	return value.map((raw) => {
		if (!isRecord(raw)) throw integrityError("Review points row is invalid");
		const entryId = strictPositiveInt(raw.entryId);
		const integerValues = [
			raw.groupId,
			raw.rank,
			raw.previousRank,
			raw.grossPoints,
			raw.transferCost,
			raw.netPoints,
			raw.tournamentScore,
			raw.seasonGrossPoints,
			raw.seasonNetPoints,
			raw.eventRank,
			raw.overallPoints,
			raw.overallRank,
		];
		if (
			!entryId ||
			typeof raw.entryName !== "string" ||
			!raw.entryName.trim() ||
			typeof raw.playerName !== "string" ||
			!raw.playerName.trim() ||
			typeof raw.applicable !== "boolean" ||
			integerValues.some(
				(number) => number !== null && number !== undefined && !nullableSafeInteger(number)
			)
		) {
			throw integrityError("Review points row is invalid");
		}
		const mapped = {
			entryId,
			entryName: raw.entryName.trim(),
			playerName: raw.playerName.trim(),
			applicable: raw.applicable,
			groupId: nullableNumber(raw.groupId),
			rank: nullableNumber(raw.rank),
			previousRank: nullableNumber(raw.previousRank),
			grossPoints: nullableNumber(raw.grossPoints),
			transferCost: nullableNumber(raw.transferCost),
			netPoints: nullableNumber(raw.netPoints),
			tournamentScore: nullableNumber(raw.tournamentScore),
			seasonGrossPoints: nullableNumber(raw.seasonGrossPoints),
			seasonNetPoints: nullableNumber(raw.seasonNetPoints),
			eventRank: nullableNumber(raw.eventRank),
			overallPoints: nullableNumber(raw.overallPoints),
			overallRank: nullableNumber(raw.overallRank),
		};
		if (
			mapped.applicable &&
			[
				mapped.groupId,
				mapped.rank,
				mapped.grossPoints,
				mapped.transferCost,
				mapped.netPoints,
				mapped.tournamentScore,
				mapped.seasonGrossPoints,
				mapped.seasonNetPoints,
			].some((number) => number === null)
		) {
			throw integrityError("Review applicable points row is incomplete");
		}
		if (
			!mapped.applicable &&
			[
				mapped.groupId,
				mapped.rank,
				mapped.previousRank,
				mapped.grossPoints,
				mapped.transferCost,
				mapped.netPoints,
				mapped.tournamentScore,
				mapped.seasonGrossPoints,
				mapped.seasonNetPoints,
				mapped.eventRank,
			].some((number) => number !== null)
		) {
			throw integrityError("Review non-applicable points row contains tournament metrics");
		}
		if (
			mapped.applicable &&
			(strictPositiveInt(mapped.groupId) === null || strictPositiveInt(mapped.rank) === null)
		) {
			throw integrityError("Review applicable points row has invalid group or rank");
		}
		if (
			[mapped.previousRank, mapped.eventRank, mapped.overallRank].some(
				(rank) => rank !== null && strictPositiveInt(rank) === null
			)
		) {
			throw integrityError("Review points row has an invalid optional rank");
		}
		if (mapped.applicable && !pointsRowMetricsValid(mapped)) {
			throw integrityError(
				"Review applicable points row has inconsistent gross, cost, or net points"
			);
		}
		if (mapped.applicable && !seasonPointsMetricsValid(mapped)) {
			throw integrityError(
				"Review applicable points row has inconsistent cumulative gross, cost, or net points"
			);
		}
		return mapped;
	});
}

function mapH2HSide(value: unknown): MyTournamentReviewH2HSide | null {
	if (!isRecord(value)) return null;
	if (typeof value.isAverage !== "boolean") return null;
	const entryId = value.entryId === null ? null : strictPositiveInt(value.entryId);
	if (!value.isAverage && !entryId) return null;
	if (value.isAverage && value.entryId !== null) return null;
	const entryName = typeof value.entryName === "string" ? value.entryName.trim() : "";
	const numericValues = [value.grossPoints, value.transferCost, value.netPoints, value.rank];
	if (
		!entryName ||
		numericValues.some(
			(number) => number !== null && number !== undefined && !nullableSafeInteger(number)
		) ||
		(value.matchPoints !== null &&
			value.matchPoints !== undefined &&
			!nullableNonNegativeSafeInteger(value.matchPoints)) ||
		(value.rank !== null && value.rank !== undefined && strictPositiveInt(value.rank) === null)
	) {
		return null;
	}
	const mapped = {
		entryId,
		entryName,
		isAverage: value.isAverage,
		grossPoints: nullableNumber(value.grossPoints),
		transferCost: nullableNumber(value.transferCost),
		netPoints: nullableNumber(value.netPoints),
		matchPoints: nullableNumber(value.matchPoints),
		rank: nullableNumber(value.rank),
	};
	return h2hScoreBreakdownValid(mapped) ? mapped : null;
}

function mapH2H(value: unknown): {
	matches: MyTournamentReviewH2HMatch[];
	standings: MyTournamentReviewH2HStanding[];
} {
	if (!isRecord(value)) return { matches: [], standings: [] };
	const matchIdentities = new Set<string>();
	const matchParticipantIdentities = new Set<string>();
	const matches = Array.isArray(value.matches)
		? value.matches.map((raw) => {
				if (!isRecord(raw)) throw integrityError("Review H2H match payload is invalid");
				const groupId = strictPositiveInt(raw.groupId);
				const matchId = typeof raw.matchId === "string" ? raw.matchId.trim() : "";
				const home = raw.home === null ? null : mapH2HSide(raw.home);
				const away = raw.away === null ? null : mapH2HSide(raw.away);
				if (
					!matchId ||
					groupId === null ||
					typeof raw.isBye !== "boolean" ||
					(raw.home !== null && !home) ||
					(raw.away !== null && !away) ||
					(raw.isBye
						? (raw.home === null) === (raw.away === null)
						: raw.home === null || raw.away === null)
				) {
					throw integrityError("Review H2H match payload is invalid");
				}
				if (raw.isBye && (home?.isAverage === true || away?.isAverage === true)) {
					throw integrityError("Review H2H bye cannot use an Average Team side");
				}
				if (raw.isBye && [home, away].some((side) => side !== null && side.matchPoints !== null)) {
					throw integrityError("Review H2H bye cannot contain match points");
				}
				if (
					!raw.isBye &&
					home &&
					away &&
					((!home.isAverage && !away.isAverage && home.entryId === away.entryId) ||
						(home.isAverage && away.isAverage))
				) {
					throw integrityError("Review H2H match sides are invalid");
				}
				if (!raw.isBye && (!home || !away || !h2hMatchPointsValid(home, away))) {
					throw integrityError("Review H2H match scores or match points are invalid");
				}
				const identity = JSON.stringify([groupId, matchId]);
				if (matchIdentities.has(identity)) {
					throw integrityError("Review H2H matches contain duplicate identities");
				}
				matchIdentities.add(identity);
				for (const side of [home, away]) {
					if (side && !side.isAverage) {
						const participantIdentity = `${groupId}:${side.entryId}`;
						if (matchParticipantIdentities.has(participantIdentity)) {
							throw integrityError("Review H2H entries appear in multiple matches");
						}
						matchParticipantIdentities.add(participantIdentity);
					}
				}
				return {
					matchId,
					groupId,
					home,
					away,
					isBye: raw.isBye === true,
				};
			})
		: [];
	const standings = Array.isArray(value.standings)
		? value.standings.map((raw) => {
				if (!isRecord(raw)) throw integrityError("Review H2H standing payload is invalid");
				const groupId = strictPositiveInt(raw.groupId);
				const entryId = strictPositiveInt(raw.entryId);
				if (!groupId || !entryId) throw integrityError("Review H2H standing payload is invalid");
				const rank = requiredSafeInteger(raw.rank);
				const played = requiredSafeInteger(raw.played);
				const won = requiredSafeInteger(raw.won);
				const drawn = requiredSafeInteger(raw.drawn);
				const lost = requiredSafeInteger(raw.lost);
				const matchPoints = requiredSafeInteger(raw.matchPoints);
				const pointsFor = requiredSafeInteger(raw.pointsFor);
				const pointsAgainst = requiredSafeInteger(raw.pointsAgainst);
				if (
					rank === null ||
					played === null ||
					won === null ||
					drawn === null ||
					lost === null ||
					matchPoints === null ||
					pointsFor === null ||
					pointsAgainst === null ||
					rank < 1 ||
					played < 0 ||
					won < 0 ||
					drawn < 0 ||
					lost < 0 ||
					matchPoints < 0 ||
					played !== won + drawn + lost ||
					matchPoints !== 3 * won + drawn
				) {
					throw integrityError("Review H2H standing payload is invalid");
				}
				return {
					groupId,
					entryId,
					entryName:
						typeof raw.entryName === "string" && raw.entryName.trim()
							? raw.entryName.trim()
							: (() => {
									throw integrityError("Review H2H standing payload is invalid");
								})(),
					rank,
					played,
					won,
					drawn,
					lost,
					matchPoints,
					pointsFor,
					pointsAgainst,
				};
			})
		: [];
	if (new Set(standings.map((standing) => standing.entryId)).size !== standings.length) {
		throw integrityError("Review H2H standings contain duplicate entries");
	}
	const standingIdentities = new Set(
		standings.map((standing) => `${standing.groupId}:${standing.entryId}`)
	);
	for (const match of matches) {
		for (const side of [match.home, match.away]) {
			if (side && !side.isAverage && !standingIdentities.has(`${match.groupId}:${side.entryId}`)) {
				throw integrityError("Review H2H match participants do not match standings");
			}
		}
	}
	if ([...standingIdentities].some((identity) => !matchParticipantIdentities.has(identity))) {
		throw integrityError("Review H2H standings do not have fixture coverage");
	}
	return { matches, standings };
}

function mapKnockoutSide(value: unknown): MyTournamentReviewKnockoutSide | null {
	if (!isRecord(value)) return null;
	const entryId = strictPositiveInt(value.entryId);
	if (!entryId) return null;
	const entryName = typeof value.entryName === "string" ? value.entryName.trim() : "";
	const numericValues = [
		value.grossPoints,
		value.transferCost,
		value.netPoints,
		value.goalsScored,
		value.goalsConceded,
	];
	if (
		!entryName ||
		(value.applicable !== undefined && typeof value.applicable !== "boolean") ||
		numericValues
			.slice(0, 3)
			.some((number) => number !== null && number !== undefined && !nullableSafeInteger(number)) ||
		numericValues
			.slice(3)
			.some(
				(number) => number !== null && number !== undefined && !(safeInteger(number) && number >= 0)
			)
	) {
		return null;
	}
	const mapped: MyTournamentReviewKnockoutSide = {
		entryId,
		entryName,
		...(value.applicable === undefined ? {} : { applicable: value.applicable }),
		grossPoints: nullableNumber(value.grossPoints),
		transferCost: nullableNumber(value.transferCost),
		netPoints: nullableNumber(value.netPoints),
		goalsScored: nullableNumber(value.goalsScored),
		goalsConceded: nullableNumber(value.goalsConceded),
	};
	const scoreMetrics = [mapped.grossPoints, mapped.transferCost, mapped.netPoints];
	const goalMetrics = [mapped.goalsScored, mapped.goalsConceded];
	if (
		(mapped.applicable === false &&
			[...scoreMetrics, ...goalMetrics].some((metric) => metric !== null)) ||
		!knockoutScoreBreakdownValid(mapped)
	) {
		return null;
	}
	return mapped;
}

function mapKnockout(value: unknown): MyTournamentReviewKnockoutMatch[] {
	if (!isRecord(value) || !Array.isArray(value.matches)) return [];
	const matchIdentities = new Set<string>();
	return value.matches.map((raw) => {
		if (!isRecord(raw)) throw integrityError("Review knockout match payload is invalid");
		const matchId = strictPositiveInt(raw.matchId);
		const playAgainstId = strictPositiveInt(raw.playAgainstId);
		if (!matchId || !playAgainstId)
			throw integrityError("Review knockout match payload is invalid");
		const round =
			raw.round === null || raw.round === undefined ? null : strictPositiveInt(raw.round);
		const winnerEntryId =
			raw.winnerEntryId === null || raw.winnerEntryId === undefined
				? null
				: strictPositiveInt(raw.winnerEntryId);
		const home = mapKnockoutSide(raw.home);
		const away = mapKnockoutSide(raw.away);
		if (
			(raw.round !== null && raw.round !== undefined && round === null) ||
			(raw.winnerEntryId !== null && raw.winnerEntryId !== undefined && winnerEntryId === null) ||
			raw.home === undefined ||
			(raw.home !== null && !home) ||
			raw.away === undefined ||
			(raw.away !== null && !away) ||
			(home === null && away === null) ||
			(home !== null && away !== null && home.entryId === away.entryId) ||
			(winnerEntryId !== null &&
				winnerEntryId !== home?.entryId &&
				winnerEntryId !== away?.entryId) ||
			!knockoutSettledScoresValid(home, away, winnerEntryId)
		) {
			throw integrityError("Review knockout match payload is invalid");
		}
		const identity = `${matchId}:${playAgainstId}`;
		if (matchIdentities.has(identity)) {
			throw integrityError("Review knockout matches contain duplicate identities");
		}
		matchIdentities.add(identity);
		return {
			round,
			name: typeof raw.name === "string" ? raw.name : null,
			matchId,
			playAgainstId,
			home,
			away,
			winnerEntryId,
		};
	});
}

function pageSlice<T>(
	values: T[],
	first: number,
	cursor: ReviewCursor | null,
	revision: string,
	scope: string,
	maxOffset = values.length
): {
	items: T[];
	nextCursor: string | null;
	hasNextPage: boolean;
} {
	const start = cursor?.offset ?? 0;
	if (start > maxOffset) {
		throw new GraphQLError("Review cursor is out of range", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	const items = values.slice(start, start + first);
	const hasNextPage = start + items.length < values.length;
	return {
		items,
		nextCursor: hasNextPage ? encodeCursor(start + items.length, revision, scope) : null,
		hasNextPage,
	};
}

function pointsFromPayload(
	row: PublicationRow,
	first: number,
	cursor: ReviewCursor | null,
	view: "GAMEWEEK" | "SEASON" = "GAMEWEEK",
	cursorScopeOverride?: string
): MyTournamentReviewPoints {
	const payload = isRecord(row.payload) ? row.payload : {};
	const source = isRecord(payload.points) ? payload.points : {};
	const rows = mapPointsRows(source.rows);
	if (rows.length !== Number(row.row_count) || rows.length !== Number(row.expected_subject_count)) {
		throw integrityError("Review points row count does not match publication metadata");
	}
	const entryIds = new Set(rows.map((item) => item.entryId));
	if (
		entryIds.size !== rows.length ||
		rows.filter((item) => item.applicable).length !== Number(row.ready_subject_count) ||
		rows.filter((item) => !item.applicable).length !== Number(row.not_applicable_subject_count)
	) {
		throw integrityError("Review points row identity or applicability metadata is invalid");
	}
	if (source.headline !== "gross") {
		throw integrityError("Review points headline metric is invalid");
	}
	// The Data publication builder derives all six aggregates from applicable
	// rows.  Recompute them at the read boundary so a stale or partially
	// updated JSON payload cannot present totals that disagree with its rows.
	const aggregates = {
		grossPointsTotal: requiredInteger(source.grossPointsTotal, "grossPointsTotal"),
		grossPointsAverage: requiredNumber(source.grossPointsAverage, "grossPointsAverage"),
		netPointsTotal: requiredInteger(source.netPointsTotal, "netPointsTotal"),
		seasonGrossPointsTotal: requiredInteger(
			source.seasonGrossPointsTotal,
			"seasonGrossPointsTotal"
		),
		seasonGrossPointsAverage: requiredNumber(
			source.seasonGrossPointsAverage,
			"seasonGrossPointsAverage"
		),
		seasonNetPointsTotal: requiredInteger(source.seasonNetPointsTotal, "seasonNetPointsTotal"),
	};
	const applicableRows = rows.filter((item) => item.applicable);
	const seasonTransferCosts = new Map<number, number | null>();
	if (view === "SEASON") {
		for (const item of applicableRows) {
			seasonTransferCosts.set(item.entryId, seasonTransferCost(item));
		}
	}
	const grossPointsTotal = applicableRows.reduce((sum, item) => sum + (item.grossPoints ?? 0), 0);
	const netPointsTotal = applicableRows.reduce((sum, item) => sum + (item.netPoints ?? 0), 0);
	const seasonGrossPointsTotal = applicableRows.reduce(
		(sum, item) => sum + (item.seasonGrossPoints ?? 0),
		0
	);
	const seasonNetPointsTotal = applicableRows.reduce(
		(sum, item) => sum + (item.seasonNetPoints ?? 0),
		0
	);
	if (
		aggregates.grossPointsTotal !== grossPointsTotal ||
		aggregates.netPointsTotal !== netPointsTotal ||
		aggregates.seasonGrossPointsTotal !== seasonGrossPointsTotal ||
		aggregates.seasonNetPointsTotal !== seasonNetPointsTotal ||
		aggregates.grossPointsAverage !== roundedAverage(grossPointsTotal, applicableRows.length) ||
		aggregates.seasonGrossPointsAverage !==
			roundedAverage(seasonGrossPointsTotal, applicableRows.length)
	) {
		throw integrityError("Review points aggregates do not match applicable rows");
	}
	const selectedGrossPointsTotal =
		view === "SEASON" ? aggregates.seasonGrossPointsTotal : aggregates.grossPointsTotal;
	const selectedGrossPointsAverage =
		view === "SEASON" ? aggregates.seasonGrossPointsAverage : aggregates.grossPointsAverage;
	const selectedNetPointsTotal =
		view === "SEASON" ? aggregates.seasonNetPointsTotal : aggregates.netPointsTotal;
	const outputRows: MyTournamentReviewPointsRow[] =
		view === "SEASON"
			? rows.map((item) => ({
					...item,
					grossPoints: item.seasonGrossPoints,
					transferCost: seasonTransferCosts.get(item.entryId) ?? null,
					netPoints: item.seasonNetPoints,
				}))
			: rows;
	const page = pageSlice(
		outputRows,
		first,
		cursor,
		String(row.revision),
		cursorScopeOverride ??
			reviewCursorScope(row, view === "SEASON" ? "SEASON_POINTS" : "GAMEWEEK_POINTS")
	);
	return {
		headlineMetric: "gross",
		grossPointsTotal: selectedGrossPointsTotal,
		grossPointsAverage: selectedGrossPointsAverage,
		netPointsTotal: selectedNetPointsTotal,
		seasonGrossPointsTotal: aggregates.seasonGrossPointsTotal,
		seasonGrossPointsAverage: aggregates.seasonGrossPointsAverage,
		seasonNetPointsTotal: aggregates.seasonNetPointsTotal,
		rows: page.items,
		nextCursor: page.nextCursor,
		hasNextPage: page.hasNextPage,
		aggregateWitness: {
			view,
			rowCount: rows.length,
			applicableRowCount: applicableRows.length,
			pageOffset: cursor?.offset ?? 0,
			pageLength: page.items.length,
			grossPointsTotal: aggregates.grossPointsTotal,
			grossPointsAverage: aggregates.grossPointsAverage,
			netPointsTotal: aggregates.netPointsTotal,
			seasonGrossPointsTotal: aggregates.seasonGrossPointsTotal,
			seasonGrossPointsAverage: aggregates.seasonGrossPointsAverage,
			seasonNetPointsTotal: aggregates.seasonNetPointsTotal,
			selectedGrossPointsTotal,
			selectedGrossPointsAverage,
			selectedNetPointsTotal,
			rows: rows.map((source, index) => {
				const item = outputRows[index]!;
				return {
					entryId: item.entryId,
					applicable: item.applicable,
					sourceGrossPoints: source.grossPoints,
					sourceTransferCost: source.transferCost,
					sourceNetPoints: source.netPoints,
					grossPoints: item.grossPoints,
					transferCost: item.transferCost,
					netPoints: item.netPoints,
					seasonGrossPoints: item.seasonGrossPoints,
					seasonNetPoints: item.seasonNetPoints,
				};
			}),
		},
	};
}

function h2hFromPayload(
	row: PublicationRow,
	first: number,
	cursor: ReviewCursor | null,
	section?: "H2H_STANDINGS" | "H2H_FIXTURES",
	cursorScopeOverride?: string
): MyTournamentReviewH2H {
	const payload = isRecord(row.payload) ? row.payload : {};
	const source = mapH2H(payload.h2h);
	if (
		source.matches.length !== Number(row.row_count) ||
		source.standings.length !== Number(row.ready_subject_count)
	) {
		throw integrityError("Review H2H row count does not match publication metadata");
	}
	const cursorScope = cursorScopeOverride ?? reviewCursorScope(row, "H2H");
	const selectedMatches = section === "H2H_STANDINGS" ? [] : source.matches;
	const selectedStandings = section === "H2H_FIXTURES" ? [] : source.standings;
	const page = pageSlice(selectedMatches, first, cursor, String(row.revision), cursorScope);
	const standingsPage = pageSlice(
		selectedStandings,
		first,
		cursor,
		String(row.revision),
		cursorScope
	);
	const hasNextPage = page.hasNextPage || standingsPage.hasNextPage;
	const matchParticipantIdentities = new Set<string>();
	for (const match of source.matches) {
		for (const side of [match.home, match.away]) {
			if (side && !side.isAverage) {
				matchParticipantIdentities.add(`${match.groupId}:${side.entryId}`);
			}
		}
	}
	const standingIdentities = source.standings.map(
		(standing) => `${standing.groupId}:${standing.entryId}`
	);
	return {
		matches: page.items,
		standings: standingsPage.items,
		nextCursor: page.hasNextPage ? page.nextCursor : standingsPage.nextCursor,
		hasNextPage,
		coverageWitness: {
			matchIdentities: source.matches.map((match) =>
				JSON.stringify([match.groupId, match.matchId])
			),
			matchParticipantIdentities: [...matchParticipantIdentities],
			standingIdentities,
			pageOffset: cursor?.offset ?? 0,
			pageMatchParticipantIdentities: page.items.flatMap((match) =>
				[match.home, match.away]
					.filter((side): side is MyTournamentReviewH2HSide => side !== null && !side.isAverage)
					.map((side) => `${match.groupId}:${side.entryId}`)
			),
			pageStandingIdentities: standingsPage.items.map(
				(standing) => `${standing.groupId}:${standing.entryId}`
			),
		},
	};
}

function knockoutFromPayload(
	row: PublicationRow,
	first: number,
	cursor: ReviewCursor | null,
	cursorScopeOverride?: string
): MyTournamentReviewKnockout {
	const payload = isRecord(row.payload) ? row.payload : {};
	const matches = mapKnockout(payload.knockout);
	if (matches.length !== Number(row.row_count)) {
		throw integrityError("Review knockout row count does not match publication metadata");
	}
	if (
		!knockoutEntryCoverageValid(
			matches,
			Number(row.expected_subject_count),
			Number(row.ready_subject_count),
			Number(row.not_applicable_subject_count)
		)
	) {
		throw integrityError("Review knockout entry coverage does not match subject metadata");
	}
	const page = pageSlice(
		matches,
		first,
		cursor,
		String(row.revision),
		cursorScopeOverride ?? reviewCursorScope(row, "KNOCKOUT")
	);
	return {
		matches: page.items,
		nextCursor: page.nextCursor,
		hasNextPage: page.hasNextPage,
	};
}

function emptyGameweek(state: MyTournamentReviewState): MyTournamentGameweekReview {
	return { state, scope: null, points: null, h2h: null, knockout: null };
}

function unavailableReviewState(value: unknown): MyTournamentReviewState {
	if (value === null || value === undefined) return "NOT_STARTED";
	const state = reviewState(typeof value === "string" ? value : null);
	if (state === "READY" || state === "UNAVAILABLE") return state;
	return state;
}

function requireNonReadyObligationState(value: unknown): MyTournamentReviewState {
	const state = unavailableReviewState(value);
	if (state === "READY") {
		throw integrityError("Review obligation is READY without a coherent publication head");
	}
	return state;
}

function mapGameweek(
	row: PublicationRow | null,
	first: number,
	cursor: ReviewCursor | null
): MyTournamentGameweekReview {
	if (!row) return emptyGameweek("UNAVAILABLE");
	const scope = mapScopeMeta(row);
	if (scope.format === "POINTS") {
		return {
			state: "READY",
			scope,
			points: pointsFromPayload(row, first, cursor),
			h2h: null,
			knockout: null,
		};
	}
	if (scope.format === "H2H") {
		return {
			state: "READY",
			scope,
			points: null,
			h2h: h2hFromPayload(row, first, cursor),
			knockout: null,
		};
	}
	return {
		state: "READY",
		scope,
		points: null,
		h2h: null,
		knockout: knockoutFromPayload(row, first, cursor),
	};
}

function parsePublicationRows(value: unknown): PublicationRow[] {
	if (!Array.isArray(value)) throw integrityError("Review season rows are invalid");
	return value.map((row) => {
		if (!isRecord(row) || !positiveInt(row.event_id)) {
			throw integrityError("Review season row metadata is invalid");
		}
		return row as unknown as PublicationRow;
	});
}

function parseFinalizedEventIds(value: unknown): number[] | null {
	if (value === undefined) return null;
	if (!Array.isArray(value)) throw integrityError("Review season event window is invalid");
	const eventIds = value.map((eventId) => positiveInt(eventId));
	if (
		eventIds.some((eventId): eventId is null => eventId === null) ||
		new Set(eventIds).size !== eventIds.length ||
		eventIds.some((eventId, index) => index > 0 && eventIds[index - 1]! >= eventId!)
	) {
		throw integrityError("Review season event window is invalid");
	}
	return eventIds as number[];
}

function validateReviewHeadRow(row: ReviewHeadRow): ValidReviewHeadRow {
	if (
		!positiveInt(row.event_id) ||
		!positiveInt(row.revision) ||
		!reviewFormat(row.format) ||
		!row.content_sha256 ||
		!/^[0-9a-f]{64}$/.test(row.content_sha256) ||
		!iso(row.event_data_checked_at) ||
		!iso(row.published_at)
	) {
		throw integrityError("Review head metadata is invalid");
	}
	return {
		event_id: row.event_id!,
		revision: row.revision!,
		format: row.format!,
		content_sha256: row.content_sha256!,
		event_data_checked_at: row.event_data_checked_at!,
		published_at: row.published_at!,
	};
}

function optionalReviewHeadRow(row: ReviewHeadRow): ValidReviewHeadRow | null {
	const headFields = [
		row.event_id,
		row.revision,
		row.format,
		row.content_sha256,
		row.event_data_checked_at,
		row.published_at,
	];
	if (headFields.every((value) => value === null || value === undefined)) return null;
	if (headFields.some((value) => value === null || value === undefined)) {
		throw integrityError("Review head metadata is incomplete");
	}
	return validateReviewHeadRow(row);
}

function reviewHeadKey(row: ValidReviewHeadRow): string {
	return `${row.event_id}:${String(row.revision)}:${row.content_sha256}:${iso(row.published_at)}`;
}

export type MyTournamentReviewRepository = {
	loadCatalog(
		context: GraphQLContext,
		scope: MyTournamentReviewScope,
		args?: { first?: number | null; after?: string | null; search?: string | null }
	): Promise<MyTournamentReviewCatalog | MyTournamentReviewCatalogConnection>;
	loadGameweekReview(
		context: GraphQLContext,
		args: {
			tournamentId: number;
			eventId: number;
			first?: number | null;
			after?: string | null;
			revision?: string | null;
		}
	): Promise<MyTournamentGameweekReview>;
	loadSeasonReview(
		context: GraphQLContext,
		args: {
			tournamentId: number;
			throughEventId: number;
			first?: number | null;
			after?: string | null;
		}
	): Promise<MyTournamentSeasonReview>;
	loadSeasonReviewSection?(
		context: GraphQLContext,
		args: {
			tournamentId: number;
			throughEventId: number;
			phaseId: string;
			section: MyTournamentReviewSeasonSection;
			first?: number | null;
			after?: string | null;
			revision: string;
			semanticSha256: string;
		}
	): Promise<MyTournamentSeasonSection>;
	loadStatus(context: GraphQLContext, tournamentId: number): Promise<MyTournamentReviewStatus>;
};

export const createMyTournamentReviewRepository = (): MyTournamentReviewRepository => ({
	async loadCatalog(context, scope, args = {}) {
		if (scope === "MANAGED" && (!context.principal || !hasVerifiedEntry(context.principal))) {
			throw new GraphQLError("A verified FPL binding is required", {
				extensions: { code: "FORBIDDEN" },
			});
		}
		const viewerEntryId = context.principal ? viewerEntryIdForPrincipal(context.principal) : null;
		const catalogEntryId = scope === "MANAGED" ? context.principal!.fplEntryId : viewerEntryId;
		const first = boundedFirst(args.first, 50);
		const adminReadAll = Boolean(context.principal && hasPlatformAdminAccess(context.principal));
		const search = args.search?.trim() || null;
		let afterTournamentId: number | null = null;
		if (args.after) {
			try {
				const decoded: unknown = JSON.parse(Buffer.from(args.after, "base64url").toString("utf8"));
				if (
					!isRecord(decoded) ||
					decoded.scope !== scope ||
					decoded.viewerEntryId !== (viewerEntryId ?? null) ||
					decoded.adminReadAll !== adminReadAll ||
					decoded.search !== search
				) {
					throw new Error("scope mismatch");
				}
				afterTournamentId = positiveInt(decoded.tournamentId);
			} catch {
				throw new GraphQLError("Catalog cursor does not match this viewer or scope", {
					extensions: { code: "BAD_USER_INPUT" },
				});
			}
			if (afterTournamentId === null) {
				throw new GraphQLError("Catalog cursor is invalid", {
					extensions: { code: "BAD_USER_INPUT" },
				});
			}
		}
		const rawRows = await context.database.query<CatalogRow>(MY_TOURNAMENT_REVIEW_CATALOG_SQL, [
			context.currentSeason.seasonId,
			scope,
			catalogEntryId,
			afterTournamentId,
			search,
			first + 1,
		]);
		const hasNextPage = rawRows.rows.length > first;
		const rows = rawRows.rows.slice(0, first).map(mapCatalogRow);
		const endCursor = hasNextPage
			? Buffer.from(
					JSON.stringify({
						scope,
						viewerEntryId: viewerEntryId ?? null,
						adminReadAll,
						search,
						tournamentId: rows.at(-1)?.tournamentId,
					}),
					"utf8"
				).toString("base64url")
			: null;
		const result: MyTournamentReviewCatalogConnection = {
			state: rows.some((row) => row.state === "READY")
				? "READY"
				: rows.length
					? rows[0]!.state
					: "UNAVAILABLE",
			asOf: new Date().toISOString(),
			viewerEntryId,
			adminReadAll,
			tournaments: rows,
			edges: rows.map((node) => ({
				cursor: Buffer.from(
					JSON.stringify({
						scope,
						viewerEntryId: viewerEntryId ?? null,
						adminReadAll,
						search,
						tournamentId: node.tournamentId,
					}),
					"utf8"
				).toString("base64url"),
				node,
			})),
			pageInfo: { hasNextPage, endCursor },
		};
		return result;
	},

	async loadGameweekReview(context, args) {
		validateReviewEventId(args.eventId, "eventId");
		const first = boundedFirst(args.first, 50);
		const revision = args.revision?.trim() || null;
		if (
			revision &&
			(!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) <= 0)
		) {
			throw new GraphQLError("revision must be a positive integer", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const headResult = await context.database.query<ReviewHeadRow>(MY_TOURNAMENT_REVIEW_HEAD_SQL, [
			context.currentSeason.seasonId,
			args.tournamentId,
			args.eventId,
			revision,
		]);
		const metadata = headResult.rows[0] ?? null;
		const head = metadata ? optionalReviewHeadRow(metadata) : null;
		const activeRevision =
			metadata?.active_revision === null || metadata?.active_revision === undefined
				? null
				: positiveInt(metadata.active_revision);
		if (
			metadata?.active_revision !== null &&
			metadata?.active_revision !== undefined &&
			activeRevision === null
		) {
			throw integrityError("Review active head revision is invalid");
		}
		if (head && metadata?.obligation_state !== undefined && metadata.obligation_state !== "READY") {
			throw integrityError("Review head is not backed by a READY obligation");
		}
		if (!head && revision !== null && activeRevision !== null) {
			// A revision pin is an optimistic concurrency guard.  If the active
			// head exists but has moved on, surface a client mismatch instead of
			// silently returning an unavailable response for a stale pin.
			throw new GraphQLError("Review revision does not match the active publication head", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const unavailableState = head
			? "READY"
			: requireNonReadyObligationState(metadata?.obligation_state);
		const cursor = head
			? decodePublicationCursor(
					{
						season_id: context.currentSeason.seasonId,
						tournament_id: args.tournamentId,
						event_id: args.eventId,
						revision: head.revision,
						format: head.format,
					},
					args.after,
					"GAMEWEEK"
				)
			: null;
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2.1:gameweek:${args.tournamentId}:${args.eventId}:${head ? reviewHeadKey(head) : `${revision ?? "none"}:${unavailableState}`}:${first}:${cursor?.canonical ?? ""}`,
			head?.content_sha256 ?? `state-${unavailableState.toLowerCase().replaceAll("_", "-")}`
		);
		const cached = await readJsonQueryCache(context, key, (value) =>
			cacheDecoder<MyTournamentGameweekReview>(value, (candidate) =>
				gameweekCache(
					candidate,
					head
						? {
								tournamentId: args.tournamentId,
								eventId: head.event_id,
								revision: String(head.revision),
								format: reviewFormat(head.format)!,
								contentSha256: head.content_sha256,
							}
						: undefined
				)
			)
		);
		if (cached) return refreshGameweekAge(cached);
		if (!head) {
			const unavailable = emptyGameweek(unavailableState);
			await writeJsonQueryCache(context, key, unavailable, REVIEW_CACHE_TTL_SECONDS);
			return unavailable;
		}
		const result = await context.database.query<PublicationRow>(
			MY_TOURNAMENT_REVIEW_PUBLICATION_SQL,
			[
				context.currentSeason.seasonId,
				args.tournamentId,
				args.eventId,
				String(head.revision),
				head.content_sha256,
			]
		);
		const row = result.rows[0] ?? null;
		if (!row) {
			throw integrityError("Review head publication disappeared during read");
		}
		const materializedRow = await materializePublicationRow(context.database, row);
		const payload = mapGameweek(materializedRow, first, cursor);
		await writeJsonQueryCache(context, key, payload, REVIEW_CACHE_TTL_SECONDS);
		return payload;
	},

	async loadSeasonReview(context, args) {
		validateReviewEventId(args.throughEventId, "throughEventId");
		const first = boundedFirst(args.first, 100);
		const metadataResult = await context.database.query<SeasonMetadataRow>(
			MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL,
			[context.currentSeason.seasonId, args.tournamentId, args.throughEventId]
		);
		const metadataRows = metadataResult.rows;
		let finalizedEventIds: number[] | null = null;
		const rowsByEvent = new Map<number, SeasonMetadataRow>();
		const headsByEvent = new Map<number, ValidReviewHeadRow>();
		const obligationsByEvent = new Map<
			number,
			{ format: MyTournamentReviewFormat; state: MyTournamentReviewState }
		>();
		for (const row of metadataRows) {
			const rowWindow = parseFinalizedEventIds(row.finalized_event_ids);
			if (rowWindow !== null) {
				if (
					finalizedEventIds !== null &&
					JSON.stringify(finalizedEventIds) !== JSON.stringify(rowWindow)
				) {
					throw integrityError("Review season event window is inconsistent");
				}
				finalizedEventIds = rowWindow;
			}
			const eventId =
				row.event_id === null || row.event_id === undefined ? null : positiveInt(row.event_id);
			if (row.event_id !== null && row.event_id !== undefined && eventId === null) {
				throw integrityError("Review season metadata event is invalid");
			}
			if (eventId === null) {
				if (
					row.revision !== null ||
					row.format !== null ||
					row.content_sha256 !== null ||
					row.event_data_checked_at !== null ||
					row.published_at !== null ||
					row.row_count !== null ||
					row.ready_subject_count !== null ||
					row.obligation_format !== null ||
					row.obligation_state !== null
				) {
					throw integrityError("Review season null metadata row is inconsistent");
				}
				continue;
			}
			if (rowsByEvent.has(eventId)) {
				throw integrityError("Review season metadata contains duplicate events");
			}
			rowsByEvent.set(eventId, row);
			const headFields = [
				row.revision,
				row.format,
				row.content_sha256,
				row.event_data_checked_at,
				row.published_at,
			];
			const hasHead = headFields.some((value) => value !== null && value !== undefined);
			const hasCountMetadata = row.row_count !== null || row.ready_subject_count !== null;
			if (hasHead !== hasCountMetadata || (hasCountMetadata && !seasonCountMetadataValid(row))) {
				throw integrityError("Review season count metadata is inconsistent");
			}
			if (hasHead) {
				if (headFields.some((value) => value === null || value === undefined)) {
					throw integrityError("Review season head metadata is incomplete");
				}
				const head = validateReviewHeadRow({
					event_id: eventId,
					revision: row.revision!,
					format: row.format!,
					content_sha256: row.content_sha256!,
					event_data_checked_at: row.event_data_checked_at!,
					published_at: row.published_at!,
				});
				if (row.obligation_state !== "READY") {
					throw integrityError("Review season head is not READY");
				}
				if (row.obligation_format !== row.format || !reviewFormat(row.obligation_format)) {
					throw integrityError("Review season head format is inconsistent");
				}
				headsByEvent.set(eventId, head);
			}
			if (row.obligation_state !== null && row.obligation_state !== undefined) {
				const format = reviewFormat(row.obligation_format);
				if (!format) throw integrityError("Review season obligation format is invalid");
				obligationsByEvent.set(eventId, {
					format,
					state: unavailableReviewState(row.obligation_state),
				});
			} else if (row.obligation_format !== null && row.obligation_format !== undefined) {
				throw integrityError("Review season obligation state is missing");
			}
		}
		finalizedEventIds ??= [];
		for (const eventId of finalizedEventIds) {
			if (!rowsByEvent.has(eventId)) {
				throw integrityError("Review season finalized event metadata is missing");
			}
		}
		const latestFinalizedEventId = finalizedEventIds.at(-1) ?? null;
		const obligationEventIds = [...obligationsByEvent.keys()].sort((a, b) => b - a);
		const latestObligationEventId = obligationEventIds[0] ?? null;
		const latestObligation =
			latestObligationEventId === null ? null : obligationsByEvent.get(latestObligationEventId)!;
		const missingFinalizedEventIds = finalizedEventIds
			.filter((eventId) => !headsByEvent.has(eventId))
			.sort((a, b) => b - a);
		let unavailableState: MyTournamentReviewState = "NOT_STARTED";
		let ready = finalizedEventIds.length > 0;
		if (missingFinalizedEventIds.length > 0) {
			for (const eventId of missingFinalizedEventIds) {
				const missingObligation = obligationsByEvent.get(eventId);
				if (!missingObligation) {
					throw integrityError("Review season finalized event is missing its obligation");
				}
				if (missingObligation.state === "READY") {
					throw integrityError(
						"Review season finalized event has a READY obligation without a coherent head"
					);
				}
			}
			ready = false;
			const latestMissingEventId = missingFinalizedEventIds[0]!;
			const missingObligation = obligationsByEvent.get(latestMissingEventId);
			if (!missingObligation)
				throw integrityError("Review season finalized event is missing its obligation");
			unavailableState = requireNonReadyObligationState(missingObligation.state);
		}
		if (
			latestObligationEventId !== null &&
			(latestFinalizedEventId === null || latestObligationEventId > latestFinalizedEventId)
		) {
			ready = false;
			if (latestObligation!.state === "READY") {
				throw integrityError("Review season obligation is READY beyond the finalized event window");
			}
			unavailableState = requireNonReadyObligationState(latestObligation!.state);
		}
		if (finalizedEventIds.length === 0 && latestObligation !== null) {
			ready = false;
			if (latestObligation.state === "READY") {
				throw integrityError("Review season obligation is READY without a finalized event");
			}
			unavailableState = requireNonReadyObligationState(latestObligation.state);
		}
		const latestHead = (() => {
			if (!ready) return null;
			if (latestFinalizedEventId === null) {
				throw integrityError("Review season has no latest finalized event");
			}
			const head = headsByEvent.get(latestFinalizedEventId);
			if (!head) {
				throw integrityError("Review season latest finalized event has no publication head");
			}
			return head;
		})();
		const phaseDescriptors = [...rowsByEvent.entries()].reduce<MyTournamentSeasonReview["phases"]>(
			(phases, [eventId, row]) => {
				const format = reviewFormat(row.format ?? row.obligation_format);
				if (!format) return phases;
				const state = headsByEvent.has(eventId)
					? "READY"
					: row.obligation_state
						? unavailableReviewState(row.obligation_state)
						: "NOT_STARTED";
				const existing = phases?.find((phase) => phase.format === format);
				const revision = row.revision === null ? null : positiveInt(row.revision);
				const contentSha = row.content_sha256 ?? null;
				const publishedAt = iso(row.published_at);
				if (existing) {
					existing.startEventId = Math.min(existing.startEventId, eventId);
					existing.endEventId = Math.max(existing.endEventId, eventId);
					if (eventId >= existing.endEventId) {
						existing.state = state;
						existing.revision = revision === null ? null : String(revision);
						existing.semanticSha256 = contentSha;
						existing.publishedAt = publishedAt;
						existing.correctedAt = row.correction_change_id ? publishedAt : null;
						existing.settledAt = iso(row.event_data_checked_at);
					}
					return phases;
				}
				phases?.push({
					phaseId: format.toLowerCase(),
					format,
					startEventId: eventId,
					endEventId: eventId,
					state,
					settledAt: iso(row.event_data_checked_at),
					publishedAt,
					correctedAt: row.correction_change_id ? publishedAt : null,
					revision: revision === null ? null : String(revision),
					semanticSha256: contentSha,
				});
				return phases;
			},
			[]
		);
		phaseDescriptors?.sort((left, right) => left.startEventId - right.startEventId);
		const cursor = latestHead
			? decodePublicationCursor(
					{
						season_id: context.currentSeason.seasonId,
						tournament_id: args.tournamentId,
						event_id: latestHead.event_id,
						revision: latestHead.revision,
						format: latestHead.format,
					},
					args.after,
					"SEASON"
				)
			: null;
		const latestHeadMetadata = latestHead ? rowsByEvent.get(latestHead.event_id) : undefined;
		const expectedPointsScope =
			latestHead && reviewFormat(latestHead.format) === "POINTS" && latestHeadMetadata
				? seasonPointsScope(latestHeadMetadata)
				: undefined;
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2.1:season:${args.tournamentId}:${args.throughEventId}:${first}:${cursor?.canonical ?? ""}:${unavailableState}:${finalizedEventIds.join(",")}:${metadataRows
				.map((row) =>
					[
						row.event_id ?? "null",
						row.revision ?? "null",
						row.format ?? "null",
						row.content_sha256 ?? "null",
						row.row_count ?? "null",
						row.ready_subject_count ?? "null",
						row.obligation_format ?? "null",
						row.obligation_state ?? "null",
					].join(":")
				)
				.join(",")}`,
			latestHead?.content_sha256 ?? `state-${unavailableState.toLowerCase().replaceAll("_", "-")}`
		);
		const cached = await readJsonQueryCache(context, key, (value) =>
			cacheDecoder<MyTournamentSeasonReview>(value, (candidate) =>
				seasonCache(candidate, expectedPointsScope)
			)
		);
		if (cached) return refreshSeasonAge(cached);
		if (!ready) {
			const unavailable: MyTournamentSeasonReview = {
				state: unavailableState,
				tournamentId: args.tournamentId,
				throughEventId: args.throughEventId,
				latestEventId: null,
				latestRevision: null,
				format: null,
				freshness: null,
				finalizedEventIds,
				points: null,
				h2h: null,
				knockout: null,
				phases: phaseDescriptors ?? [],
			};
			await writeJsonQueryCache(context, key, unavailable, REVIEW_CACHE_TTL_SECONDS);
			return unavailable;
		}
		if (!latestHead)
			throw integrityError("Review season latest finalized event has no publication head");
		const result = await context.database.query<PublicationRow>(MY_TOURNAMENT_REVIEW_SEASON_SQL, [
			context.currentSeason.seasonId,
			args.tournamentId,
			args.throughEventId,
			latestFinalizedEventId,
			String(latestHead.revision),
			latestHead.content_sha256,
		]);
		const rows = parsePublicationRows(result.rows);
		if (rows.length === 0) {
			throw integrityError("Review season head publication disappeared during read");
		}
		const materializedRows = await Promise.all(
			rows.map((row) => materializePublicationRow(context.database, row))
		);
		for (const row of materializedRows) mapScopeMeta(row);
		const latest = materializedRows[0] ?? null;
		if (
			latest &&
			(Number(latest.event_id) !== latestFinalizedEventId ||
				String(latest.revision) !== String(latestHead.revision) ||
				latest.content_sha256 !== latestHead.content_sha256)
		) {
			throw integrityError("Review season payload does not match the observed publication head");
		}
		const payloadFinalizedEventIds = parseFinalizedEventIds(latest?.finalized_event_ids);
		if (
			payloadFinalizedEventIds !== null &&
			JSON.stringify(payloadFinalizedEventIds) !== JSON.stringify(finalizedEventIds)
		) {
			throw integrityError("Review season payload event window does not match finalized events");
		}
		if (!latest) throw integrityError("Review season publication row is missing");
		const latestMeta = mapScopeMeta(latest);
		const latestFormat = latestMeta.format;
		if (!latestFormat) throw integrityError("Latest review format is invalid");
		const season: MyTournamentSeasonReview = {
			state: "READY",
			tournamentId: args.tournamentId,
			throughEventId: args.throughEventId,
			latestEventId: Number(latest.event_id),
			latestRevision: String(latest.revision),
			format: latestFormat,
			freshness: latestMeta.freshness,
			finalizedEventIds,
			points: latestFormat === "POINTS" ? pointsFromPayload(latest, first, cursor, "SEASON") : null,
			h2h: latestFormat === "H2H" ? h2hFromPayload(latest, first, cursor) : null,
			knockout: latestFormat === "KNOCKOUT" ? knockoutFromPayload(latest, first, cursor) : null,
			semanticSha256: latestMeta.contentSha256,
			phases: phaseDescriptors ?? [],
		};
		await writeJsonQueryCache(context, key, season, REVIEW_CACHE_TTL_SECONDS);
		return season;
	},

	async loadSeasonReviewSection(context, args) {
		validateReviewEventId(args.throughEventId, "throughEventId");
		if (!args.phaseId.trim() || !args.semanticSha256.trim() || !/^\d+$/.test(args.revision)) {
			throw new GraphQLError("phaseId, revision, and semanticSha256 are required", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const phaseId = args.phaseId.trim();
		const first = boundedFirst(args.first, 50);
		const requestedSection = args.section;
		const expectedFormat = requestedSection.startsWith("POINTS")
			? "POINTS"
			: requestedSection.startsWith("H2H")
				? "H2H"
				: "KNOCKOUT";
		// Season is the phase index.  Loading it without a section cursor gives us
		// the immutable end-event/revision/hash for every completed phase while
		// keeping the section read itself pinned to the requested phase rather
		// than accidentally projecting only the latest format.
		const season = await this.loadSeasonReview(context, {
			tournamentId: args.tournamentId,
			throughEventId: args.throughEventId,
			first: 1,
			after: null,
		});
		const phase = season.phases?.find((candidate) => candidate.phaseId === phaseId) ?? null;
		if (!phase) {
			throw new GraphQLError("Review phase is not available for this tournament", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		if (phase.format !== expectedFormat) {
			throw new GraphQLError("Review section does not belong to the requested phase", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		if (phase.state !== "READY" || phase.revision === null || phase.semanticSha256 === null) {
			return {
				state: phase.state,
				tournamentId: args.tournamentId,
				throughEventId: args.throughEventId,
				phaseId,
				section: args.section,
				revision: args.revision,
				semanticSha256: args.semanticSha256,
				points: null,
				h2h: null,
				knockout: null,
				pageInfo: { hasNextPage: false, endCursor: null },
			};
		}
		if (String(phase.revision) !== args.revision || phase.semanticSha256 !== args.semanticSha256) {
			throw new GraphQLError("Review section revision does not match the active publication", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const phaseIdentity = {
			season_id: context.currentSeason.seasonId,
			tournament_id: args.tournamentId,
			event_id: phase.endEventId,
			revision: phase.revision,
			format: phase.format,
		};
		const sectionCursorScope = reviewSectionCursorScope(
			phaseIdentity,
			phaseId,
			requestedSection,
			phase.semanticSha256
		);
		const cursor = decodeCursor(args.after, String(phase.revision), sectionCursorScope);
		const expectedCache: SeasonSectionCacheExpectation = {
			tournamentId: args.tournamentId,
			throughEventId: args.throughEventId,
			phaseId,
			section: requestedSection,
			revision: String(phase.revision),
			semanticSha256: phase.semanticSha256,
		};
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2.1:season-section:${args.tournamentId}:${args.throughEventId}:${phaseId}:${requestedSection}:${expectedCache.revision}:${expectedCache.semanticSha256}:${first}:${cursor?.canonical ?? ""}`,
			expectedCache.semanticSha256
		);
		const cached = await readJsonQueryCache(context, key, (value) =>
			cacheDecoder<MyTournamentSeasonSection>(value, (candidate) =>
				seasonSectionCache(candidate, expectedCache)
			)
		);
		if (cached) return cached;
		const headRow = await context.database.query<PublicationRow>(
			MY_TOURNAMENT_REVIEW_PUBLICATION_SQL,
			[
				context.currentSeason.seasonId,
				args.tournamentId,
				phase.endEventId,
				phase.revision,
				phase.semanticSha256,
			]
		);
		const row = headRow.rows[0] ?? null;
		if (!row) {
			throw integrityError("Review phase publication disappeared during read");
		}
		const materializedRow = await materializePublicationRow(context.database, row);
		const scope = mapScopeMeta(materializedRow);
		if (scope.format !== expectedFormat) {
			throw integrityError("Review phase publication format does not match its phase");
		}
		const points =
			expectedFormat === "POINTS"
				? pointsFromPayload(materializedRow, first, cursor, "SEASON", sectionCursorScope)
				: null;
		const h2hSection =
			requestedSection === "H2H_STANDINGS" || requestedSection === "H2H_FIXTURES"
				? requestedSection
				: undefined;
		const h2h =
			expectedFormat === "H2H"
				? h2hFromPayload(materializedRow, first, cursor, h2hSection, sectionCursorScope)
				: null;
		const knockout =
			expectedFormat === "KNOCKOUT"
				? knockoutFromPayload(materializedRow, first, cursor, sectionCursorScope)
				: null;
		if (points === null && h2h === null && knockout === null) {
			throw new GraphQLError("Review section is not available for this phase", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const page = points ?? h2h ?? knockout;
		const result: MyTournamentSeasonSection = {
			state: "READY",
			tournamentId: args.tournamentId,
			throughEventId: args.throughEventId,
			phaseId,
			section: requestedSection,
			revision: String(phase.revision),
			semanticSha256: phase.semanticSha256,
			points,
			h2h,
			knockout,
			pageInfo: {
				hasNextPage: Boolean(page?.hasNextPage),
				endCursor: page?.nextCursor ?? null,
			},
		};
		await writeJsonQueryCache(context, key, result, REVIEW_CACHE_TTL_SECONDS);
		return result;
	},

	async loadStatus(context, tournamentId) {
		// Keep the obligation rows and finalized checkpoint in one SQL statement.
		// A pair of pooled reads can observe a new finalized event between
		// statements and return a status that never existed at one database
		// snapshot (for example, READY rows paired with a later checkpoint).
		const result = await context.database.query<ObligationRow>(MY_TOURNAMENT_REVIEW_STATUS_SQL, [
			context.currentSeason.seasonId,
			tournamentId,
		]);
		const finalizedValues = result.rows.map((row) => row.latest_finalized_event_id);
		if (finalizedValues.some((value) => value === undefined)) {
			throw integrityError("Review status finalized checkpoint is missing");
		}
		const latestFinalizedEventId = finalizedValues[0] ?? null;
		if (finalizedValues.some((value) => value !== latestFinalizedEventId)) {
			throw integrityError("Review status finalized checkpoint is inconsistent");
		}
		if (
			latestFinalizedEventId !== null &&
			latestFinalizedEventId !== undefined &&
			positiveInt(latestFinalizedEventId) === null
		) {
			throw integrityError("Latest finalized review event metadata is invalid");
		}
		const events = result.rows
			.filter((row) => row.event_id !== null)
			.map((row) => {
				const eventId = positiveInt(row.event_id);
				const format = reviewFormat(row.format);
				const state = reviewState(row.state);
				const executionAttempts =
					row.execution_attempts === null ? NaN : Number(row.execution_attempts);
				const sourceRechecks = row.source_rechecks === null ? NaN : Number(row.source_rechecks);
				const revision = row.revision === null ? null : positiveInt(row.revision);
				const publishedAt = iso(row.published_at);
				const nextAttemptAt = iso(row.next_attempt_at);
				const degradedAt = iso(row.degraded_at);
				if (
					!eventId ||
					!format ||
					state === "UNAVAILABLE" ||
					!Number.isSafeInteger(executionAttempts) ||
					executionAttempts < 0 ||
					!Number.isSafeInteger(sourceRechecks) ||
					sourceRechecks < 0 ||
					(row.revision !== null && revision === null) ||
					(row.revision === null && publishedAt !== null) ||
					(state === "READY" && (revision === null || publishedAt === null)) ||
					(state !== "READY" && (revision !== null || publishedAt !== null)) ||
					(row.published_at !== null && publishedAt === null) ||
					(row.next_attempt_at !== null && nextAttemptAt === null) ||
					(row.degraded_at !== null && degradedAt === null)
				) {
					throw integrityError("Review obligation metadata is invalid");
				}
				return {
					eventId,
					format,
					state,
					nextAttemptAt,
					executionAttempts,
					sourceRechecks,
					degradedAt,
					revision: revision === null ? null : String(revision),
					publishedAt,
				};
			});
		const finalizedEventId =
			latestFinalizedEventId === null || latestFinalizedEventId === undefined
				? null
				: positiveInt(latestFinalizedEventId);
		if (
			finalizedEventId !== null &&
			events.some((event) => event.eventId > finalizedEventId && event.state === "READY")
		) {
			throw integrityError("Review status contains a READY event beyond the finalized window");
		}
		const status: MyTournamentReviewStatus = {
			tournamentId,
			latestFinalizedEventId: finalizedEventId,
			events,
		};
		return status;
	},
});

export const myTournamentReviewRepository = createMyTournamentReviewRepository();
