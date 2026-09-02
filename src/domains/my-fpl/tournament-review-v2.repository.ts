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
	/** Internal Redis witness. GraphQL ignores unknown object properties, while
	 * the cache decoder uses the immutable chunk sequence to authenticate the
	 * requested page before returning it. Only chunks intersecting this page
	 * are retained; the complete section is never copied into Redis. */
	__sectionWitness?: {
		pageOffset: number;
		sourceRows: unknown[];
		chunkIndexes: number[];
		chunkHashes: string[];
		chunkItemCounts: number[];
	};
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
	/** Section-page cache entries retain only page rows. Gameweek caches keep
	 * this false/omitted and continue to carry the complete aggregate witness. */
	pageOnly?: boolean;
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
	/** Full-scope witness for Gameweek caches or compact page witness for Season sections. */
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
	/** Full-scope witness for Gameweek caches or compact page witness for Season sections. */
	coverageWitness: MyTournamentReviewH2HCoverageWitness;
};

type MyTournamentReviewH2HCoverageWitness = {
	/** Section-page cache entries retain only page coverage. */
	pageOnly?: boolean;
	matchIdentities: string[];
	matchParticipantIdentities: string[];
	/** Participant identities in match order; entries may repeat across rounds. */
	matchParticipantIdentitiesByMatch: string[][];
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
	/** Internal immutable coverage witness used to validate cached pages. */
	coverageWitness: {
		/** Section-page cache entries retain only page coverage. */
		pageOnly?: boolean;
		matchIdentities: string[];
		entryIdentities: string[];
		applicableEntryIdentities: string[];
		notApplicableEntryIdentities: string[];
		pageOffset: number;
		pageMatchIdentities: string[];
	};
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
		rowCount?: number | null;
		expectedSubjectCount?: number | null;
		readySubjectCount?: number | null;
		notApplicableSubjectCount?: number | null;
		/** Internal-only manifest witness; never exposed as a GraphQL field. */
		sectionChunkHashes?: Partial<Record<MyTournamentReviewSeasonSection, string[]>>;
		/** Exact producer chunk boundaries for section-page authentication. */
		sectionChunkItemCounts?: Partial<Record<MyTournamentReviewSeasonSection, number[]>>;
		/** Authenticated aggregate shell used to validate cached Season pages. */
		pointsAggregateSummary?: ReviewPointsAggregateSummary;
	}>;
	/** Internal publication identity used by the V2.1 resolver adapter. */
	semanticSha256?: string | null;
};

type ReviewPointsAggregateSummary = {
	grossPointsTotal: number;
	grossPointsAverage: number;
	netPointsTotal: number;
	seasonGrossPointsTotal: number;
	seasonGrossPointsAverage: number;
	seasonNetPointsTotal: number;
};

export type MyTournamentReviewEventStatus = {
	eventId: number;
	format: MyTournamentReviewFormat;
	state: MyTournamentReviewState;
	eligibleAt: string | null;
	readyAt: string | null;
	observedAt: string | null;
	nextAttemptAt: string | null;
	executionAttempts: number;
	sourceRechecks: number;
	degradedAt: string | null;
	revision: string | null;
	publishedAt: string | null;
	repairState: "NONE" | "OPEN";
	errorCode: string | null;
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
	points_phase_state: string | null;
	h2h_phase_state: string | null;
	knockout_phase_state: string | null;
	latest_ready_event_id: number | null;
	latest_revision: number | string | null;
	latest_format: string | null;
	latest_state: string | null;
	published_at: Date | string | null;
	setup_status: string | null;
	previous_ready_event_id: number | null;
	finalized_format: string | null;
	finalized_state: string | null;
	finalized_eligible_at: Date | string | null;
	finalized_ready_at: Date | string | null;
	finalized_observed_at: Date | string | null;
	finalized_next_attempt_at: Date | string | null;
	finalized_execution_attempts: number | null;
	finalized_source_rechecks: number | null;
	finalized_degraded_at: Date | string | null;
	finalized_revision: number | string | null;
	finalized_published_at: Date | string | null;
	finalized_repair_issue_id: number | string | null;
	finalized_error_code: string | null;
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
	/** Internal producer chunk rows retained only while building a cache witness. */
	__chunkRows?: PublicationChunkRow[];
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
	eligible_at: Date | string | null;
	ready_at: Date | string | null;
	last_observed_at: Date | string | null;
	next_attempt_at: Date | string | null;
	execution_attempts: number | null;
	source_rechecks: number | null;
	degraded_at: Date | string | null;
	revision: number | string | null;
	published_at: Date | string | null;
	repair_issue_id: number | string | null;
	last_error_code: string | null;
	latest_finalized_event_id: number | null;
};

/**
 * SQL-side publication witness shared by catalog, status, Gameweek, and
 * Season metadata reads.  A READY obligation is not a readable snapshot until
 * the active head, publication manifest, and every immutable chunk agree.
 * Keep this check at the metadata boundary so a cache key can never be minted
 * for a partial publication.
 */
function reviewPublicationCoherenceSql(publicationAlias: string, eventAlias: string): string {
	return `
  AND jsonb_typeof(${publicationAlias}.payload) = 'object'
  AND ${publicationAlias}.schema_version = 'my-tournament-review-v2.1'
  AND ${publicationAlias}.metric_version = 'settled-review-v2'
  AND ${publicationAlias}.payload->>'schemaVersion' = ${publicationAlias}.schema_version
  AND ${publicationAlias}.payload->>'metricVersion' = ${publicationAlias}.metric_version
  AND ${publicationAlias}.payload->>'format' = ${publicationAlias}.format
  AND ${publicationAlias}.content_sha256 ~ '^[0-9a-f]{64}$'
	AND CASE
	      WHEN jsonb_typeof(${publicationAlias}.payload) = 'object' THEN
	        ${publicationAlias}.content_sha256 = encode(
	          extensions.digest(
	            convert_to(
	              (
	                extensions.strip_review_operational_metadata(${publicationAlias}.payload)::text
	                || E'\\n' ||
	                COALESCE(
	                  (
	                    SELECT string_agg(chunk.chunk_sha256, E'\\n' ORDER BY chunk.section_key, chunk.chunk_index)
	                    FROM competition.tournament_review_publication_chunks chunk
	                    WHERE chunk.season_id = ${publicationAlias}.season_id
	                      AND chunk.tournament_id = ${publicationAlias}.tournament_id
	                      AND chunk.event_id = ${publicationAlias}.event_id
	                      AND chunk.revision = ${publicationAlias}.revision
	                  ),
	                  ''
	                )
	              ),
	              'UTF8'
	            ),
	            'sha256'
	          ),
	          'hex'
	        )
	      ELSE false
	    END
  AND jsonb_typeof(${publicationAlias}.payload->'manifest') = 'object'
  AND jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
  AND ${publicationAlias}.payload->'manifest'->>'sectionCount' ~ '^[0-9]{1,18}$'
  AND ${publicationAlias}.payload->'manifest'->>'chunkCount' ~ '^[0-9]{1,18}$'
  AND (CASE
         WHEN ${publicationAlias}.payload->'manifest'->>'sectionCount' ~ '^[0-9]{1,18}$'
         THEN (${publicationAlias}.payload->'manifest'->>'sectionCount')::numeric
         ELSE -1
       END) = jsonb_array_length(CASE
         WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
         THEN ${publicationAlias}.payload->'manifest'->'sections'
         ELSE '[]'::jsonb
       END)
  AND (CASE
         WHEN ${publicationAlias}.format IN ('POINTS', 'H2H') THEN
           CASE
             WHEN ${publicationAlias}.payload->'manifest'->>'sectionCount' ~ '^[0-9]{1,18}$'
             THEN (${publicationAlias}.payload->'manifest'->>'sectionCount')::numeric = 2
             ELSE false
           END
         WHEN ${publicationAlias}.format = 'KNOCKOUT' THEN
           CASE
             WHEN ${publicationAlias}.payload->'manifest'->>'sectionCount' ~ '^[0-9]{1,18}$'
             THEN (${publicationAlias}.payload->'manifest'->>'sectionCount')::numeric = 1
             ELSE false
           END
         ELSE false
       END)
  AND (
    (${publicationAlias}.format = 'POINTS' AND (
      SELECT count(*)
	      FROM jsonb_array_elements(CASE
	        WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	        THEN ${publicationAlias}.payload->'manifest'->'sections'
	        ELSE '[]'::jsonb
	      END) descriptor
      WHERE descriptor->>'sectionKey' IN ('POINTS_STANDINGS', 'POINTS_TRAJECTORIES')
    ) = 2)
    OR (${publicationAlias}.format = 'H2H' AND (
      SELECT count(*)
	      FROM jsonb_array_elements(CASE
	        WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	        THEN ${publicationAlias}.payload->'manifest'->'sections'
	        ELSE '[]'::jsonb
	      END) descriptor
      WHERE descriptor->>'sectionKey' IN ('H2H_STANDINGS', 'H2H_FIXTURES')
	    ) = 2)
	    OR (${publicationAlias}.format = 'KNOCKOUT' AND (
	      SELECT count(*)
	      FROM jsonb_array_elements(CASE
	        WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	        THEN ${publicationAlias}.payload->'manifest'->'sections'
	        ELSE '[]'::jsonb
	      END) descriptor
	      WHERE descriptor->>'sectionKey' = 'KNOCKOUT_BRACKET'
	    ) = 1)
	  )
	  AND ${publicationAlias}.row_count > 0
	  AND ${publicationAlias}.expected_subject_count > 0
	  AND ${publicationAlias}.ready_subject_count >= 0
	  AND ${publicationAlias}.not_applicable_subject_count >= 0
	  AND ${publicationAlias}.ready_subject_count + ${publicationAlias}.not_applicable_subject_count = ${publicationAlias}.expected_subject_count
	  AND ${publicationAlias}.ready_subject_count <= ${publicationAlias}.expected_subject_count
	  AND CASE
	        WHEN ${publicationAlias}.format = 'POINTS' THEN
	          ${publicationAlias}.row_count = ${publicationAlias}.expected_subject_count
	          AND ${publicationAlias}.row_count = (
	            SELECT CASE
	                     WHEN descriptor->>'itemCount' ~ '^[0-9]{1,18}$'
	                     THEN (descriptor->>'itemCount')::numeric
	                     ELSE -1
	                   END
	            FROM jsonb_array_elements(CASE
	              WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	              THEN ${publicationAlias}.payload->'manifest'->'sections'
	              ELSE '[]'::jsonb
	            END) descriptor
	            WHERE descriptor->>'sectionKey' = 'POINTS_STANDINGS'
	            LIMIT 1
	          )
	          AND ${publicationAlias}.row_count = (
	            SELECT CASE
	                     WHEN descriptor->>'itemCount' ~ '^[0-9]{1,18}$'
	                     THEN (descriptor->>'itemCount')::numeric
	                     ELSE -1
	                   END
	            FROM jsonb_array_elements(CASE
	              WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	              THEN ${publicationAlias}.payload->'manifest'->'sections'
	              ELSE '[]'::jsonb
	            END) descriptor
	            WHERE descriptor->>'sectionKey' = 'POINTS_TRAJECTORIES'
	            LIMIT 1
	          )
	        WHEN ${publicationAlias}.format = 'H2H' THEN
	          ${publicationAlias}.row_count = (
	            SELECT CASE
	                     WHEN descriptor->>'itemCount' ~ '^[0-9]{1,18}$'
	                     THEN (descriptor->>'itemCount')::numeric
	                     ELSE -1
	                   END
	            FROM jsonb_array_elements(CASE
	              WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	              THEN ${publicationAlias}.payload->'manifest'->'sections'
	              ELSE '[]'::jsonb
	            END) descriptor
	            WHERE descriptor->>'sectionKey' = 'H2H_FIXTURES'
	            LIMIT 1
	          )
	          AND ${publicationAlias}.expected_subject_count = (
	            SELECT CASE
	                     WHEN descriptor->>'itemCount' ~ '^[0-9]{1,18}$'
	                     THEN (descriptor->>'itemCount')::numeric
	                     ELSE -1
	                   END
	            FROM jsonb_array_elements(CASE
	              WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	              THEN ${publicationAlias}.payload->'manifest'->'sections'
	              ELSE '[]'::jsonb
	            END) descriptor
	            WHERE descriptor->>'sectionKey' = 'H2H_STANDINGS'
	            LIMIT 1
	          )
	        WHEN ${publicationAlias}.format = 'KNOCKOUT' THEN
	          ${publicationAlias}.row_count = (
	            SELECT CASE
	                     WHEN descriptor->>'itemCount' ~ '^[0-9]{1,18}$'
	                     THEN (descriptor->>'itemCount')::numeric
	                     ELSE -1
	                   END
	            FROM jsonb_array_elements(CASE
	              WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
	              THEN ${publicationAlias}.payload->'manifest'->'sections'
	              ELSE '[]'::jsonb
	            END) descriptor
	            WHERE descriptor->>'sectionKey' = 'KNOCKOUT_BRACKET'
	            LIMIT 1
	          )
	        ELSE false
	      END
	  AND NOT EXISTS (
    SELECT 1
    FROM (
      SELECT descriptor->>'sectionKey' AS section_key, count(*) AS descriptor_count
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
        THEN ${publicationAlias}.payload->'manifest'->'sections'
        ELSE '[]'::jsonb
      END) descriptor
      GROUP BY descriptor->>'sectionKey'
      HAVING count(*) > 1
    ) duplicate_sections
  )
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
      THEN ${publicationAlias}.payload->'manifest'->'sections'
      ELSE '[]'::jsonb
    END) descriptor
    WHERE NOT (
      (${publicationAlias}.format = 'POINTS'
        AND descriptor->>'sectionKey' IN ('POINTS_STANDINGS', 'POINTS_TRAJECTORIES'))
      OR (${publicationAlias}.format = 'H2H'
        AND descriptor->>'sectionKey' IN ('H2H_STANDINGS', 'H2H_FIXTURES'))
      OR (${publicationAlias}.format = 'KNOCKOUT'
        AND descriptor->>'sectionKey' = 'KNOCKOUT_BRACKET')
    )
  )
  AND (CASE
         WHEN ${publicationAlias}.payload->'manifest'->>'chunkCount' ~ '^[0-9]{1,18}$'
         THEN (${publicationAlias}.payload->'manifest'->>'chunkCount')::numeric
         ELSE -1
       END) = (
    SELECT count(*)::numeric
    FROM competition.tournament_review_publication_chunks chunk
    WHERE chunk.season_id = ${publicationAlias}.season_id
      AND chunk.tournament_id = ${publicationAlias}.tournament_id
      AND chunk.event_id = ${publicationAlias}.event_id
      AND chunk.revision = ${publicationAlias}.revision
  )
  AND (
    SELECT COALESCE(
      sum(CASE
        WHEN descriptor->>'chunkCount' ~ '^[0-9]{1,18}$'
        THEN (descriptor->>'chunkCount')::numeric
        ELSE 0
      END),
      0
    )::numeric
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
      THEN ${publicationAlias}.payload->'manifest'->'sections'
      ELSE '[]'::jsonb
    END) descriptor
  ) = CASE
         WHEN ${publicationAlias}.payload->'manifest'->>'chunkCount' ~ '^[0-9]{1,18}$'
        THEN (${publicationAlias}.payload->'manifest'->>'chunkCount')::numeric
        ELSE -1
      END
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(${publicationAlias}.payload->'manifest'->'sections') = 'array'
      THEN ${publicationAlias}.payload->'manifest'->'sections'
      ELSE '[]'::jsonb
    END) descriptor
    WHERE jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
       OR jsonb_typeof(descriptor->'sectionKey') IS DISTINCT FROM 'string'
       OR descriptor->>'sectionKey' IS NULL
       OR btrim(COALESCE(descriptor->>'sectionKey', '')) = ''
       OR descriptor->>'chunkCount' IS NULL
       OR descriptor->>'chunkCount' !~ '^[0-9]{1,18}$'
       OR descriptor->>'itemCount' IS NULL
       OR descriptor->>'itemCount' !~ '^[0-9]{1,18}$'
       OR jsonb_typeof(descriptor->'chunkHashes') IS DISTINCT FROM 'array'
       OR jsonb_typeof(descriptor->'chunkItemCounts') IS DISTINCT FROM 'array'
       OR (CASE
             WHEN descriptor->>'chunkCount' ~ '^[0-9]{1,18}$'
             THEN (descriptor->>'chunkCount')::numeric
             ELSE -1
           END) <> jsonb_array_length(CASE
             WHEN jsonb_typeof(descriptor->'chunkHashes') = 'array'
             THEN descriptor->'chunkHashes'
             ELSE '[]'::jsonb
           END)
       OR (CASE
             WHEN descriptor->>'chunkCount' ~ '^[0-9]{1,18}$'
             THEN (descriptor->>'chunkCount')::numeric
             ELSE -1
           END) <> jsonb_array_length(CASE
             WHEN jsonb_typeof(descriptor->'chunkItemCounts') = 'array'
             THEN descriptor->'chunkItemCounts'
             ELSE '[]'::jsonb
           END)
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(CASE
           WHEN jsonb_typeof(descriptor->'chunkItemCounts') = 'array'
           THEN descriptor->'chunkItemCounts'
           ELSE '[]'::jsonb
         END) item_count
         WHERE jsonb_typeof(item_count) IS DISTINCT FROM 'number'
            OR CASE
                 WHEN jsonb_typeof(item_count) = 'number'
                 THEN CASE
                        WHEN item_count::text ~ '^[0-9]{1,3}$'
                        THEN (item_count::text)::numeric NOT BETWEEN 0 AND 100
                        ELSE true
                      END
                 ELSE true
               END
       )
       OR (
         descriptor->>'itemCount' <> '0'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(CASE
             WHEN jsonb_typeof(descriptor->'chunkItemCounts') = 'array'
             THEN descriptor->'chunkItemCounts'
             ELSE '[]'::jsonb
           END) item_count
           WHERE jsonb_typeof(item_count) = 'number'
             AND item_count::text ~ '^[0-9]{1,18}$'
             AND (item_count::text)::numeric = 0
         )
       )
       OR (CASE
             WHEN descriptor->>'chunkCount' ~ '^[0-9]{1,18}$'
             THEN (descriptor->>'chunkCount')::numeric
             ELSE -1
           END) <> (
         SELECT count(*)::numeric
         FROM competition.tournament_review_publication_chunks chunk
         WHERE chunk.season_id = ${publicationAlias}.season_id
           AND chunk.tournament_id = ${publicationAlias}.tournament_id
           AND chunk.event_id = ${publicationAlias}.event_id
           AND chunk.revision = ${publicationAlias}.revision
           AND chunk.section_key = descriptor->>'sectionKey'
       )
       OR (CASE
             WHEN descriptor->>'itemCount' ~ '^[0-9]{1,18}$'
             THEN (descriptor->>'itemCount')::numeric
             ELSE -1
           END) <> (
         SELECT COALESCE(sum(chunk.item_count), 0)::numeric
         FROM competition.tournament_review_publication_chunks chunk
         WHERE chunk.season_id = ${publicationAlias}.season_id
           AND chunk.tournament_id = ${publicationAlias}.tournament_id
           AND chunk.event_id = ${publicationAlias}.event_id
           AND chunk.revision = ${publicationAlias}.revision
           AND chunk.section_key = descriptor->>'sectionKey'
       )
       OR (
         SELECT COALESCE(min(chunk.chunk_index), -1)
         FROM competition.tournament_review_publication_chunks chunk
         WHERE chunk.season_id = ${publicationAlias}.season_id
           AND chunk.tournament_id = ${publicationAlias}.tournament_id
           AND chunk.event_id = ${publicationAlias}.event_id
           AND chunk.revision = ${publicationAlias}.revision
           AND chunk.section_key = descriptor->>'sectionKey'
       ) <> CASE
         WHEN descriptor->>'chunkCount' ~ '^[0-9]{1,18}$'
              AND (descriptor->>'chunkCount')::numeric > 0 THEN 0
         ELSE -1
       END
       OR (
         SELECT COALESCE(max(chunk.chunk_index), -1)
         FROM competition.tournament_review_publication_chunks chunk
         WHERE chunk.season_id = ${publicationAlias}.season_id
           AND chunk.tournament_id = ${publicationAlias}.tournament_id
           AND chunk.event_id = ${publicationAlias}.event_id
           AND chunk.revision = ${publicationAlias}.revision
           AND chunk.section_key = descriptor->>'sectionKey'
       ) <> (CASE
         WHEN (descriptor->>'chunkCount') ~ '^[0-9]{1,18}$'
         THEN (descriptor->>'chunkCount')::numeric - 1
         ELSE -1
       END)
       OR (
         SELECT COALESCE(jsonb_agg(chunk.chunk_sha256 ORDER BY chunk.chunk_index), '[]'::jsonb)
         FROM competition.tournament_review_publication_chunks chunk
         WHERE chunk.season_id = ${publicationAlias}.season_id
           AND chunk.tournament_id = ${publicationAlias}.tournament_id
           AND chunk.event_id = ${publicationAlias}.event_id
           AND chunk.revision = ${publicationAlias}.revision
           AND chunk.section_key = descriptor->>'sectionKey'
       ) IS DISTINCT FROM descriptor->'chunkHashes'
       OR (
         SELECT COALESCE(jsonb_agg(to_jsonb(chunk.item_count) ORDER BY chunk.chunk_index), '[]'::jsonb)
         FROM competition.tournament_review_publication_chunks chunk
         WHERE chunk.season_id = ${publicationAlias}.season_id
           AND chunk.tournament_id = ${publicationAlias}.tournament_id
           AND chunk.event_id = ${publicationAlias}.event_id
           AND chunk.revision = ${publicationAlias}.revision
           AND chunk.section_key = descriptor->>'sectionKey'
       ) IS DISTINCT FROM descriptor->'chunkItemCounts'
       OR (
         descriptor->>'itemCount' = '0'
         AND (
           (CASE
             WHEN descriptor->>'chunkCount' ~ '^[0-9]{1,18}$'
             THEN (descriptor->>'chunkCount')::numeric
             ELSE -1
           END) <> 1
           OR (CASE
             WHEN jsonb_typeof(descriptor->'chunkHashes') = 'array'
             THEN jsonb_array_length(descriptor->'chunkHashes')
             ELSE -1
           END) <> 1
           OR (CASE
             WHEN jsonb_typeof(descriptor->'chunkItemCounts') = 'array'
             THEN jsonb_array_length(descriptor->'chunkItemCounts')
             ELSE -1
           END) <> 1
         )
       )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM competition.tournament_review_publication_chunks chunk
    WHERE chunk.season_id = ${publicationAlias}.season_id
      AND chunk.tournament_id = ${publicationAlias}.tournament_id
      AND chunk.event_id = ${publicationAlias}.event_id
      AND chunk.revision = ${publicationAlias}.revision
      AND (
        chunk.chunk_index < 0
        OR chunk.item_count < 0
        OR chunk.item_count > 100
        OR jsonb_typeof(chunk.items) IS DISTINCT FROM 'array'
        OR (CASE
              WHEN jsonb_typeof(chunk.items) = 'array'
              THEN jsonb_array_length(chunk.items)
              ELSE -1
            END) <> chunk.item_count
        OR chunk.chunk_sha256 <> encode(
             extensions.digest(convert_to(chunk.items::text, 'UTF8'), 'sha256'), 'hex'
           )
      )
  )
  AND ${eventAlias}.finished = true
	AND ${eventAlias}.data_checked = true
	AND ${eventAlias}.data_checked_at IS NOT NULL
		AND ${publicationAlias}.event_data_checked_at <= ${publicationAlias}.source_min_checked_at
		AND ${publicationAlias}.source_min_checked_at <= ${publicationAlias}.source_max_checked_at
	AND ${publicationAlias}.source_max_checked_at <= ${publicationAlias}.published_at
	AND date_trunc('milliseconds', ${publicationAlias}.event_data_checked_at) =
      date_trunc('milliseconds', ${eventAlias}.data_checked_at)
`;
}

function reviewPhaseStateJoinSql(
	format: "POINTS" | "H2H" | "KNOCKOUT",
	phasePredicate: string,
	alias: string
): string {
	return `
	LEFT JOIN LATERAL (
		SELECT CASE
		         WHEN phase_event.event_id IS NULL THEN 'NOT_STARTED'
		         WHEN phase_obligation.state = 'READY' AND phase_head.revision IS NOT NULL THEN 'READY'
		         WHEN phase_obligation.state = 'READY' THEN 'DEGRADED'
		         ELSE COALESCE(phase_obligation.state, 'UNAVAILABLE')
		       END AS state
		FROM (
			SELECT max(event.event_id)::integer AS event_id
			FROM fpl.events event
			WHERE event.season_id = tournament.season_id
			  AND event.finished = true
			  AND event.data_checked = true
			  AND event.data_checked_at IS NOT NULL
			  AND (${phasePredicate})
		) phase_event
		LEFT JOIN LATERAL (
			SELECT obligation.state
			FROM competition.tournament_review_obligations obligation
			WHERE obligation.season_id = tournament.season_id
			  AND obligation.tournament_id = tournament.tournament_id
			  AND obligation.event_id = phase_event.event_id
			  AND obligation.format = '${format}'
			LIMIT 1
		) phase_obligation ON true
		LEFT JOIN LATERAL (
			SELECT review_head.revision
			FROM competition.tournament_review_heads review_head
			JOIN competition.tournament_review_publications phase_publication
			  ON phase_publication.season_id = review_head.season_id
			 AND phase_publication.tournament_id = review_head.tournament_id
			 AND phase_publication.event_id = review_head.event_id
			 AND phase_publication.revision = review_head.revision
			 AND phase_publication.content_sha256 = review_head.content_sha256
			JOIN competition.tournament_review_obligations phase_ready_obligation
			  ON phase_ready_obligation.season_id = phase_publication.season_id
			 AND phase_ready_obligation.tournament_id = phase_publication.tournament_id
			 AND phase_ready_obligation.event_id = phase_publication.event_id
			 AND phase_ready_obligation.format = phase_publication.format
			 AND phase_ready_obligation.state = 'READY'
			 AND phase_ready_obligation.ready_revision = review_head.revision
			JOIN fpl.events phase_head_event
			  ON phase_head_event.season_id = phase_publication.season_id
			 AND phase_head_event.event_id = phase_publication.event_id
			WHERE review_head.season_id = tournament.season_id
			  AND review_head.tournament_id = tournament.tournament_id
			  AND review_head.event_id = phase_event.event_id
			  AND phase_publication.format = '${format}'
			  ${reviewPublicationCoherenceSql("phase_publication", "phase_head_event")}
			LIMIT 1
		) phase_head ON true
	) ${alias} ON true
`;
}

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
	       points_phase.state AS points_phase_state,
	       h2h_phase.state AS h2h_phase_state,
	       knockout_phase.state AS knockout_phase_state,
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
	          AND head.latest_ready_event_id = finalized.latest_finalized_event_id
	          AND head.latest_revision = finalized_obligation.ready_revision
	          AND head.latest_format = finalized_obligation.format THEN 'READY'
	         WHEN finalized_obligation.state = 'READY' THEN 'DEGRADED'
	         ELSE COALESCE(finalized_obligation.state, 'UNAVAILABLE')
		       END AS finalized_state,
		       finalized_obligation.eligible_at AS finalized_eligible_at,
		       finalized_obligation.ready_at AS finalized_ready_at,
		       finalized_obligation.last_observed_at AS finalized_observed_at,
		       finalized_obligation.next_attempt_at AS finalized_next_attempt_at,
		       finalized_obligation.execution_attempts AS finalized_execution_attempts,
		       finalized_obligation.source_rechecks AS finalized_source_rechecks,
		       finalized_obligation.degraded_at AS finalized_degraded_at,
		       finalized_obligation.repair_issue_id AS finalized_repair_issue_id,
		       finalized_obligation.last_error_code AS finalized_error_code,
	       CASE
	         WHEN finalized_obligation.state = 'READY'
	          AND head.latest_ready_event_id = finalized.latest_finalized_event_id
	          AND head.latest_revision = finalized_obligation.ready_revision
	          AND head.latest_format = finalized_obligation.format
	         THEN finalized_obligation.ready_revision
	         ELSE NULL
	       END AS finalized_revision,
	       CASE
	         WHEN finalized_obligation.state = 'READY'
	          AND head.latest_ready_event_id = finalized.latest_finalized_event_id
	          AND head.latest_revision = finalized_obligation.ready_revision
	          AND head.latest_format = finalized_obligation.format
	         THEN head.published_at
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
	${reviewPhaseStateJoinSql(
		"POINTS",
		"tournament.group_mode::text = 'points_races' AND tournament.group_started_event_id IS NOT NULL AND event.event_id >= tournament.group_started_event_id AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)",
		"points_phase"
	)}
	${reviewPhaseStateJoinSql(
		"H2H",
		"tournament.group_mode::text = 'battle_races' AND tournament.group_started_event_id IS NOT NULL AND event.event_id >= tournament.group_started_event_id AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)",
		"h2h_phase"
	)}
	${reviewPhaseStateJoinSql(
		"KNOCKOUT",
		"tournament.knockout_mode::text <> 'no_knockout' AND tournament.knockout_started_event_id IS NOT NULL AND event.event_id >= tournament.knockout_started_event_id AND (tournament.knockout_ended_event_id IS NULL OR event.event_id <= tournament.knockout_ended_event_id)",
		"knockout_phase"
	)}
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
			${reviewPublicationCoherenceSql("publication", "head_event")}
		ORDER BY review_head.event_id DESC
		LIMIT 1
	) head ON true
	LEFT JOIN LATERAL (
		SELECT max(review_head.event_id)::integer AS previous_ready_event_id
		FROM competition.tournament_review_heads review_head
		JOIN competition.tournament_review_publications publication
		  ON publication.season_id = review_head.season_id
		 AND publication.tournament_id = review_head.tournament_id
		 AND publication.event_id = review_head.event_id
		 AND publication.revision = review_head.revision
		 AND publication.content_sha256 = review_head.content_sha256
			JOIN competition.tournament_review_obligations ready_obligation
			  ON ready_obligation.season_id = review_head.season_id
			 AND ready_obligation.tournament_id = review_head.tournament_id
			 AND ready_obligation.event_id = review_head.event_id
			 AND ready_obligation.format = publication.format
			 AND ready_obligation.state = 'READY'
		 AND ready_obligation.ready_revision = review_head.revision
		JOIN fpl.events previous_event
		  ON previous_event.season_id = publication.season_id
		 AND previous_event.event_id = publication.event_id
		WHERE review_head.season_id = tournament.season_id
		  AND review_head.tournament_id = tournament.tournament_id
		  AND (finalized.latest_finalized_event_id IS NULL OR review_head.event_id < finalized.latest_finalized_event_id)
		  ${reviewPublicationCoherenceSql("publication", "previous_event")}
	) previous_ready ON true
	LEFT JOIN LATERAL (
			SELECT state AS latest_state, format, eligible_at, ready_at, last_observed_at,
			       next_attempt_at, execution_attempts, source_rechecks, degraded_at,
			       ready_revision, repair_issue_id, last_error_code
		FROM competition.tournament_review_obligations review_obligation
		WHERE review_obligation.season_id = tournament.season_id
		  AND review_obligation.tournament_id = tournament.tournament_id
		  AND review_obligation.event_id = finalized.latest_finalized_event_id
		ORDER BY review_obligation.event_id DESC
		LIMIT 1
	) obligation ON true
	LEFT JOIN LATERAL (
			SELECT state, format, eligible_at, ready_at, last_observed_at,
			       next_attempt_at, execution_attempts, source_rechecks, degraded_at,
			       ready_revision, repair_issue_id, last_error_code
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
	  -- Search also accepts an exact tournament ID.  This gives an authorized
	  -- deep link a bounded lookup instead of forcing the Web server to walk an
	  -- unbounded number of keyset pages before it can render one tournament.
	  AND ($5::text IS NULL OR tournament.tournament_id::text = btrim($5::text)
	       OR tournament.name ILIKE '%' || $5::text || '%'
	       OR tournament.creator ILIKE '%' || $5::text || '%')
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
			 ${reviewPublicationCoherenceSql("publication", "event")}
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
 * Contract-probe query retained for the publication identity fixture. The
 * Season summary runtime intentionally does not execute this full-payload
 * query; immutable payloads are read only by the explicit section root.
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
		  ${reviewPublicationCoherenceSql("publication", "event")}
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
	row_count?: number | null;
	expected_subject_count?: number | null;
	ready_subject_count?: number | null;
	not_applicable_subject_count?: number | null;
};

type ValidReviewHeadRow = {
	event_id: number;
	revision: number | string;
	format: string;
	content_sha256: string;
	event_data_checked_at: Date | string;
	published_at: Date | string;
	row_count: number;
	expected_subject_count: number;
	ready_subject_count: number;
	not_applicable_subject_count: number;
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
	expected_subject_count: number | null;
	ready_subject_count: number | null;
	not_applicable_subject_count: number | null;
	manifest: unknown | null;
	points_summary: unknown | null;
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
		       publication.published_at,
		       publication.row_count,
		       publication.expected_subject_count,
		       publication.ready_subject_count,
		       publication.not_applicable_subject_count
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
		 ${reviewPublicationCoherenceSql("publication", "event")}
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
	       selected.row_count,
	       selected.expected_subject_count,
	       selected.ready_subject_count,
	       selected.not_applicable_subject_count,
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
		       publication.expected_subject_count,
		       publication.ready_subject_count,
		       publication.not_applicable_subject_count,
		       publication.payload->'manifest' AS manifest,
		       publication.payload->'points' AS points_summary
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
		WHERE true
		  ${reviewPublicationCoherenceSql("publication", "event")}
	)
	SELECT keys.event_id,
	       coherent_heads.revision,
	       coherent_heads.format,
	       coherent_heads.content_sha256,
	       coherent_heads.correction_change_id,
	       coherent_heads.event_data_checked_at,
	       coherent_heads.published_at,
	       coherent_heads.row_count,
	       coherent_heads.expected_subject_count,
	       coherent_heads.ready_subject_count,
	       coherent_heads.not_applicable_subject_count,
	       coherent_heads.manifest,
	       coherent_heads.points_summary,
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
		       CASE
		         WHEN obligation.state = 'READY' AND head.revision IS NULL THEN 'DEGRADED'
		         ELSE obligation.state
			   END AS state,
			       obligation.eligible_at,
			       obligation.ready_at,
			       obligation.last_observed_at,
			       obligation.next_attempt_at,
		       obligation.execution_attempts,
		       obligation.source_rechecks,
			       obligation.degraded_at,
			       obligation.repair_issue_id,
			       obligation.last_error_code,
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
					 ${reviewPublicationCoherenceSql("publication", "event")}
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
		       status_rows.eligible_at,
		       status_rows.ready_at,
		       status_rows.last_observed_at,
		       status_rows.next_attempt_at,
	       status_rows.execution_attempts,
	       status_rows.source_rechecks,
		       status_rows.degraded_at,
		       status_rows.repair_issue_id,
		       status_rows.last_error_code,
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

function pointsAggregateSummary(value: unknown): ReviewPointsAggregateSummary | null {
	if (!isRecord(value)) return null;
	try {
		return {
			grossPointsTotal: requiredInteger(value.grossPointsTotal, "grossPointsTotal"),
			grossPointsAverage: requiredNumber(value.grossPointsAverage, "grossPointsAverage"),
			netPointsTotal: requiredInteger(value.netPointsTotal, "netPointsTotal"),
			seasonGrossPointsTotal: requiredInteger(
				value.seasonGrossPointsTotal,
				"seasonGrossPointsTotal"
			),
			seasonGrossPointsAverage: requiredNumber(
				value.seasonGrossPointsAverage,
				"seasonGrossPointsAverage"
			),
			seasonNetPointsTotal: requiredInteger(value.seasonNetPointsTotal, "seasonNetPointsTotal"),
		};
	} catch {
		return null;
	}
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
	collection: string,
	viewerEntryId: number | null = null
): string {
	return JSON.stringify([
		row.season_id,
		row.tournament_id,
		row.event_id,
		row.format,
		collection,
		viewerEntryId,
	]);
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
	collectionOverride?: string,
	viewerEntryId: number | null = null
): ReviewCursor | null {
	const format = reviewFormat(row.format);
	if (!format) throw integrityError("Review publication format is invalid");
	return decodeCursor(
		after,
		String(row.revision),
		reviewCursorScope(
			row,
			collectionOverride ?? reviewCursorCollection(format, view),
			viewerEntryId
		)
	);
}

function reviewSectionCursorScope(
	row: Pick<PublicationRow, "season_id" | "tournament_id" | "event_id" | "format" | "revision">,
	viewerEntryId: number | null,
	phaseId: string,
	section: MyTournamentReviewSeasonSection,
	semanticSha256: string
): string {
	return reviewCursorScope(
		row,
		JSON.stringify([
			"SEASON_SECTION",
			viewerEntryId,
			phaseId,
			section,
			String(row.revision),
			semanticSha256,
		]),
		viewerEntryId
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
		const { rows: _rows, trajectoryRows: _trajectoryRows, ...points } = value.points;
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

function manifestChunkHashes(value: unknown): string[] | null {
	if (!isRecord(value) || !isRecord(value.manifest) || !Array.isArray(value.manifest.sections)) {
		return null;
	}
	const sections = value.manifest.sections as unknown[];
	const descriptors: Array<{ sectionKey: string; chunkHashes: string[] }> = [];
	for (const section of sections) {
		if (
			!isRecord(section) ||
			typeof section.sectionKey !== "string" ||
			!Array.isArray(section.chunkHashes)
		) {
			return null;
		}
		const chunkHashes = section.chunkHashes as unknown[];
		if (!chunkHashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
			return null;
		}
		descriptors.push({ sectionKey: section.sectionKey, chunkHashes: chunkHashes as string[] });
	}
	descriptors.sort((left, right) => left.sectionKey.localeCompare(right.sectionKey));
	return descriptors.flatMap((descriptor) => descriptor.chunkHashes);
}

const REVIEW_SECTION_KEYS: readonly MyTournamentReviewSeasonSection[] = [
	"POINTS_STANDINGS",
	"POINTS_TRAJECTORIES",
	"H2H_STANDINGS",
	"H2H_FIXTURES",
	"KNOCKOUT_BRACKET",
];

type ReviewSectionChunkHashMap = Partial<Record<MyTournamentReviewSeasonSection, string[]>>;
type ReviewSectionChunkItemCountMap = Partial<Record<MyTournamentReviewSeasonSection, number[]>>;

/** Extract the producer's per-section chunk witness from the lightweight
 * manifest. This is deliberately separate from the semantic SHA: a cache hit
 * must prove the page came from the exact immutable chunk sequence, not merely
 * repeat the publication identity supplied in the cache key. */
function manifestSectionChunkHashes(value: unknown): ReviewSectionChunkHashMap | null {
	if (!isRecord(value) || !Array.isArray(value.sections)) return null;
	const output: ReviewSectionChunkHashMap = {};
	for (const descriptor of value.sections) {
		if (
			!isRecord(descriptor) ||
			!REVIEW_SECTION_KEYS.includes(descriptor.sectionKey as MyTournamentReviewSeasonSection) ||
			!Array.isArray(descriptor.chunkHashes)
		) {
			return null;
		}
		const sectionKey = descriptor.sectionKey as MyTournamentReviewSeasonSection;
		if (
			output[sectionKey] !== undefined ||
			!descriptor.chunkHashes.every(
				(hash: unknown) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
			)
		) {
			return null;
		}
		output[sectionKey] = descriptor.chunkHashes as string[];
	}
	return output;
}

function manifestSectionChunkItemCounts(value: unknown): ReviewSectionChunkItemCountMap | null {
	if (!isRecord(value) || !Array.isArray(value.sections)) return null;
	const output: ReviewSectionChunkItemCountMap = {};
	for (const descriptor of value.sections) {
		if (
			!isRecord(descriptor) ||
			!REVIEW_SECTION_KEYS.includes(descriptor.sectionKey as MyTournamentReviewSeasonSection) ||
			!Array.isArray(descriptor.chunkItemCounts)
		) {
			return null;
		}
		const sectionKey = descriptor.sectionKey as MyTournamentReviewSeasonSection;
		const counts = descriptor.chunkItemCounts as unknown[];
		if (
			output[sectionKey] !== undefined ||
			!counts.every(
				(count) => Number.isSafeInteger(Number(count)) && Number(count) >= 0 && Number(count) <= 100
			)
		) {
			return null;
		}
		output[sectionKey] = counts as number[];
	}
	return output;
}

function defaultChunkLengths(rows: readonly unknown[]): number[] {
	if (rows.length === 0) return [0];
	const lengths: number[] = [];
	for (let offset = 0; offset < rows.length; offset += 100) {
		lengths.push(Math.min(100, rows.length - offset));
	}
	return lengths;
}

function chunkHashesForRows(
	rows: readonly unknown[],
	chunkLengths: readonly number[] = defaultChunkLengths(rows)
): string[] {
	if (
		chunkLengths.length === 0 ||
		chunkLengths.some((length) => !Number.isSafeInteger(length) || length < 0 || length > 100) ||
		(chunkLengths.length !== 1 && chunkLengths.some((length) => length === 0)) ||
		chunkLengths.reduce((total, length) => total + length, 0) !== rows.length
	) {
		throw integrityError("Review publication chunk lengths are invalid");
	}
	if (rows.length === 0 && chunkLengths.length !== 1) {
		throw integrityError("Review empty section chunk lengths are invalid");
	}
	const hashes: string[] = [];
	let offset = 0;
	for (const length of chunkLengths) {
		hashes.push(postgresJsonbContentHash(rows.slice(offset, offset + length)));
		offset += length;
	}
	return hashes;
}

export function tournamentReviewChunkHashes(value: unknown): string[] {
	if (!isRecord(value)) return [];
	const sections: Array<[string, unknown]> = [];
	if (value.format === "POINTS" && isRecord(value.points)) {
		sections.push(["POINTS_STANDINGS", value.points.rows]);
		sections.push([
			"POINTS_TRAJECTORIES",
			Array.isArray(value.points.trajectoryRows) ? value.points.trajectoryRows : value.points.rows,
		]);
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
	// Prefer the producer's persisted manifest order. Re-slicing a materialized
	// section at fixed 100-item boundaries would change the semantic identity if
	// a valid repair ever emits smaller chunks, even though all chunk hashes are
	// individually coherent.
	const hashes = manifestChunkHashes(value) ?? tournamentReviewChunkHashes(value);
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
	const expectedSections = new Map<
		string,
		{ itemCount: number; chunkHashes: string[]; chunkItemCounts: number[] }
	>();
	for (const value of sectionValues) {
		if (!isRecord(value) || typeof value.sectionKey !== "string") {
			throw integrityError("Review publication section descriptor is invalid");
		}
		const itemCount = Number(value.itemCount);
		const chunkCount = Number(value.chunkCount);
		const rawChunkHashes: unknown = value.chunkHashes;
		const rawChunkItemCounts: unknown = value.chunkItemCounts;
		if (
			!Number.isSafeInteger(itemCount) ||
			itemCount < 0 ||
			!Number.isSafeInteger(chunkCount) ||
			chunkCount < 0 ||
			!Array.isArray(rawChunkHashes) ||
			rawChunkHashes.length !== chunkCount ||
			!Array.isArray(rawChunkItemCounts) ||
			rawChunkItemCounts.length !== chunkCount ||
			rawChunkItemCounts.some(
				(count: unknown) =>
					!Number.isSafeInteger(Number(count)) || Number(count) < 0 || Number(count) > 100
			) ||
			rawChunkHashes.some(
				(hash: unknown) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)
			) ||
			(itemCount === 0 &&
				(chunkCount !== 1 || rawChunkHashes.length !== 1 || Number(rawChunkItemCounts[0]) !== 0)) ||
			(itemCount > 0 &&
				(rawChunkItemCounts.some((count: unknown) => Number(count) <= 0) ||
					rawChunkItemCounts.reduce((total: number, count: unknown) => total + Number(count), 0) !==
						itemCount)) ||
			expectedSections.has(value.sectionKey)
		) {
			throw integrityError("Review publication section descriptor is invalid");
		}
		const chunkHashes: string[] = rawChunkHashes.map((hash: unknown) => String(hash));
		expectedSections.set(value.sectionKey, {
			itemCount,
			chunkHashes,
			chunkItemCounts: rawChunkItemCounts.map((count: unknown) => Number(count)),
		});
	}
	if (expectedSections.size !== Number(manifest.sectionCount)) {
		throw integrityError("Review publication section count is invalid");
	}
	const declaredChunkCount = [...expectedSections.values()].reduce(
		(total, descriptor) => total + descriptor.chunkHashes.length,
		0
	);
	if (declaredChunkCount !== expectedChunkCount) {
		throw integrityError("Review publication chunk manifest total is invalid");
	}
	if (rows.some((row) => !expectedSections.has(row.section_key))) {
		throw integrityError("Review publication contains an undeclared section chunk");
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
				itemCount !== descriptor.chunkItemCounts[index] ||
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
			materialized.points =
				sectionKey === "POINTS_TRAJECTORIES"
					? { ...points, trajectoryRows: items }
					: { ...points, rows: items };
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
		__chunkRows: chunkResult.rows,
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
	expectedScope?: Pick<
		MyTournamentReviewScopeMeta,
		"rowCount" | "expectedSubjectCount" | "readySubjectCount" | "notApplicableSubjectCount"
	>,
	allowPageOnly = false
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
				typedWitness.applicableRowCount !== expectedScope.readySubjectCount ||
				typedWitness.rowCount !== expectedScope.expectedSubjectCount ||
				typedWitness.rowCount - typedWitness.applicableRowCount !==
					expectedScope.notApplicableSubjectCount))
	) {
		return false;
	}
	if (typedWitness.pageOnly === true) {
		// Season section pages are authenticated against their immutable
		// producer chunks by seasonSectionCache. Keep only bounded page rows in
		// Redis; the full-scope witness remains required for Gameweek caches.
		if (
			!allowPageOnly ||
			!Array.isArray(typedWitness.rows) ||
			typedWitness.rows.length !== 0 ||
			typedWitness.pageLength < 0 ||
			typedWitness.pageLength !== value.rows.length ||
			typedWitness.pageOffset < 0 ||
			typedWitness.pageOffset + typedWitness.pageLength > typedWitness.rowCount ||
			(value.rows.length === 0 && typedWitness.pageOffset !== typedWitness.rowCount) ||
			value.rows.length > 100 ||
			!value.rows.every(pointsRowCache) ||
			new Set(value.rows.filter(isRecord).map((row) => row.entryId)).size !== value.rows.length ||
			value.grossPointsTotal !== typedWitness.selectedGrossPointsTotal ||
			value.grossPointsAverage !== typedWitness.selectedGrossPointsAverage ||
			value.netPointsTotal !== typedWitness.selectedNetPointsTotal ||
			value.seasonGrossPointsTotal !== typedWitness.seasonGrossPointsTotal ||
			value.seasonGrossPointsAverage !== typedWitness.seasonGrossPointsAverage ||
			value.seasonNetPointsTotal !== typedWitness.seasonNetPointsTotal ||
			(value.nextCursor !== null && typeof value.nextCursor !== "string") ||
			typeof value.hasNextPage !== "boolean"
		) {
			return false;
		}
		const expectedHasNextPage =
			typedWitness.pageOffset + typedWitness.pageLength < typedWitness.rowCount;
		return (
			value.hasNextPage === expectedHasNextPage &&
			(value.hasNextPage ? value.nextCursor !== null : value.nextCursor === null)
		);
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

/** Validate only the bounded rows carried by a Season section-page cache.
 * The immutable producer chunk witness is checked separately, so this path
 * deliberately does not require the full fixture/standing identity arrays. */
function h2hPageCache(
	value: Record<string, unknown>,
	expectedSection: "H2H_STANDINGS" | "H2H_FIXTURES",
	expectedScope?: Pick<MyTournamentReviewScopeMeta, "rowCount" | "readySubjectCount">,
	allowRepeatedParticipants = false,
	expectedFirst = 100
): boolean {
	const matches = value.matches;
	const standings = value.standings;
	const coverageWitness = value.coverageWitness;
	if (
		!Array.isArray(matches) ||
		!Array.isArray(standings) ||
		!isRecord(coverageWitness) ||
		coverageWitness.pageOnly !== true ||
		!Array.isArray(coverageWitness.matchIdentities) ||
		!Array.isArray(coverageWitness.matchParticipantIdentities) ||
		!Array.isArray(coverageWitness.matchParticipantIdentitiesByMatch) ||
		!Array.isArray(coverageWitness.standingIdentities) ||
		!Array.isArray(coverageWitness.pageMatchParticipantIdentities) ||
		!Array.isArray(coverageWitness.pageStandingIdentities) ||
		coverageWitness.matchIdentities.length !== 0 ||
		coverageWitness.matchParticipantIdentities.length !== 0 ||
		coverageWitness.matchParticipantIdentitiesByMatch.length !== 0 ||
		coverageWitness.standingIdentities.length !== 0 ||
		!safeInteger(coverageWitness.pageOffset) ||
		coverageWitness.pageOffset < 0
	) {
		return false;
	}
	const pageOffset = coverageWitness.pageOffset;
	if (matches.length > 100 || standings.length > 100) return false;
	if (expectedSection === "H2H_FIXTURES" && standings.length !== 0) return false;
	if (expectedSection === "H2H_STANDINGS" && matches.length !== 0) return false;
	const expectedRowCount =
		expectedSection === "H2H_FIXTURES" ? expectedScope?.rowCount : expectedScope?.readySubjectCount;
	if (
		expectedRowCount !== undefined &&
		(!Number.isSafeInteger(expectedRowCount) ||
			!Number.isSafeInteger(expectedFirst) ||
			expectedFirst < 1 ||
			expectedRowCount < 0 ||
			pageOffset > expectedRowCount ||
			pageOffset + (expectedSection === "H2H_FIXTURES" ? matches.length : standings.length) >
				expectedRowCount)
	) {
		return false;
	}
	const pageMatchIdentities: string[] = [];
	const pageMatchParticipantIdentities: string[] = [];
	const matchIdentities = new Set<string>();
	for (const rawMatch of matches) {
		if (!isRecord(rawMatch)) return false;
		const groupId = strictPositiveInt(rawMatch.groupId);
		const matchId = rawMatch.matchId;
		if (groupId === null || !nonEmptyString(matchId)) return false;
		const identity = JSON.stringify([groupId, matchId]);
		if (matchIdentities.has(identity)) return false;
		matchIdentities.add(identity);
		pageMatchIdentities.push(identity);
		const home = rawMatch.home;
		const away = rawMatch.away;
		const homeIsAverage = isRecord(home) && home.isAverage === true;
		const awayIsAverage = isRecord(away) && away.isAverage === true;
		const homeEntryId = isRecord(home) ? strictPositiveInt(home.entryId) : null;
		const awayEntryId = isRecord(away) ? strictPositiveInt(away.entryId) : null;
		const sidesValid = rawMatch.isBye
			? (home === null) !== (away === null) && !(homeIsAverage || awayIsAverage)
			: home !== null &&
				away !== null &&
				!(homeIsAverage && awayIsAverage) &&
				(homeIsAverage || awayIsAverage || homeEntryId !== awayEntryId);
		const scoresValid =
			(rawMatch.isBye === true &&
				[home, away].every(
					(side) => side === null || (isRecord(side) && side.matchPoints === null)
				)) ||
			(isRecord(home) &&
				isRecord(away) &&
				h2hSideCache(home) &&
				h2hSideCache(away) &&
				h2hMatchPointsValid(home as MyTournamentReviewH2HSide, away as MyTournamentReviewH2HSide));
		const matchParticipants = new Set<string>();
		for (const side of [home, away]) {
			if (!isRecord(side) || side.isAverage === true) continue;
			const entryId = strictPositiveInt(side.entryId);
			if (entryId === null) return false;
			const participant = `${groupId}:${entryId}`;
			if (matchParticipants.has(participant)) return false;
			matchParticipants.add(participant);
			pageMatchParticipantIdentities.push(participant);
		}
		if (
			typeof rawMatch.isBye !== "boolean" ||
			!sidesValid ||
			!scoresValid ||
			(home !== null && !h2hSideCache(home)) ||
			(away !== null && !h2hSideCache(away))
		) {
			return false;
		}
	}
	if (
		!allowRepeatedParticipants &&
		new Set(pageMatchParticipantIdentities).size !== pageMatchParticipantIdentities.length
	) {
		return false;
	}
	const pageStandingIdentities: string[] = [];
	const standingIdentities = new Set<string>();
	const standingIds = new Set<number>();
	for (const rawStanding of standings) {
		if (!isRecord(rawStanding)) return false;
		const groupId = strictPositiveInt(rawStanding.groupId);
		const entryId = strictPositiveInt(rawStanding.entryId);
		if (
			groupId === null ||
			entryId === null ||
			standingIds.has(entryId) ||
			!nonEmptyString(rawStanding.entryName)
		) {
			return false;
		}
		standingIds.add(entryId);
		const identity = `${groupId}:${entryId}`;
		if (standingIdentities.has(identity)) return false;
		standingIdentities.add(identity);
		pageStandingIdentities.push(identity);
		const rank = typeof rawStanding.rank === "number" ? rawStanding.rank : NaN;
		const played = typeof rawStanding.played === "number" ? rawStanding.played : NaN;
		const won = typeof rawStanding.won === "number" ? rawStanding.won : NaN;
		const drawn = typeof rawStanding.drawn === "number" ? rawStanding.drawn : NaN;
		const lost = typeof rawStanding.lost === "number" ? rawStanding.lost : NaN;
		const matchPoints = typeof rawStanding.matchPoints === "number" ? rawStanding.matchPoints : NaN;
		const counters = [rank, played, won, drawn, lost, matchPoints];
		if (
			!counters.every(
				(candidate) =>
					typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
			) ||
			!safeInteger(rawStanding.pointsFor) ||
			!safeInteger(rawStanding.pointsAgainst) ||
			rank <= 0 ||
			played !== won + drawn + lost ||
			matchPoints !== 3 * won + drawn
		) {
			return false;
		}
	}
	const pageLength = expectedSection === "H2H_FIXTURES" ? matches.length : standings.length;
	const canonicalPageLength =
		expectedRowCount === undefined
			? pageLength
			: Math.min(expectedFirst, Math.max(0, expectedRowCount - pageOffset));
	// A cache entry with its page rows removed must not be able to turn into a
	// valid empty continuation. Bind the page shape to the authenticated
	// request size and source row count; an empty page is valid only at the end.
	if (
		pageLength !== canonicalPageLength ||
		(pageLength === 0 && pageOffset !== (expectedRowCount ?? pageOffset))
	) {
		return false;
	}
	const totalRows = expectedRowCount ?? pageOffset + pageLength;
	const expectedHasNextPage = pageOffset + canonicalPageLength < totalRows;
	const sameArray = (left: string[], right: unknown): boolean =>
		Array.isArray(right) &&
		left.length === right.length &&
		left.every((item, index) => item === right[index]);
	return (
		sameArray(pageMatchIdentities, coverageWitness.pageMatchIdentities) &&
		sameArray(pageMatchParticipantIdentities, coverageWitness.pageMatchParticipantIdentities) &&
		sameArray(pageStandingIdentities, coverageWitness.pageStandingIdentities) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean" &&
		value.hasNextPage === expectedHasNextPage &&
		(value.hasNextPage ? value.nextCursor !== null : value.nextCursor === null)
	);
}

function h2hCache(
	value: unknown,
	expectedSection?: "H2H_STANDINGS" | "H2H_FIXTURES",
	expectedScope?: Pick<MyTournamentReviewScopeMeta, "rowCount" | "readySubjectCount">,
	allowRepeatedParticipants = false,
	expectedFirst = 100
): value is MyTournamentReviewH2H {
	if (!isRecord(value) || !Array.isArray(value.matches) || !Array.isArray(value.standings)) {
		return false;
	}
	if (isRecord(value.coverageWitness) && value.coverageWitness.pageOnly === true) {
		if (expectedSection === undefined) return false;
		return h2hPageCache(
			value,
			expectedSection,
			expectedScope,
			allowRepeatedParticipants,
			expectedFirst
		);
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
		!Array.isArray(coverageWitness.matchParticipantIdentitiesByMatch) ||
		!Array.isArray(coverageWitness.standingIdentities) ||
		!Array.isArray(coverageWitness.pageMatchParticipantIdentities) ||
		!Array.isArray(coverageWitness.pageStandingIdentities) ||
		!safeInteger(coverageWitness.pageOffset) ||
		coverageWitness.pageOffset < 0 ||
		!coverageWitness.matchIdentities.every(isCoverageMatchIdentity) ||
		!coverageWitness.matchParticipantIdentities.every(isCoverageIdentity) ||
		!coverageWitness.matchParticipantIdentitiesByMatch.every(
			(participants) => Array.isArray(participants) && participants.every(isCoverageIdentity)
		) ||
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
		witnessStandingIdentities.size !== coverageWitness.standingIdentities.length ||
		witnessMatchIdentities.size === 0 ||
		coverageWitness.matchParticipantIdentitiesByMatch.length !==
			coverageWitness.matchIdentities.length ||
		(expectedSection !== "H2H_STANDINGS" &&
			(coverageWitness.pageOffset > coverageWitness.matchIdentities.length ||
				coverageWitness.pageOffset + value.matches.length >
					coverageWitness.matchIdentities.length)) ||
		(expectedSection !== "H2H_FIXTURES" &&
			(coverageWitness.pageOffset > coverageWitness.standingIdentities.length ||
				coverageWitness.pageOffset + value.standings.length >
					coverageWitness.standingIdentities.length)) ||
		(expectedSection === "H2H_FIXTURES" && value.standings.length !== 0) ||
		(expectedSection === "H2H_STANDINGS" && value.matches.length !== 0) ||
		(expectedScope !== undefined &&
			(coverageWitness.matchIdentities.length !== expectedScope.rowCount ||
				coverageWitness.standingIdentities.length !== expectedScope.readySubjectCount))
	) {
		return false;
	}
	const expectedParticipantIdentities = coverageWitness.matchParticipantIdentitiesByMatch.flat();
	const witnessMatchParticipantIdentities = coverageWitness.matchParticipantIdentities as string[];
	if (
		!allowRepeatedParticipants &&
		new Set(expectedParticipantIdentities).size !== expectedParticipantIdentities.length
	) {
		return false;
	}
	if (
		expectedParticipantIdentities.length !== witnessMatchParticipantIdentities.length ||
		!expectedParticipantIdentities.every(
			(identity, index) => identity === witnessMatchParticipantIdentities[index]
		)
	) {
		return false;
	}
	// A continuation page can legitimately contain standings only when the
	// match collection is shorter than the standings collection.  It is still
	// invalid for both collections to be empty.
	if (value.matches.length === 0 && value.standings.length === 0) return false;
	const matchIdentities = new Set<string>();
	const pageMatchIdentities: string[] = [];
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
		const matchParticipantIdentities = new Set<string>();
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
		[...new Set(pageMatchParticipantIdentities)].every((identity) =>
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
		arraysEqual(
			pageMatchParticipantIdentities,
			coverageWitness.matchParticipantIdentitiesByMatch
				.slice(coverageWitness.pageOffset, coverageWitness.pageOffset + value.matches.length)
				.flat()
		) &&
		arraysEqual(pageMatchParticipantIdentities, coverageWitness.pageMatchParticipantIdentities) &&
		arraysEqual(pageStandingIdentities, coverageWitness.pageStandingIdentities);
	const expectedHasNextPage =
		expectedSection === "H2H_FIXTURES"
			? coverageWitness.pageOffset + value.matches.length < coverageWitness.matchIdentities.length
			: expectedSection === "H2H_STANDINGS"
				? coverageWitness.pageOffset + value.standings.length <
					coverageWitness.standingIdentities.length
				: coverageWitness.pageOffset + Math.max(value.matches.length, value.standings.length) <
					Math.max(
						coverageWitness.matchIdentities.length,
						coverageWitness.standingIdentities.length
					);
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

/** Validate only the bounded knockout rows retained by a Season section-page
 * cache. Full entry/bracket coverage is authenticated by the producer chunk
 * witness in seasonSectionCache. */
function knockoutPageCache(
	value: Record<string, unknown>,
	expectedScope?: Pick<
		MyTournamentReviewScopeMeta,
		"rowCount" | "expectedSubjectCount" | "readySubjectCount" | "notApplicableSubjectCount"
	>,
	expectedFirst = 100
): boolean {
	const matches = value.matches;
	const witness = value.coverageWitness;
	if (
		!Array.isArray(matches) ||
		!isRecord(witness) ||
		witness.pageOnly !== true ||
		!Array.isArray(witness.matchIdentities) ||
		!Array.isArray(witness.entryIdentities) ||
		!Array.isArray(witness.applicableEntryIdentities) ||
		!Array.isArray(witness.notApplicableEntryIdentities) ||
		!Array.isArray(witness.pageMatchIdentities) ||
		witness.matchIdentities.length !== 0 ||
		witness.entryIdentities.length !== 0 ||
		witness.applicableEntryIdentities.length !== 0 ||
		witness.notApplicableEntryIdentities.length !== 0 ||
		!safeInteger(witness.pageOffset) ||
		witness.pageOffset < 0 ||
		witness.pageMatchIdentities.length !== matches.length ||
		!witness.pageMatchIdentities.every(nonEmptyString) ||
		matches.length > 100
	) {
		return false;
	}
	const pageOffset = witness.pageOffset;
	if (
		expectedScope !== undefined &&
		(!Number.isSafeInteger(expectedScope.rowCount) ||
			!Number.isSafeInteger(expectedFirst) ||
			expectedFirst < 1 ||
			pageOffset > expectedScope.rowCount ||
			pageOffset + matches.length > expectedScope.rowCount)
	) {
		return false;
	}
	const canonicalPageLength =
		expectedScope === undefined
			? matches.length
			: Math.min(expectedFirst, Math.max(0, expectedScope.rowCount - pageOffset));
	// A corrupted cache must not validate itself by shrinking a non-terminal
	// page to an empty (or otherwise short) continuation. Only the final page
	// may be shorter than the requested size.
	if (
		matches.length !== canonicalPageLength ||
		(matches.length === 0 && pageOffset !== (expectedScope?.rowCount ?? pageOffset))
	) {
		return false;
	}
	const identities: string[] = [];
	const seen = new Set<string>();
	for (const rawMatch of matches) {
		if (!isRecord(rawMatch)) return false;
		const matchId = strictPositiveInt(rawMatch.matchId);
		const playAgainstId = strictPositiveInt(rawMatch.playAgainstId);
		const identity =
			matchId !== null && playAgainstId !== null ? `${matchId}:${playAgainstId}` : null;
		if (identity === null || seen.has(identity)) return false;
		seen.add(identity);
		identities.push(identity);
		const home = rawMatch.home;
		const away = rawMatch.away;
		const homeEntryId = isRecord(home) ? strictPositiveInt(home.entryId) : null;
		const awayEntryId = isRecord(away) ? strictPositiveInt(away.entryId) : null;
		if (
			matchId === null ||
			playAgainstId === null ||
			(rawMatch.round !== null && strictPositiveInt(rawMatch.round) === null) ||
			(rawMatch.name !== null && typeof rawMatch.name !== "string") ||
			(rawMatch.winnerEntryId !== null && strictPositiveInt(rawMatch.winnerEntryId) === null) ||
			(home === null && away === null) ||
			(home !== null && !knockoutSideCache(home)) ||
			(away !== null && !knockoutSideCache(away)) ||
			(home !== null && away !== null && homeEntryId === awayEntryId) ||
			!knockoutSettledScoresValid(home, away, rawMatch.winnerEntryId) ||
			(rawMatch.winnerEntryId !== null &&
				rawMatch.winnerEntryId !== (isRecord(home) ? home.entryId : undefined) &&
				rawMatch.winnerEntryId !== (isRecord(away) ? away.entryId : undefined))
		) {
			return false;
		}
	}
	const witnessPageMatchIdentities = witness.pageMatchIdentities as unknown[];
	return (
		identities.every((identity, index) => identity === witnessPageMatchIdentities[index]) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean" &&
		(expectedScope === undefined ||
			value.hasNextPage === pageOffset + matches.length < expectedScope.rowCount) &&
		(value.hasNextPage ? value.nextCursor !== null : value.nextCursor === null)
	);
}

function knockoutCache(
	value: unknown,
	expectedScope?: Pick<
		MyTournamentReviewScopeMeta,
		"rowCount" | "expectedSubjectCount" | "readySubjectCount" | "notApplicableSubjectCount"
	>,
	expectedFirst = 100
): value is MyTournamentReviewKnockout {
	if (!isRecord(value) || !Array.isArray(value.matches)) return false;
	if (isRecord(value.coverageWitness) && value.coverageWitness.pageOnly === true) {
		return knockoutPageCache(value, expectedScope, expectedFirst);
	}
	const witness = value.coverageWitness;
	if (
		!isRecord(witness) ||
		!Array.isArray(witness.matchIdentities) ||
		!Array.isArray(witness.entryIdentities) ||
		!Array.isArray(witness.applicableEntryIdentities) ||
		!Array.isArray(witness.notApplicableEntryIdentities) ||
		!Array.isArray(witness.pageMatchIdentities) ||
		!safeInteger(witness.pageOffset) ||
		witness.pageOffset < 0 ||
		!witness.matchIdentities.every(nonEmptyString) ||
		!witness.entryIdentities.every(nonEmptyString) ||
		!witness.applicableEntryIdentities.every(nonEmptyString) ||
		!witness.notApplicableEntryIdentities.every(nonEmptyString) ||
		!witness.pageMatchIdentities.every(nonEmptyString) ||
		new Set(witness.matchIdentities).size !== witness.matchIdentities.length ||
		new Set(witness.entryIdentities).size !== witness.entryIdentities.length ||
		new Set(witness.applicableEntryIdentities).size !== witness.applicableEntryIdentities.length ||
		new Set(witness.notApplicableEntryIdentities).size !==
			witness.notApplicableEntryIdentities.length ||
		witness.pageOffset + value.matches.length > witness.matchIdentities.length ||
		(expectedScope !== undefined &&
			(witness.matchIdentities.length !== expectedScope.rowCount ||
				witness.entryIdentities.length > expectedScope.expectedSubjectCount ||
				witness.applicableEntryIdentities.length > expectedScope.readySubjectCount ||
				witness.notApplicableEntryIdentities.length > expectedScope.notApplicableSubjectCount))
	) {
		return false;
	}
	const matchIdentities = new Set<string>();
	const pageIdentities: string[] = [];
	const pageEntryIds = new Set<string>();
	const matchesValid = value.matches.every((match) => {
		if (!isRecord(match)) return false;
		const matchId = strictPositiveInt(match.matchId);
		const playAgainstId = strictPositiveInt(match.playAgainstId);
		const identity =
			matchId !== null && playAgainstId !== null ? `${matchId}:${playAgainstId}` : null;
		if (identity === null || matchIdentities.has(identity)) return false;
		matchIdentities.add(identity);
		pageIdentities.push(identity);
		for (const side of [match.home, match.away]) {
			if (isRecord(side)) pageEntryIds.add(String(side.entryId));
		}
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
	});
	const pageExpected = witness.matchIdentities.slice(
		witness.pageOffset,
		witness.pageOffset + value.matches.length
	);
	const witnessEntryIdentities = witness.entryIdentities as string[];
	const pageCoverageValid =
		pageExpected.length === pageIdentities.length &&
		pageExpected.every((identity, index) => identity === pageIdentities[index]) &&
		witness.pageMatchIdentities.length === pageIdentities.length &&
		witness.pageMatchIdentities.every((identity, index) => identity === pageIdentities[index]) &&
		[...pageEntryIds].every((entryId) => witnessEntryIdentities.includes(entryId));
	const expectedHasNextPage =
		witness.pageOffset + value.matches.length < witness.matchIdentities.length;
	return (
		matchesValid &&
		pageCoverageValid &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean" &&
		value.hasNextPage === expectedHasNextPage &&
		(value.hasNextPage ? value.nextCursor !== null : value.nextCursor === null)
	);
}

type GameweekCacheHead = {
	tournamentId: number;
	eventId: number;
	revision: string;
	format: MyTournamentReviewFormat;
	contentSha256: string;
	rowCount: number;
	expectedSubjectCount: number;
	readySubjectCount: number;
	notApplicableSubjectCount: number;
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
	// A READY response is only valid when this request observed the exact
	// publication head that produced it. Negative-state cache keys deliberately
	// have no head expectation and may never be promoted by a corrupt Redis
	// value into fabricated business data.
	if (state === "READY" && expectedHead === undefined) return false;
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
		return (
			h2hCache(value.h2h, undefined, expectedHead) &&
			value.points === null &&
			value.knockout === null
		);
	}
	return (
		knockoutCache(value.knockout, expectedHead) &&
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

function phaseDescriptorsCache(
	value: unknown,
	expected: NonNullable<MyTournamentSeasonReview["phases"]>
): boolean {
	if (!Array.isArray(value) || value.length !== expected.length) return false;
	return value.every((candidate, index) => {
		const phase = expected[index];
		if (!phase || !isRecord(candidate)) return false;
		return (
			candidate.phaseId === phase.phaseId &&
			candidate.format === phase.format &&
			candidate.startEventId === phase.startEventId &&
			candidate.endEventId === phase.endEventId &&
			candidate.state === phase.state &&
			candidate.settledAt === phase.settledAt &&
			candidate.publishedAt === phase.publishedAt &&
			candidate.correctedAt === phase.correctedAt &&
			String(candidate.revision ?? "") === String(phase.revision ?? "") &&
			(candidate.semanticSha256 ?? null) === (phase.semanticSha256 ?? null) &&
			(candidate.rowCount ?? null) === (phase.rowCount ?? null) &&
			(candidate.expectedSubjectCount ?? null) === (phase.expectedSubjectCount ?? null) &&
			(candidate.readySubjectCount ?? null) === (phase.readySubjectCount ?? null) &&
			(candidate.notApplicableSubjectCount ?? null) === (phase.notApplicableSubjectCount ?? null) &&
			sectionHashMapsEqual(candidate.sectionChunkHashes, phase.sectionChunkHashes) &&
			sectionItemCountMapsEqual(candidate.sectionChunkItemCounts, phase.sectionChunkItemCounts) &&
			pointsAggregateSummariesEqual(candidate.pointsAggregateSummary, phase.pointsAggregateSummary)
		);
	});
}

function pointsAggregateSummariesEqual(
	left: unknown,
	right: ReviewPointsAggregateSummary | undefined
): boolean {
	if (left === undefined || left === null || right === undefined) {
		return (left === undefined || left === null) && right === undefined;
	}
	if (!isRecord(left)) return false;
	return (
		left.grossPointsTotal === right.grossPointsTotal &&
		left.grossPointsAverage === right.grossPointsAverage &&
		left.netPointsTotal === right.netPointsTotal &&
		left.seasonGrossPointsTotal === right.seasonGrossPointsTotal &&
		left.seasonGrossPointsAverage === right.seasonGrossPointsAverage &&
		left.seasonNetPointsTotal === right.seasonNetPointsTotal
	);
}

function sectionHashMapsEqual(
	left: unknown,
	right: Partial<Record<MyTournamentReviewSeasonSection, string[]>> | undefined
): boolean {
	for (const section of REVIEW_SECTION_KEYS) {
		const leftHashes = isRecord(left) && Array.isArray(left[section]) ? left[section] : null;
		const rightHashes = right?.[section] ?? null;
		if (leftHashes === null || rightHashes === null) {
			if (leftHashes !== rightHashes) return false;
			continue;
		}
		if (
			leftHashes.length !== rightHashes.length ||
			!leftHashes.every((hash, index) => hash === rightHashes[index])
		) {
			return false;
		}
	}
	return true;
}

function sectionItemCountMapsEqual(
	left: unknown,
	right: Partial<Record<MyTournamentReviewSeasonSection, number[]>> | undefined
): boolean {
	for (const section of REVIEW_SECTION_KEYS) {
		const leftCounts = isRecord(left) && Array.isArray(left[section]) ? left[section] : null;
		const rightCounts = right?.[section] ?? null;
		if (leftCounts === null || rightCounts === null) {
			if (leftCounts !== rightCounts) return false;
			continue;
		}
		if (
			leftCounts.length !== rightCounts.length ||
			!leftCounts.every((count, index) => count === rightCounts[index])
		) {
			return false;
		}
	}
	return true;
}

type SeasonCacheExpectation = {
	state: MyTournamentReviewState;
	tournamentId: number;
	throughEventId: number;
	latestEventId: number | null;
	latestRevision: string | null;
	format: MyTournamentReviewFormat | null;
	semanticSha256: string | null;
	finalizedEventIds: number[];
};

function seasonCache(
	value: unknown,
	expectedPhases: NonNullable<MyTournamentSeasonReview["phases"]>,
	expected: SeasonCacheExpectation
): value is MyTournamentSeasonReview {
	if (!isRecord(value) || !isKnownReviewState(value.state)) return false;
	if (
		value.state !== expected.state ||
		value.tournamentId !== expected.tournamentId ||
		value.throughEventId !== expected.throughEventId ||
		(value.latestEventId ?? null) !== expected.latestEventId ||
		String(value.latestRevision ?? "") !== String(expected.latestRevision ?? "") ||
		(value.format ?? null) !== expected.format ||
		(value.semanticSha256 ?? null) !== expected.semanticSha256 ||
		!Array.isArray(value.finalizedEventIds) ||
		value.finalizedEventIds.length !== expected.finalizedEventIds.length ||
		value.finalizedEventIds.some((eventId, index) => eventId !== expected.finalizedEventIds[index])
	) {
		return false;
	}
	if (!phaseDescriptorsCache(value.phases, expectedPhases)) return false;
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
		value.freshness !== null ||
		typeof value.semanticSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.semanticSha256) ||
		eventIds.length === 0 ||
		Number(value.latestEventId) !== Number(eventIds.at(-1))
	) {
		return false;
	}
	// Season is a metadata-only phase index.  Section roots are the sole path
	// that materializes immutable chunks, so a cached summary must never carry
	// a full Points/H2H/Knockout payload (or its freshness clock).
	return value.points === null && value.h2h === null && value.knockout === null;
}

type SeasonSectionCacheExpectation = {
	seasonId: number;
	tournamentId: number;
	viewerEntryId: number | null;
	eventId: number;
	throughEventId: number;
	phaseId: string;
	section: MyTournamentReviewSeasonSection;
	revision: string;
	semanticSha256: string;
	rowCount: number;
	expectedSubjectCount: number;
	readySubjectCount: number;
	notApplicableSubjectCount: number;
	sectionChunkHashes: string[] | null;
	sectionChunkItemCounts: number[] | null;
	pointsAggregateSummary?: ReviewPointsAggregateSummary;
	pageOffset: number;
	first: number;
};

/** Rebuild the public section rows from the authenticated producer rows. A
 * cached value is untrusted JSON; retaining a second, attacker-controlled
 * canonicalRows array as the only comparison target would let a corrupt cache
 * validate itself. */
function canonicalRowsFromSource(
	section: MyTournamentReviewSeasonSection,
	sourceRows: readonly unknown[]
): unknown[] {
	if (section === "POINTS_STANDINGS" || section === "POINTS_TRAJECTORIES") {
		return mapPointsRows(sourceRows).map((item) => ({
			...item,
			grossPoints: item.seasonGrossPoints,
			transferCost: seasonTransferCost(item),
			netPoints: item.seasonNetPoints,
		}));
	}
	if (section === "H2H_FIXTURES") {
		return mapH2H({ matches: sourceRows, standings: [] }, true, false).matches;
	}
	if (section === "H2H_STANDINGS") {
		return mapH2H({ matches: [], standings: sourceRows }, true, false).standings;
	}
	return mapKnockout({ matches: sourceRows });
}

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
		(expectedPoints &&
			!pointsCache(
				points,
				"SEASON",
				{
					rowCount: expected.rowCount,
					expectedSubjectCount: expected.expectedSubjectCount,
					readySubjectCount: expected.readySubjectCount,
					notApplicableSubjectCount: expected.notApplicableSubjectCount,
				},
				true
			)) ||
		(expectedH2H &&
			!h2hCache(
				h2h,
				expected.section as "H2H_STANDINGS" | "H2H_FIXTURES",
				{
					rowCount: expected.rowCount,
					readySubjectCount: expected.readySubjectCount,
				},
				true,
				expected.first
			)) ||
		(expectedKnockout &&
			!knockoutCache(
				knockout,
				{
					rowCount: expected.rowCount,
					expectedSubjectCount: expected.expectedSubjectCount,
					readySubjectCount: expected.readySubjectCount,
					notApplicableSubjectCount: expected.notApplicableSubjectCount,
				},
				expected.first
			)) ||
		(!expectedPoints && points !== null) ||
		(!expectedH2H && h2h !== null) ||
		(!expectedKnockout && knockout !== null)
	) {
		return false;
	}
	const typedPoints = points as MyTournamentReviewPoints | null;
	const typedH2H = h2h as MyTournamentReviewH2H | null;
	const typedKnockout = knockout as MyTournamentReviewKnockout | null;
	if (expectedPoints) {
		const expectedSummary = expected.pointsAggregateSummary;
		// A page-only Points cache carries whole-section aggregates. Without the
		// publication's authenticated shell there is no trusted value to compare
		// them with, so force a PostgreSQL materialization rather than accepting a
		// self-consistent but unbound cache entry.
		if (
			!expectedSummary ||
			!typedPoints ||
			typedPoints.grossPointsTotal !== expectedSummary.seasonGrossPointsTotal ||
			typedPoints.grossPointsAverage !== expectedSummary.seasonGrossPointsAverage ||
			typedPoints.netPointsTotal !== expectedSummary.seasonNetPointsTotal ||
			typedPoints.seasonGrossPointsTotal !== expectedSummary.seasonGrossPointsTotal ||
			typedPoints.seasonGrossPointsAverage !== expectedSummary.seasonGrossPointsAverage ||
			typedPoints.seasonNetPointsTotal !== expectedSummary.seasonNetPointsTotal
		) {
			return false;
		}
	}
	const page = typedPoints ?? typedH2H ?? typedKnockout;
	if (!isRecord(page)) return false;
	const sectionWitness = value.__sectionWitness;
	if (
		!isRecord(sectionWitness) ||
		!Number.isSafeInteger(sectionWitness.pageOffset) ||
		Number(sectionWitness.pageOffset) < 0 ||
		!Array.isArray(sectionWitness.sourceRows) ||
		!Array.isArray(sectionWitness.chunkIndexes) ||
		!Array.isArray(sectionWitness.chunkHashes) ||
		!Array.isArray(sectionWitness.chunkItemCounts)
	) {
		return false;
	}
	const sourceRows = sectionWitness.sourceRows as unknown[];
	const chunkIndexes = sectionWitness.chunkIndexes as unknown[];
	const witnessChunkHashes = sectionWitness.chunkHashes as unknown[];
	const witnessChunkItemCounts = sectionWitness.chunkItemCounts as unknown[];
	if (
		Number(sectionWitness.pageOffset) !== expected.pageOffset ||
		chunkIndexes.length === 0 ||
		chunkIndexes.length !== witnessChunkHashes.length ||
		chunkIndexes.length !== witnessChunkItemCounts.length ||
		!chunkIndexes.every((index) => Number.isSafeInteger(index) && Number(index) >= 0) ||
		!witnessChunkHashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) ||
		!witnessChunkItemCounts.every(
			(count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 100
		)
	) {
		return false;
	}
	const expectedRowCount =
		expected.section === "H2H_STANDINGS" ? expected.readySubjectCount : expected.rowCount;
	if (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 0) return false;
	const expectedChunkItemCounts =
		expected.sectionChunkItemCounts ??
		defaultChunkLengths(Array.from({ length: expectedRowCount }, () => null));
	const expectedChunkHashes = expected.sectionChunkHashes;
	if (
		expectedChunkItemCounts.length === 0 ||
		!expectedChunkItemCounts.every(
			(count) => Number.isSafeInteger(count) && count >= 0 && count <= 100
		) ||
		(expectedRowCount === 0 &&
			(expectedChunkItemCounts.length !== 1 || expectedChunkItemCounts[0] !== 0)) ||
		(expectedRowCount > 0 && expectedChunkItemCounts.some((count) => count <= 0)) ||
		expectedChunkItemCounts.reduce((total, count) => total + count, 0) !== expectedRowCount ||
		(expectedChunkHashes !== null &&
			(expectedChunkHashes.length !== expectedChunkItemCounts.length ||
				!expectedChunkHashes.every(
					(hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
				)))
	) {
		return false;
	}
	const normalizedChunkIndexes = chunkIndexes.map((index) => Number(index));
	const normalizedChunkItemCounts = witnessChunkItemCounts.map((count) => Number(count));
	if (
		normalizedChunkIndexes.some(
			(index, position) =>
				index !== normalizedChunkIndexes[0]! + position || index >= expectedChunkItemCounts.length
		) ||
		normalizedChunkItemCounts.some(
			(count, position) => count !== expectedChunkItemCounts[normalizedChunkIndexes[position]!]
		) ||
		sourceRows.length !== normalizedChunkItemCounts.reduce((total, count) => total + count, 0)
	) {
		return false;
	}
	const selectedStart = expectedChunkItemCounts
		.slice(0, normalizedChunkIndexes[0]!)
		.reduce((total, count) => total + count, 0);
	const selectedLength = normalizedChunkItemCounts.reduce((total, count) => total + count, 0);
	const pageOffset = Number(sectionWitness.pageOffset);
	const pageRows = typedPoints
		? typedPoints.rows
		: typedH2H
			? expected.section === "H2H_FIXTURES"
				? typedH2H.matches
				: typedH2H.standings
			: typedKnockout!.matches;
	const pageLength = pageRows.length;
	const publicPageOffset = typedPoints
		? typedPoints.aggregateWitness.pageOffset
		: typedH2H
			? typedH2H.coverageWitness.pageOffset
			: typedKnockout!.coverageWitness.pageOffset;
	if (
		publicPageOffset !== pageOffset ||
		pageLength > expected.first ||
		pageOffset < selectedStart ||
		pageOffset + pageLength > selectedStart + selectedLength ||
		pageOffset + pageLength > expectedRowCount
	) {
		return false;
	}
	let sourceOffset = 0;
	try {
		for (const [position, count] of normalizedChunkItemCounts.entries()) {
			const chunkRows = sourceRows.slice(sourceOffset, sourceOffset + count);
			if (postgresJsonbContentHash(chunkRows) !== witnessChunkHashes[position]) return false;
			sourceOffset += count;
		}
		if (sourceOffset !== sourceRows.length) return false;
		if (
			expectedChunkHashes !== null &&
			!normalizedChunkIndexes.every(
				(index, position) => expectedChunkHashes[index] === witnessChunkHashes[position]
			)
		) {
			return false;
		}
		const sourceCanonicalRows = canonicalRowsFromSource(expected.section, sourceRows);
		const localPageOffset = pageOffset - selectedStart;
		const expectedPageRows = sourceCanonicalRows.slice(
			localPageOffset,
			localPageOffset + pageLength
		);
		if (
			sourceCanonicalRows.length !== selectedLength ||
			postgresJsonbContentHash(pageRows) !== postgresJsonbContentHash(expectedPageRows)
		) {
			return false;
		}
	} catch {
		return false;
	}
	const cursorScope = reviewSectionCursorScope(
		{
			season_id: expected.seasonId,
			tournament_id: expected.tournamentId,
			event_id: expected.eventId,
			revision: expected.revision,
			format: expected.section.startsWith("POINTS")
				? "POINTS"
				: expected.section.startsWith("H2H")
					? "H2H"
					: "KNOCKOUT",
		},
		expected.viewerEntryId,
		expected.phaseId,
		expected.section,
		expected.semanticSha256
	);
	const expectedNextCursor = page.hasNextPage
		? encodeCursor(pageOffset + pageLength, expected.revision, cursorScope)
		: null;
	return (
		value.pageInfo.hasNextPage === Boolean(page.hasNextPage) &&
		page.hasNextPage === pageOffset + pageLength < expectedRowCount &&
		value.pageInfo.endCursor === (page.nextCursor ?? null) &&
		page.nextCursor === expectedNextCursor
	);
}

function seasonCountMetadataValid(row: SeasonMetadataRow): boolean {
	const rowCount = row.row_count === null ? NaN : Number(row.row_count);
	const expectedSubjectCount =
		row.expected_subject_count === null ? NaN : Number(row.expected_subject_count);
	const readySubjectCount =
		row.ready_subject_count === null ? NaN : Number(row.ready_subject_count);
	const notApplicableSubjectCount =
		row.not_applicable_subject_count === null ? NaN : Number(row.not_applicable_subject_count);
	const format = reviewFormat(row.format) ?? reviewFormat(row.obligation_format);
	const countsValid =
		Number.isSafeInteger(rowCount) &&
		rowCount > 0 &&
		Number.isSafeInteger(expectedSubjectCount) &&
		expectedSubjectCount > 0 &&
		Number.isSafeInteger(readySubjectCount) &&
		readySubjectCount >= 0 &&
		Number.isSafeInteger(notApplicableSubjectCount) &&
		notApplicableSubjectCount >= 0 &&
		readySubjectCount + notApplicableSubjectCount === expectedSubjectCount;
	if (!countsValid) return false;
	// POINTS rows are one-per-subject. H2H and KNOCKOUT use row_count for
	// matches/fixtures while subject counts describe entry coverage.
	return format === "POINTS"
		? rowCount === expectedSubjectCount && readySubjectCount <= rowCount
		: format === "H2H"
			? readySubjectCount <= rowCount * 2
			: true;
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

function requiredCatalogCounter(value: unknown, label: string): number {
	const normalized = value === null || value === undefined ? null : Number(value);
	if (normalized === null || !safeInteger(normalized) || normalized < 0) {
		throw integrityError(`Review catalog ${label} is invalid`);
	}
	return normalized;
}

function reviewErrorCode(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (!/^[A-Z0-9][A-Z0-9_.:-]{0,127}$/.test(value)) {
		throw integrityError("Review error code is invalid");
	}
	return value;
}

function reviewRepairState(value: number | string | null | undefined): "NONE" | "OPEN" {
	if (value === null || value === undefined) return "NONE";
	const issueId = Number(value);
	if (!Number.isSafeInteger(issueId) || issueId <= 0) {
		throw integrityError("Review repair issue id is invalid");
	}
	return "OPEN";
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
	const finalizedExecutionAttempts =
		finalizedFormat === null
			? 0
			: requiredCatalogCounter(row.finalized_execution_attempts, "execution attempts");
	const finalizedSourceRechecks =
		finalizedFormat === null
			? 0
			: requiredCatalogCounter(row.finalized_source_rechecks, "source rechecks");
	const latestFinalizedScope =
		latestFinalizedEventId !== null && finalizedFormat !== null
			? {
					eventId: latestFinalizedEventId,
					format: finalizedFormat,
					state: finalizedState,
					eligibleAt: iso(row.finalized_eligible_at),
					readyAt: iso(row.finalized_ready_at),
					observedAt: iso(row.finalized_observed_at),
					nextAttemptAt: iso(row.finalized_next_attempt_at),
					executionAttempts: finalizedExecutionAttempts,
					sourceRechecks: finalizedSourceRechecks,
					degradedAt: iso(row.finalized_degraded_at),
					revision: finalizedRevision === null ? null : String(finalizedRevision),
					publishedAt: finalizedPublishedAt,
					repairState: reviewRepairState(row.finalized_repair_issue_id),
					errorCode: reviewErrorCode(row.finalized_error_code),
				}
			: null;
	const phaseSummaries: MyTournamentReviewCatalogItem["phaseSummaries"] = [];
	const addPhase = (
		phaseId: string,
		format: MyTournamentReviewFormat,
		startEventId: number | null,
		endEventId: number | null,
		phaseState: string | null
	) => {
		if (startEventId === null || positiveInt(startEventId) === null) return;
		const state =
			latestFinalizedEventId === null || latestFinalizedEventId < startEventId
				? "NOT_STARTED"
				: phaseState === null
					? "UNAVAILABLE"
					: catalogState(phaseState);
		phaseSummaries.push({
			phaseId,
			format,
			startEventId,
			endEventId: endEventId === null ? null : positiveInt(endEventId),
			state,
		});
	};
	if (row.group_mode === "points_races") {
		addPhase(
			"points",
			"POINTS",
			row.group_started_event_id,
			row.group_ended_event_id,
			row.points_phase_state
		);
	} else if (row.group_mode === "battle_races") {
		addPhase(
			"h2h",
			"H2H",
			row.group_started_event_id,
			row.group_ended_event_id,
			row.h2h_phase_state
		);
	}
	if (row.knockout_mode && row.knockout_mode !== "no_knockout") {
		addPhase(
			"knockout",
			"KNOCKOUT",
			row.knockout_started_event_id,
			row.knockout_ended_event_id,
			row.knockout_phase_state
		);
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

function mapH2H(
	value: unknown,
	allowRepeatedParticipants = false,
	validateCoverage = true
): {
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
						if (!allowRepeatedParticipants && matchParticipantIdentities.has(participantIdentity)) {
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
	if (
		validateCoverage &&
		new Set(standings.map((standing) => standing.entryId)).size !== standings.length
	) {
		throw integrityError("Review H2H standings contain duplicate entries");
	}
	if (!validateCoverage) return { matches, standings };
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

type SeasonSectionWitness = {
	pageOffset: number;
	sourceRows: unknown[];
	chunkIndexes: number[];
	chunkHashes: string[];
	chunkItemCounts: number[];
};

/** Build a bounded private cache witness from the trusted, materialized
 * publication. The witness contains only the producer chunks intersecting the
 * requested page; their indexes/counts/hashes are checked against the
 * publication manifest before the entry is written to Redis. */
function seasonSectionWitness(
	payload: unknown,
	section: MyTournamentReviewSeasonSection,
	persistedChunks: readonly PublicationChunkRow[] = [],
	pageOffset = 0,
	pageLength = 0
): SeasonSectionWitness | null {
	if (!isRecord(payload)) return null;
	let sourceRows: unknown[];
	if (section === "POINTS_STANDINGS" || section === "POINTS_TRAJECTORIES") {
		const points = isRecord(payload.points) ? payload.points : null;
		const raw = section === "POINTS_TRAJECTORIES" ? points?.trajectoryRows : points?.rows;
		if (!Array.isArray(raw)) return null;
		sourceRows = raw;
	} else if (section === "H2H_STANDINGS" || section === "H2H_FIXTURES") {
		const h2h = isRecord(payload.h2h) ? payload.h2h : null;
		const raw = section === "H2H_FIXTURES" ? h2h?.matches : h2h?.standings;
		if (!Array.isArray(raw)) return null;
		sourceRows = raw;
	} else {
		const knockout = isRecord(payload.knockout) ? payload.knockout : null;
		if (!Array.isArray(knockout?.matches)) return null;
		sourceRows = knockout.matches;
	}
	const sectionChunks = persistedChunks
		.filter((chunk) => chunk.section_key === section)
		.sort((left, right) => Number(left.chunk_index) - Number(right.chunk_index));
	const chunkItemCounts = sectionChunks.length
		? sectionChunks.map((chunk) => Number(chunk.item_count))
		: defaultChunkLengths(sourceRows);
	const chunkHashes = sectionChunks.length
		? sectionChunks.map((chunk) => String(chunk.chunk_sha256))
		: chunkHashesForRows(sourceRows, chunkItemCounts);
	const computedChunkHashes = chunkHashesForRows(sourceRows, chunkItemCounts);
	if (
		chunkHashes.length !== chunkItemCounts.length ||
		chunkHashes.some((hash, index) => hash !== computedChunkHashes[index])
	) {
		throw integrityError("Review phase section chunk witness does not match its materialized rows");
	}
	if (
		!Number.isSafeInteger(pageOffset) ||
		pageOffset < 0 ||
		!Number.isSafeInteger(pageLength) ||
		pageLength < 0 ||
		pageOffset + pageLength > sourceRows.length
	) {
		throw integrityError("Review phase section page bounds are invalid");
	}
	const selectedIndexes: number[] = [];
	let chunkStart = 0;
	for (const [index, count] of chunkItemCounts.entries()) {
		const chunkEnd = chunkStart + count;
		const intersects =
			pageLength === 0
				? pageOffset === sourceRows.length && index === chunkItemCounts.length - 1
				: pageOffset < chunkEnd && pageOffset + pageLength > chunkStart;
		if (intersects) selectedIndexes.push(index);
		chunkStart = chunkEnd;
	}
	if (sourceRows.length === 0 && selectedIndexes.length === 0) selectedIndexes.push(0);
	if (selectedIndexes.length === 0) {
		throw integrityError("Review phase page has no chunk witness");
	}
	const firstIndex = selectedIndexes[0]!;
	const lastIndex = selectedIndexes[selectedIndexes.length - 1]!;
	if (
		selectedIndexes.some((index, position) => index !== firstIndex + position) ||
		pageOffset < chunkItemCounts.slice(0, firstIndex).reduce((total, count) => total + count, 0) ||
		pageOffset + pageLength >
			chunkItemCounts.slice(0, lastIndex + 1).reduce((total, count) => total + count, 0)
	) {
		throw integrityError("Review phase page chunk coverage is invalid");
	}
	const selectedRows: unknown[] = [];
	let sourceOffset = 0;
	for (const [index, count] of chunkItemCounts.entries()) {
		if (selectedIndexes.includes(index)) {
			selectedRows.push(...sourceRows.slice(sourceOffset, sourceOffset + count));
		}
		sourceOffset += count;
	}
	return {
		pageOffset,
		sourceRows: selectedRows,
		chunkIndexes: selectedIndexes,
		chunkHashes: selectedIndexes.map((index) => chunkHashes[index]!),
		chunkItemCounts: selectedIndexes.map((index) => chunkItemCounts[index]!),
	};
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
	section?: "POINTS_STANDINGS" | "POINTS_TRAJECTORIES",
	cursorScopeOverride?: string,
	viewerEntryId: number | null = null
): MyTournamentReviewPoints {
	const payload = isRecord(row.payload) ? row.payload : {};
	const source = isRecord(payload.points) ? payload.points : {};
	const sourceRows =
		section === "POINTS_TRAJECTORIES" && Array.isArray(source.trajectoryRows)
			? source.trajectoryRows
			: source.rows;
	const rows = mapPointsRows(sourceRows);
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
			reviewCursorScope(row, view === "SEASON" ? "SEASON_POINTS" : "GAMEWEEK_POINTS", viewerEntryId)
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
	cursorScopeOverride?: string,
	allowRepeatedParticipants = false,
	viewerEntryId: number | null = null
): MyTournamentReviewH2H {
	const payload = isRecord(row.payload) ? row.payload : {};
	const source = mapH2H(payload.h2h, allowRepeatedParticipants);
	if (
		source.matches.length !== Number(row.row_count) ||
		source.standings.length !== Number(row.ready_subject_count)
	) {
		throw integrityError("Review H2H row count does not match publication metadata");
	}
	const cursorScope = cursorScopeOverride ?? reviewCursorScope(row, "H2H", viewerEntryId);
	const selectedMatches = section === "H2H_STANDINGS" ? [] : source.matches;
	const selectedStandings = section === "H2H_FIXTURES" ? [] : source.standings;
	const emptyMatchPage: {
		items: MyTournamentReviewH2HMatch[];
		nextCursor: string | null;
		hasNextPage: boolean;
	} = { items: [], nextCursor: null, hasNextPage: false };
	const emptyStandingPage: {
		items: MyTournamentReviewH2HStanding[];
		nextCursor: string | null;
		hasNextPage: boolean;
	} = { items: [], nextCursor: null, hasNextPage: false };
	// A section request has one pagination stream. In the combined Gameweek
	// shape both collections share the same cursor, so bind the offset to the
	// longer collection; a shorter collection contributes an empty page instead
	// of rejecting a valid continuation past its own length.
	const sharedPageBound = Math.max(selectedMatches.length, selectedStandings.length);
	const page =
		section === "H2H_STANDINGS"
			? emptyMatchPage
			: pageSlice(
					selectedMatches,
					first,
					cursor,
					String(row.revision),
					cursorScope,
					section === undefined ? sharedPageBound : selectedMatches.length
				);
	const standingsPage =
		section === "H2H_FIXTURES"
			? emptyStandingPage
			: pageSlice(
					selectedStandings,
					first,
					cursor,
					String(row.revision),
					cursorScope,
					section === undefined ? sharedPageBound : selectedStandings.length
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
	const matchParticipantIdentitiesByMatch = source.matches.map((match) =>
		[match.home, match.away]
			.filter((side): side is MyTournamentReviewH2HSide => side !== null && !side.isAverage)
			.map((side) => `${match.groupId}:${side.entryId}`)
	);
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
			matchParticipantIdentities: matchParticipantIdentitiesByMatch.flat(),
			matchParticipantIdentitiesByMatch,
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
	cursorScopeOverride?: string,
	viewerEntryId: number | null = null
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
		cursorScopeOverride ?? reviewCursorScope(row, "KNOCKOUT", viewerEntryId)
	);
	const matchIdentities = matches.map((match) => `${match.matchId}:${match.playAgainstId}`);
	const entryIdentities = new Set<string>();
	const applicableEntryIdentities = new Set<string>();
	const notApplicableEntryIdentities = new Set<string>();
	for (const match of matches) {
		for (const side of [match.home, match.away]) {
			if (!side) continue;
			const entryId = String(side.entryId);
			entryIdentities.add(entryId);
			if (side.applicable === true) applicableEntryIdentities.add(entryId);
			if (side.applicable === false) notApplicableEntryIdentities.add(entryId);
		}
	}
	return {
		matches: page.items,
		nextCursor: page.nextCursor,
		hasNextPage: page.hasNextPage,
		coverageWitness: {
			matchIdentities,
			entryIdentities: [...entryIdentities],
			applicableEntryIdentities: [...applicableEntryIdentities],
			notApplicableEntryIdentities: [...notApplicableEntryIdentities],
			pageOffset: cursor?.offset ?? 0,
			pageMatchIdentities: page.items.map((match) => `${match.matchId}:${match.playAgainstId}`),
		},
	};
}

/** Slice a validated full section. The Redis entry is intentionally shared by
 * all page sizes/cursors; only this returned object is page-specific. */
function sliceSeasonSection(
	full: MyTournamentSeasonSection,
	section: MyTournamentReviewSeasonSection,
	first: number,
	cursor: ReviewCursor | null,
	cursorScope: string
): MyTournamentSeasonSection {
	const pageOffset = cursor?.offset ?? 0;
	let points = full.points;
	let h2h = full.h2h;
	let knockout = full.knockout;
	let pageInfo: MyTournamentSeasonSection["pageInfo"];
	if (section === "POINTS_STANDINGS" || section === "POINTS_TRAJECTORIES") {
		if (!full.points) throw integrityError("Review full points section is missing");
		const page = pageSlice(full.points.rows, first, cursor, full.revision, cursorScope);
		points = {
			...full.points,
			rows: page.items,
			nextCursor: page.nextCursor,
			hasNextPage: page.hasNextPage,
			aggregateWitness: {
				...full.points.aggregateWitness,
				pageOnly: true,
				pageOffset,
				pageLength: page.items.length,
				rows: [],
			},
		};
		pageInfo = { hasNextPage: page.hasNextPage, endCursor: page.nextCursor };
	} else if (section === "H2H_STANDINGS" || section === "H2H_FIXTURES") {
		if (!full.h2h) throw integrityError("Review full H2H section is missing");
		const matchPage =
			section === "H2H_STANDINGS"
				? { items: [], nextCursor: null, hasNextPage: false }
				: pageSlice(full.h2h.matches, first, cursor, full.revision, cursorScope);
		const standingPage =
			section === "H2H_FIXTURES"
				? { items: [], nextCursor: null, hasNextPage: false }
				: pageSlice(full.h2h.standings, first, cursor, full.revision, cursorScope);
		const pageHasNext = matchPage.hasNextPage || standingPage.hasNextPage;
		const pageMatches = matchPage.items as MyTournamentReviewH2HMatch[];
		const pageStandings = standingPage.items as MyTournamentReviewH2HStanding[];
		h2h = {
			...full.h2h,
			matches: pageMatches,
			standings: pageStandings,
			nextCursor: matchPage.hasNextPage ? matchPage.nextCursor : standingPage.nextCursor,
			hasNextPage: pageHasNext,
			coverageWitness: {
				pageOnly: true,
				matchIdentities: [],
				matchParticipantIdentities: [],
				matchParticipantIdentitiesByMatch: [],
				standingIdentities: [],
				pageOffset,
				pageMatchParticipantIdentities: pageMatches.flatMap((match) =>
					[match.home, match.away]
						.filter((side): side is MyTournamentReviewH2HSide => side !== null && !side.isAverage)
						.map((side) => `${match.groupId}:${side.entryId}`)
				),
				pageStandingIdentities: pageStandings.map(
					(standing) => `${standing.groupId}:${standing.entryId}`
				),
			},
		};
		pageInfo = { hasNextPage: pageHasNext, endCursor: h2h.nextCursor };
	} else {
		if (!full.knockout) throw integrityError("Review full knockout section is missing");
		const page = pageSlice(full.knockout.matches, first, cursor, full.revision, cursorScope);
		knockout = {
			...full.knockout,
			matches: page.items,
			nextCursor: page.nextCursor,
			hasNextPage: page.hasNextPage,
			coverageWitness: {
				pageOnly: true,
				matchIdentities: [],
				entryIdentities: [],
				applicableEntryIdentities: [],
				notApplicableEntryIdentities: [],
				pageOffset,
				pageMatchIdentities: page.items.map((match) => `${match.matchId}:${match.playAgainstId}`),
			},
		};
		pageInfo = { hasNextPage: page.hasNextPage, endCursor: page.nextCursor };
	}
	return {
		...full,
		points,
		h2h,
		knockout,
		pageInfo,
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
	cursor: ReviewCursor | null,
	viewerEntryId: number | null = null
): MyTournamentGameweekReview {
	if (!row) return emptyGameweek("UNAVAILABLE");
	const scope = mapScopeMeta(row);
	if (scope.format === "POINTS") {
		return {
			state: "READY",
			scope,
			points: pointsFromPayload(
				row,
				first,
				cursor,
				"GAMEWEEK",
				undefined,
				undefined,
				viewerEntryId
			),
			h2h: null,
			knockout: null,
		};
	}
	if (scope.format === "H2H") {
		return {
			state: "READY",
			scope,
			points: null,
			h2h: h2hFromPayload(row, first, cursor, undefined, undefined, false, viewerEntryId),
			knockout: null,
		};
	}
	return {
		state: "READY",
		scope,
		points: null,
		h2h: null,
		knockout: knockoutFromPayload(row, first, cursor, undefined, viewerEntryId),
	};
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
	const rowCount =
		row.row_count === null || row.row_count === undefined ? NaN : Number(row.row_count);
	const expectedSubjectCount =
		row.expected_subject_count === null || row.expected_subject_count === undefined
			? NaN
			: Number(row.expected_subject_count);
	const readySubjectCount =
		row.ready_subject_count === null || row.ready_subject_count === undefined
			? NaN
			: Number(row.ready_subject_count);
	const notApplicableSubjectCount =
		row.not_applicable_subject_count === null || row.not_applicable_subject_count === undefined
			? NaN
			: Number(row.not_applicable_subject_count);
	if (
		!positiveInt(row.event_id) ||
		!positiveInt(row.revision) ||
		!reviewFormat(row.format) ||
		!row.content_sha256 ||
		!/^[0-9a-f]{64}$/.test(row.content_sha256) ||
		!iso(row.event_data_checked_at) ||
		!iso(row.published_at) ||
		!Number.isSafeInteger(rowCount) ||
		rowCount <= 0 ||
		!Number.isSafeInteger(expectedSubjectCount) ||
		expectedSubjectCount <= 0 ||
		!Number.isSafeInteger(readySubjectCount) ||
		readySubjectCount < 0 ||
		!Number.isSafeInteger(notApplicableSubjectCount) ||
		notApplicableSubjectCount < 0 ||
		readySubjectCount + notApplicableSubjectCount !== expectedSubjectCount
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
		row_count: rowCount,
		expected_subject_count: expectedSubjectCount,
		ready_subject_count: readySubjectCount,
		not_applicable_subject_count: notApplicableSubjectCount,
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
		const viewerEntryId = context.principal ? viewerEntryIdForPrincipal(context.principal) : null;
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
					"GAMEWEEK",
					undefined,
					viewerEntryId
				)
			: null;
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2.1:gameweek:${args.tournamentId}:${args.eventId}:viewer:${viewerEntryId ?? "none"}:${head ? reviewHeadKey(head) : `${revision ?? "none"}:${unavailableState}`}:${first}:${cursor?.canonical ?? ""}`,
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
								rowCount: Number(head.row_count),
								expectedSubjectCount: Number(head.expected_subject_count),
								readySubjectCount: Number(head.ready_subject_count),
								notApplicableSubjectCount: Number(head.not_applicable_subject_count),
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
		const payload = mapGameweek(materializedRow, first, cursor, viewerEntryId);
		await writeJsonQueryCache(context, key, payload, REVIEW_CACHE_TTL_SECONDS);
		return payload;
	},

	async loadSeasonReview(context, args) {
		validateReviewEventId(args.throughEventId, "throughEventId");
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
					row.expected_subject_count !== null ||
					row.ready_subject_count !== null ||
					row.not_applicable_subject_count !== null ||
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
			const hasCountMetadata =
				row.row_count !== null ||
				row.expected_subject_count !== null ||
				row.ready_subject_count !== null ||
				row.not_applicable_subject_count !== null;
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
					row_count: row.row_count,
					expected_subject_count: row.expected_subject_count,
					ready_subject_count: row.ready_subject_count,
					not_applicable_subject_count: row.not_applicable_subject_count,
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
				const sectionChunkHashes = manifestSectionChunkHashes(row.manifest) ?? undefined;
				const sectionChunkItemCounts = manifestSectionChunkItemCounts(row.manifest) ?? undefined;
				const pointsSummary =
					format === "POINTS" && headsByEvent.has(eventId)
						? pointsAggregateSummary(row.points_summary)
						: undefined;
				if (
					env.isProduction &&
					format === "POINTS" &&
					headsByEvent.has(eventId) &&
					pointsSummary === null
				) {
					throw integrityError("Review points aggregate summary is missing");
				}
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
						existing.rowCount = row.row_count;
						existing.expectedSubjectCount = row.expected_subject_count;
						existing.readySubjectCount = row.ready_subject_count;
						existing.notApplicableSubjectCount = row.not_applicable_subject_count;
						existing.sectionChunkHashes = sectionChunkHashes;
						existing.sectionChunkItemCounts = sectionChunkItemCounts;
						existing.pointsAggregateSummary = pointsSummary ?? undefined;
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
					rowCount: row.row_count,
					expectedSubjectCount: row.expected_subject_count,
					readySubjectCount: row.ready_subject_count,
					notApplicableSubjectCount: row.not_applicable_subject_count,
					sectionChunkHashes,
					sectionChunkItemCounts,
					pointsAggregateSummary: pointsSummary ?? undefined,
				});
				return phases;
			},
			[]
		);
		phaseDescriptors?.sort((left, right) => left.startEventId - right.startEventId);
		const latestHeadMetadata = latestHead ? rowsByEvent.get(latestHead.event_id) : undefined;
		if (latestHead && !latestHeadMetadata) {
			throw integrityError("Review season latest head metadata disappeared during read");
		}
		const seasonCacheExpectation: SeasonCacheExpectation = {
			state: ready ? "READY" : unavailableState,
			tournamentId: args.tournamentId,
			throughEventId: args.throughEventId,
			latestEventId: latestHead?.event_id ?? null,
			latestRevision: latestHead ? String(latestHead.revision) : null,
			format: latestHeadMetadata ? reviewFormat(latestHeadMetadata.format) : null,
			semanticSha256: latestHead?.content_sha256 ?? null,
			finalizedEventIds,
		};
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2.1:season:${args.tournamentId}:${args.throughEventId}:${unavailableState}:${finalizedEventIds.join(",")}:${metadataRows
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
				seasonCache(candidate, phaseDescriptors ?? [], seasonCacheExpectation)
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
		const latestMeta = latestHeadMetadata!;
		const latestFormat = reviewFormat(latestMeta.format);
		if (!latestFormat || latestMeta.content_sha256 !== latestHead.content_sha256) {
			throw integrityError("Latest review head metadata is invalid");
		}
		const season: MyTournamentSeasonReview = {
			state: "READY",
			tournamentId: args.tournamentId,
			throughEventId: args.throughEventId,
			latestEventId: latestHead.event_id,
			latestRevision: String(latestHead.revision),
			format: latestFormat,
			// The Season root is a metadata-only phase index.  Settled/published
			// timestamps remain on the phase descriptors; payload reads belong to
			// the explicit section root.
			freshness: null,
			finalizedEventIds,
			points: null,
			h2h: null,
			knockout: null,
			semanticSha256: latestHead.content_sha256,
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
			// The section contract exposes revision and semanticSha256 as non-null
			// pins. Never echo caller-supplied identities for a phase that has no
			// active publication; the phase state is already available from the
			// Season index and the client can retry once it becomes READY.
			throw new GraphQLError("Review section is not ready", {
				extensions: { code: "REVIEW_NOT_READY", state: phase.state },
			});
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
		const viewerEntryId = context.principal ? viewerEntryIdForPrincipal(context.principal) : null;
		const sectionCursorScope = reviewSectionCursorScope(
			phaseIdentity,
			viewerEntryId,
			phaseId,
			requestedSection,
			phase.semanticSha256
		);
		const cursor = decodeCursor(args.after, String(phase.revision), sectionCursorScope);
		const expectedCache: SeasonSectionCacheExpectation = {
			seasonId: context.currentSeason.seasonId,
			tournamentId: args.tournamentId,
			viewerEntryId,
			eventId: phase.endEventId,
			throughEventId: args.throughEventId,
			phaseId,
			section: requestedSection,
			revision: String(phase.revision),
			semanticSha256: phase.semanticSha256,
			rowCount: Number(phase.rowCount),
			expectedSubjectCount: Number(phase.expectedSubjectCount),
			readySubjectCount: Number(phase.readySubjectCount),
			notApplicableSubjectCount: Number(phase.notApplicableSubjectCount),
			sectionChunkHashes: phase.sectionChunkHashes?.[requestedSection] ?? null,
			sectionChunkItemCounts: phase.sectionChunkItemCounts?.[requestedSection] ?? null,
			pointsAggregateSummary: phase.pointsAggregateSummary,
			pageOffset: cursor?.offset ?? 0,
			first,
		};
		if (
			env.isProduction &&
			(expectedCache.sectionChunkHashes === null || expectedCache.sectionChunkItemCounts === null)
		) {
			throw integrityError("Review phase section manifest witness is missing");
		}
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2.1:season-section-page:${args.tournamentId}:${args.throughEventId}:${phaseId}:${requestedSection}:viewer:${viewerEntryId ?? "none"}:${expectedCache.revision}:${expectedCache.semanticSha256}:offset:${expectedCache.pageOffset}:first:${expectedCache.first}`,
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
				? pointsFromPayload(
						materializedRow,
						Number.MAX_SAFE_INTEGER,
						null,
						"SEASON",
						expectedFormat === "POINTS"
							? (requestedSection as "POINTS_STANDINGS" | "POINTS_TRAJECTORIES")
							: undefined,
						sectionCursorScope
					)
				: null;
		const h2hSection =
			requestedSection === "H2H_STANDINGS" || requestedSection === "H2H_FIXTURES"
				? requestedSection
				: undefined;
		const h2h =
			expectedFormat === "H2H"
				? h2hFromPayload(
						materializedRow,
						Number.MAX_SAFE_INTEGER,
						null,
						h2hSection,
						sectionCursorScope,
						true
					)
				: null;
		const knockout =
			expectedFormat === "KNOCKOUT"
				? knockoutFromPayload(materializedRow, Number.MAX_SAFE_INTEGER, null, sectionCursorScope)
				: null;
		if (points === null && h2h === null && knockout === null) {
			throw new GraphQLError("Review section is not available for this phase", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const pageLength = points
			? points.rows.length
			: h2h
				? requestedSection === "H2H_FIXTURES"
					? h2h.matches.length
					: h2h.standings.length
				: (knockout?.matches.length ?? 0);
		if (expectedCache.pageOffset > pageLength) {
			throw new GraphQLError("Review cursor is out of range", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const requestedPageLength = Math.min(first, Math.max(0, pageLength - expectedCache.pageOffset));
		const sectionWitness = seasonSectionWitness(
			materializedRow.payload,
			requestedSection,
			materializedRow.__chunkRows,
			expectedCache.pageOffset,
			requestedPageLength
		);
		if (!sectionWitness) {
			throw integrityError("Review phase section witness is missing");
		}
		if (
			expectedCache.sectionChunkHashes !== null &&
			(!expectedCache.sectionChunkItemCounts ||
				sectionWitness.chunkIndexes.some(
					(index, position) =>
						expectedCache.sectionChunkHashes![index] !== sectionWitness.chunkHashes[position] ||
						expectedCache.sectionChunkItemCounts![index] !==
							sectionWitness.chunkItemCounts[position]
				))
		) {
			throw integrityError("Review phase section chunk witness does not match its manifest");
		}
		const pageResult = sliceSeasonSection(
			{
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
					hasNextPage: false,
					endCursor: null,
				},
			},
			requestedSection,
			first,
			cursor,
			sectionCursorScope
		);
		pageResult.__sectionWitness = sectionWitness;
		await writeJsonQueryCache(context, key, pageResult, REVIEW_CACHE_TTL_SECONDS);
		return pageResult;
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
				const eligibleAt = iso(row.eligible_at);
				const readyAt = iso(row.ready_at);
				const observedAt = iso(row.last_observed_at);
				const nextAttemptAt = iso(row.next_attempt_at);
				const degradedAt = iso(row.degraded_at);
				const repairState = reviewRepairState(row.repair_issue_id);
				const errorCode = reviewErrorCode(row.last_error_code);
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
					(row.eligible_at !== null && eligibleAt === null) ||
					(row.ready_at !== null && readyAt === null) ||
					(row.last_observed_at !== null && observedAt === null) ||
					(row.next_attempt_at !== null && nextAttemptAt === null) ||
					(row.degraded_at !== null && degradedAt === null)
				) {
					throw integrityError("Review obligation metadata is invalid");
				}
				return {
					eventId,
					format,
					state,
					eligibleAt,
					readyAt,
					observedAt,
					nextAttemptAt,
					executionAttempts,
					sourceRechecks,
					degradedAt,
					revision: revision === null ? null : String(revision),
					publishedAt,
					repairState,
					errorCode,
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
