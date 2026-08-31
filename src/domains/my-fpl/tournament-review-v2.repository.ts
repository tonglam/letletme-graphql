import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";

import type { GraphQLContext } from "../../graphql/context";
import { hasPlatformAdminAccess, viewerEntryIdForPrincipal } from "../../graphql/authorization";
import { gqlCacheKey } from "../../infra/cache-key";
import { readJsonQueryCache, writeJsonQueryCache } from "../../infra/query-cache";

export type MyTournamentReviewScope = "ACCESSIBLE" | "MANAGED" | "ALL";
export type MyTournamentReviewFormat = "POINTS" | "H2H" | "KNOCKOUT";
export const MY_TOURNAMENT_REVIEW_METRIC_VERSION = "descriptive-v1" as const;
export type MyTournamentReviewState =
	"PENDING" | "WAITING_SOURCE" | "READY" | "DEGRADED" | "UNAVAILABLE";

export type MyTournamentReviewCatalogItem = {
	tournamentId: number;
	name: string;
	creator: string;
	leagueId: number;
	leagueType: string;
	totalTeamNum: number;
	latestFinalizedEventId: number | null;
	latestAvailableEventId: number | null;
	latestRevision: string | null;
	latestFormat: MyTournamentReviewFormat | null;
	state: MyTournamentReviewState;
	publishedAt: string | null;
};

export type MyTournamentReviewCatalog = {
	state: MyTournamentReviewState;
	asOf: string;
	viewerEntryId: number | null;
	adminReadAll: boolean;
	tournaments: MyTournamentReviewCatalogItem[];
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
};

export type MyTournamentReviewKnockoutSide = {
	entryId: number;
	entryName: string;
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
	latestAvailableEventId: number | null;
	events: MyTournamentReviewEventStatus[];
};

type CatalogRow = {
	tournament_id: number;
	name: string;
	creator: string;
	league_id: number;
	league_type: string;
	total_team_num: number;
	latest_finalized_event_id: number | null;
	latest_available_event_id: number | null;
	latest_revision: number | string | null;
	latest_format: string | null;
	latest_state: string | null;
	published_at: Date | string | null;
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
	finalized_event_ids?: unknown;
};

type ObligationRow = {
	event_id: number;
	format: string;
	state: string;
	next_attempt_at: Date | string | null;
	execution_attempts: number;
	source_rechecks: number;
	degraded_at: Date | string | null;
	revision: number | string | null;
	published_at: Date | string | null;
};

export const MY_TOURNAMENT_REVIEW_CATALOG_SQL = `
	SELECT tournament.tournament_id,
	       tournament.name,
	       tournament.creator,
	       tournament.league_id,
	       tournament.league_type::text AS league_type,
	       tournament.total_team_num,
	       finalized.latest_finalized_event_id,
	       head.latest_available_event_id,
	       head.latest_revision,
	       head.latest_format,
	       COALESCE(obligation.latest_state, 'UNAVAILABLE') AS latest_state,
	       head.published_at
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
		SELECT publication.event_id AS latest_available_event_id,
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
		JOIN fpl.events head_event
		  ON head_event.season_id = publication.season_id
		 AND head_event.event_id = publication.event_id
		 AND head_event.finished = true
		 AND head_event.data_checked = true
		 AND head_event.data_checked_at IS NOT NULL
		WHERE review_head.season_id = tournament.season_id
		  AND review_head.tournament_id = tournament.tournament_id
		ORDER BY review_head.event_id DESC
		LIMIT 1
	) head ON true
	LEFT JOIN LATERAL (
		SELECT state AS latest_state
		FROM competition.tournament_review_obligations review_obligation
		WHERE review_obligation.season_id = tournament.season_id
		  AND review_obligation.tournament_id = tournament.tournament_id
		  AND review_obligation.event_id = finalized.latest_finalized_event_id
		ORDER BY review_obligation.event_id DESC
		LIMIT 1
	) obligation ON true
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
					WHERE entry_league.season_id = tournament.season_id
					  AND entry_league.entry_id = $3
					  AND entry_league.league_id = tournament.league_id
					  AND entry_league.league_type = tournament.league_type
				)
			)
		)
	  )
	ORDER BY tournament.updated_at DESC, tournament.tournament_id DESC
`;

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
	       publication.published_at
	FROM competition.tournament_review_publications publication
	JOIN competition.tournament_review_heads head
	  ON head.season_id = publication.season_id
	 AND head.tournament_id = publication.tournament_id
	 AND head.event_id = publication.event_id
	 AND head.revision = publication.revision
	 AND head.content_sha256 = publication.content_sha256
	JOIN fpl.events event
	  ON event.season_id = publication.season_id
	 AND event.event_id = publication.event_id
	WHERE publication.season_id = $1
	  AND publication.tournament_id = $2
	  AND publication.event_id = $3
	  AND event.finished = true
	  AND event.data_checked = true
	  AND event.data_checked_at IS NOT NULL
	  AND ($4::bigint IS NULL OR head.revision = $4::bigint)
	ORDER BY head.revision DESC
	LIMIT 1
`;

export const MY_TOURNAMENT_REVIEW_SEASON_SQL = `
	WITH candidates AS (
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
		       publication.published_at,
		       row_number() OVER (
				PARTITION BY publication.event_id
				ORDER BY head.revision DESC
			) AS revision_rank
		FROM competition.tournament_review_publications publication
		JOIN competition.tournament_review_heads head
		  ON head.season_id = publication.season_id
		 AND head.tournament_id = publication.tournament_id
		 AND head.event_id = publication.event_id
		 AND head.revision = publication.revision
		 AND head.content_sha256 = publication.content_sha256
		JOIN fpl.events event
		  ON event.season_id = publication.season_id
		 AND event.event_id = publication.event_id
		WHERE publication.season_id = $1
		  AND publication.tournament_id = $2
		  AND publication.event_id <= $3
		  AND event.finished = true
		  AND event.data_checked = true
		  AND event.data_checked_at IS NOT NULL
	), finalized AS (
		SELECT * FROM candidates WHERE revision_rank = 1
	), event_window AS (
		SELECT COALESCE(array_agg(event_id ORDER BY event_id), ARRAY[]::integer[]) AS finalized_event_ids
		FROM finalized
	)
	SELECT latest.season_id,
	       latest.tournament_id,
	       latest.event_id,
	       latest.revision,
	       latest.format,
	       latest.schema_version,
	       latest.metric_version,
	       latest.event_data_checked_at,
	       latest.source_min_checked_at,
	       latest.source_max_checked_at,
	       latest.expected_subject_count,
	       latest.ready_subject_count,
	       latest.not_applicable_subject_count,
	       latest.row_count,
	       latest.content_sha256,
	       latest.payload,
	       latest.published_at,
	       event_window.finalized_event_ids
	FROM finalized latest
	CROSS JOIN event_window
	WHERE latest.event_id = (SELECT max(event_id) FROM finalized)
	LIMIT 1
`;

export const MY_TOURNAMENT_REVIEW_STATUS_SQL = `
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
	LEFT JOIN competition.tournament_review_heads head
	  ON head.season_id = obligation.season_id
	 AND head.tournament_id = obligation.tournament_id
	 AND head.event_id = obligation.event_id
	WHERE obligation.season_id = $1
	  AND obligation.tournament_id = $2
	ORDER BY obligation.event_id
`;

const MY_TOURNAMENT_REVIEW_GAMEWEEK_STATE_SQL = `
	SELECT state
	FROM competition.tournament_review_obligations
	WHERE season_id = $1
	  AND tournament_id = $2
	  AND event_id = $3
	LIMIT 1
`;

const MY_TOURNAMENT_REVIEW_SEASON_STATE_SQL = `
	SELECT state
	FROM competition.tournament_review_obligations
	WHERE season_id = $1
	  AND tournament_id = $2
	  AND event_id <= $3
	ORDER BY event_id DESC
	LIMIT 1
`;

const REVIEW_CACHE_TTL_SECONDS = 5 * 60;
const REVIEW_CATALOG_CACHE_TTL_SECONDS = 60;

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

function reviewFormat(value: unknown): MyTournamentReviewFormat | null {
	return value === "POINTS" || value === "H2H" || value === "KNOCKOUT" ? value : null;
}

function reviewState(value: unknown): MyTournamentReviewState {
	if (
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
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw integrityError(`Review points aggregate ${label} is invalid`);
	}
	return number;
}

function requiredInteger(value: unknown, label: string): number {
	const number = requiredNumber(value, label);
	if (!Number.isSafeInteger(number)) {
		throw integrityError(`Review points aggregate ${label} is not an integer`);
	}
	return number;
}

function nullableNumber(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function boundedFirst(value: number | null | undefined): number {
	if (value === null || value === undefined) return 50;
	if (!Number.isInteger(value) || value < 1 || value > 100) {
		throw new GraphQLError("first must be between 1 and 100", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return value;
}

function decodeCursor(value: string | null | undefined): number {
	if (!value) return 0;
	try {
		const decoded = Buffer.from(value, "base64url").toString("utf8");
		const offset = Number(decoded);
		if (Number.isSafeInteger(offset) && offset >= 0) return offset;
	} catch {
		// Fall through to a stable client error.
	}
	throw new GraphQLError("Invalid review cursor", { extensions: { code: "BAD_USER_INPUT" } });
}

function encodeCursor(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64url");
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

function nullableSafeInteger(value: unknown): boolean {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isKnownReviewState(value: unknown): value is MyTournamentReviewState {
	return (
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
		sourceMinCheckedAt <= eventDataCheckedAt &&
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
	return (
		!value.applicable ||
		[value.groupId, value.rank, value.grossPoints, value.transferCost, value.netPoints].every(
			(candidate) => candidate !== null
		)
	);
}

function pointsCache(value: unknown): value is MyTournamentReviewPoints {
	if (!isRecord(value)) return false;
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
		Array.isArray(value.rows) &&
		value.rows.length > 0 &&
		value.rows.every(pointsRowCache) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean"
	);
}

function h2hSideCache(value: unknown): value is MyTournamentReviewH2HSide {
	if (!isRecord(value)) return false;
	return (
		(value.isAverage === true ? value.entryId === null : positiveInt(value.entryId) !== null) &&
		nonEmptyString(value.entryName) &&
		typeof value.isAverage === "boolean" &&
		[value.grossPoints, value.transferCost, value.netPoints, value.matchPoints, value.rank].every(
			(candidate) => nullableSafeInteger(candidate)
		)
	);
}

function h2hCache(value: unknown): value is MyTournamentReviewH2H {
	if (!isRecord(value) || !Array.isArray(value.matches) || !Array.isArray(value.standings)) {
		return false;
	}
	if (value.matches.length === 0) return false;
	const matchesValid = value.matches.every((match) => {
		if (!isRecord(match)) return false;
		return (
			nonEmptyString(match.matchId) &&
			positiveInt(match.groupId) !== null &&
			typeof match.isBye === "boolean" &&
			(match.home === null || h2hSideCache(match.home)) &&
			(match.away === null || h2hSideCache(match.away)) &&
			(match.isBye
				? match.home !== null || match.away !== null
				: match.home !== null && match.away !== null)
		);
	});
	const standingIds = new Set<number>();
	const standingsValid = value.standings.every((standing) => {
		if (!isRecord(standing)) return false;
		const entryId = positiveInt(standing.entryId);
		if (entryId === null || standingIds.has(entryId) || !nonEmptyString(standing.entryName)) {
			return false;
		}
		standingIds.add(entryId);
		return (
			typeof standing.rank === "number" &&
			Number.isSafeInteger(standing.rank) &&
			standing.rank > 0 &&
			[standing.played, standing.won, standing.drawn, standing.lost, standing.matchPoints].every(
				(candidate) =>
					typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
			) &&
			[standing.pointsFor, standing.pointsAgainst].every(
				(candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate)
			)
		);
	});
	return (
		matchesValid &&
		standingsValid &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean"
	);
}

function knockoutSideCache(value: unknown): value is MyTournamentReviewKnockoutSide {
	if (!isRecord(value)) return false;
	return (
		positiveInt(value.entryId) !== null &&
		nonEmptyString(value.entryName) &&
		[
			value.grossPoints,
			value.transferCost,
			value.netPoints,
			value.goalsScored,
			value.goalsConceded,
		].every((candidate) => nullableSafeInteger(candidate))
	);
}

function knockoutCache(value: unknown): value is MyTournamentReviewKnockout {
	if (!isRecord(value) || !Array.isArray(value.matches)) return false;
	if (value.matches.length === 0) return false;
	return (
		value.matches.every((match) => {
			if (!isRecord(match)) return false;
			return (
				positiveInt(match.matchId) !== null &&
				positiveInt(match.playAgainstId) !== null &&
				(match.round === null || positiveInt(match.round) !== null) &&
				(match.name === null || typeof match.name === "string") &&
				(match.winnerEntryId === null || positiveInt(match.winnerEntryId) !== null) &&
				(match.home === null || knockoutSideCache(match.home)) &&
				(match.away === null || knockoutSideCache(match.away)) &&
				(match.home !== null || match.away !== null) &&
				(match.winnerEntryId === null ||
					match.winnerEntryId === match.home?.entryId ||
					match.winnerEntryId === match.away?.entryId)
			);
		}) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		typeof value.hasNextPage === "boolean"
	);
}

function catalogCache(value: unknown): value is MyTournamentReviewCatalog {
	if (!isRecord(value) || !isKnownReviewState(value.state) || !nonEmptyString(value.asOf))
		return false;
	return (
		(value.viewerEntryId === null || positiveInt(value.viewerEntryId) !== null) &&
		typeof value.adminReadAll === "boolean" &&
		Array.isArray(value.tournaments) &&
		value.tournaments.every((item) => {
			if (!isRecord(item)) return false;
			return (
				positiveInt(item.tournamentId) !== null &&
				nonEmptyString(item.name) &&
				nonEmptyString(item.creator) &&
				positiveInt(item.leagueId) !== null &&
				nonEmptyString(item.leagueType) &&
				positiveInt(item.totalTeamNum) !== null &&
				(item.latestFinalizedEventId === null ||
					positiveInt(item.latestFinalizedEventId) !== null) &&
				(item.latestAvailableEventId === null ||
					positiveInt(item.latestAvailableEventId) !== null) &&
				(item.latestFinalizedEventId === null ||
					item.latestAvailableEventId === null ||
					Number(item.latestAvailableEventId) <= Number(item.latestFinalizedEventId)) &&
				(item.latestRevision === null ||
					(/^\d+$/.test(String(item.latestRevision)) && Number(item.latestRevision) > 0)) &&
				(item.latestFormat === null || reviewFormat(item.latestFormat) !== null) &&
				isKnownReviewState(item.state)
			);
		})
	);
}

function gameweekCache(value: unknown): value is MyTournamentGameweekReview {
	if (!isRecord(value)) return false;
	const state = value.state;
	if (
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
	if (value.scope.format === "POINTS") {
		return pointsCache(value.points) && value.h2h === null && value.knockout === null;
	}
	if (value.scope.format === "H2H") {
		return h2hCache(value.h2h) && value.points === null && value.knockout === null;
	}
	return knockoutCache(value.knockout) && value.points === null && value.h2h === null;
}

function seasonCache(value: unknown): value is MyTournamentSeasonReview {
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
		value.format === null
	) {
		return false;
	}
	if (value.format === "POINTS") {
		return pointsCache(value.points) && value.h2h === null && value.knockout === null;
	}
	if (value.format === "H2H") {
		return h2hCache(value.h2h) && value.points === null && value.knockout === null;
	}
	return knockoutCache(value.knockout) && value.points === null && value.h2h === null;
}

function optionalTimestampCache(value: unknown): boolean {
	return value === null || (nonEmptyString(value) && Number.isFinite(Date.parse(value)));
}

function statusCache(value: unknown): value is MyTournamentReviewStatus {
	if (!isRecord(value)) return false;
	if (
		positiveInt(value.tournamentId) === null ||
		(value.latestFinalizedEventId !== null && positiveInt(value.latestFinalizedEventId) === null) ||
		(value.latestAvailableEventId !== null && positiveInt(value.latestAvailableEventId) === null) ||
		(value.latestFinalizedEventId !== null &&
			value.latestAvailableEventId !== null &&
			Number(value.latestAvailableEventId) > Number(value.latestFinalizedEventId)) ||
		!Array.isArray(value.events)
	) {
		return false;
	}
	let previousEventId = 0;
	return value.events.every((event) => {
		if (!isRecord(event)) return false;
		const eventId = positiveInt(event.eventId);
		const revision =
			event.revision === null
				? null
				: /^\d+$/.test(String(event.revision)) && Number(event.revision) > 0
					? String(event.revision)
					: null;
		const attempts = event.executionAttempts;
		const rechecks = event.sourceRechecks;
		if (
			eventId === null ||
			eventId <= previousEventId ||
			reviewFormat(event.format) === null ||
			!isKnownReviewState(event.state) ||
			event.state === "UNAVAILABLE" ||
			!safeInteger(attempts) ||
			attempts < 0 ||
			!safeInteger(rechecks) ||
			rechecks < 0 ||
			(event.revision !== null && revision === null) ||
			!optionalTimestampCache(event.nextAttemptAt) ||
			!optionalTimestampCache(event.degradedAt) ||
			!optionalTimestampCache(event.publishedAt) ||
			(revision !== null && event.publishedAt === null)
		) {
			return false;
		}
		previousEventId = eventId;
		return true;
	});
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
	const latestAvailableEventId =
		row.latest_available_event_id === null ? null : positiveInt(row.latest_available_event_id);
	const latestRevision = row.latest_revision === null ? null : positiveInt(row.latest_revision);
	const publishedAt = iso(row.published_at);
	const latestFormat = reviewFormat(row.latest_format);
	const hasHead = latestAvailableEventId !== null;
	const latestState = row.latest_state === null ? null : catalogState(row.latest_state);
	if (
		!tournamentId ||
		!leagueId ||
		!totalTeamNum ||
		!row.name ||
		!row.creator ||
		!row.league_type ||
		(row.latest_finalized_event_id !== null && latestFinalizedEventId === null) ||
		(row.latest_available_event_id !== null && latestAvailableEventId === null) ||
		(row.latest_revision !== null && latestRevision === null) ||
		(latestFinalizedEventId !== null &&
			latestAvailableEventId !== null &&
			latestAvailableEventId > latestFinalizedEventId) ||
		(hasHead && (!latestRevision || !latestFormat || !publishedAt)) ||
		(!hasHead && (latestRevision !== null || latestFormat !== null || publishedAt !== null)) ||
		(!hasHead && latestState === "READY")
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
		latestAvailableEventId,
		latestRevision: latestRevision === null ? null : String(latestRevision),
		latestFormat,
		state: latestState ?? (hasHead ? "READY" : "UNAVAILABLE"),
		publishedAt,
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
	const payloadHash = (() => {
		try {
			return postgresJsonbContentHash(row.payload);
		} catch {
			return null;
		}
	})();
	if (
		!tournamentId ||
		!eventId ||
		!revision ||
		!format ||
		row.schema_version !== "my-tournament-review-v2" ||
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
		sourceMinMs > eventCheckedMs ||
		sourceMinMs > sourceMaxMs ||
		Date.parse(publishedAt) < sourceMaxMs ||
		!/^[0-9a-f]{64}$/.test(row.content_sha256) ||
		payloadHash !== row.content_sha256
	) {
		throw integrityError("Review publication freshness or count metadata is invalid");
	}
	const payload = row.payload;
	if (
		!isRecord(payload) ||
		payload.schemaVersion !== "my-tournament-review-v2" ||
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
	};
}

function mapPointsRows(value: unknown): MyTournamentReviewPointsRow[] {
	if (!Array.isArray(value)) throw integrityError("Review points rows are invalid");
	return value.map((raw) => {
		if (!isRecord(raw)) throw integrityError("Review points row is invalid");
		const entryId = positiveInt(raw.entryId);
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
				(number) => number !== null && number !== undefined && !Number.isSafeInteger(Number(number))
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
				mapped.seasonGrossPoints,
				mapped.seasonNetPoints,
			].some((number) => number === null)
		) {
			throw integrityError("Review applicable points row is incomplete");
		}
		return mapped;
	});
}

function mapH2HSide(value: unknown): MyTournamentReviewH2HSide | null {
	if (!isRecord(value)) return null;
	if (typeof value.isAverage !== "boolean") return null;
	const entryId = value.entryId === null ? null : positiveInt(value.entryId);
	if (!value.isAverage && !entryId) return null;
	if (value.isAverage && value.entryId !== null) return null;
	const entryName = typeof value.entryName === "string" ? value.entryName.trim() : "";
	const numericValues = [
		value.grossPoints,
		value.transferCost,
		value.netPoints,
		value.matchPoints,
		value.rank,
	];
	if (
		!entryName ||
		numericValues.some(
			(number) => number !== null && number !== undefined && !Number.isSafeInteger(Number(number))
		)
	) {
		return null;
	}
	return {
		entryId,
		entryName,
		isAverage: value.isAverage,
		grossPoints: nullableNumber(value.grossPoints),
		transferCost: nullableNumber(value.transferCost),
		netPoints: nullableNumber(value.netPoints),
		matchPoints: nullableNumber(value.matchPoints),
		rank: nullableNumber(value.rank),
	};
}

function mapH2H(value: unknown): {
	matches: MyTournamentReviewH2HMatch[];
	standings: MyTournamentReviewH2HStanding[];
} {
	if (!isRecord(value)) return { matches: [], standings: [] };
	const matches = Array.isArray(value.matches)
		? value.matches.map((raw) => {
				if (!isRecord(raw)) throw integrityError("Review H2H match payload is invalid");
				const groupId = Number(raw.groupId);
				if (
					typeof raw.matchId !== "string" ||
					raw.matchId.length === 0 ||
					!Number.isSafeInteger(groupId) ||
					groupId <= 0 ||
					typeof raw.isBye !== "boolean" ||
					(raw.home !== null && !mapH2HSide(raw.home)) ||
					(raw.away !== null && !mapH2HSide(raw.away)) ||
					(raw.isBye
						? raw.home === null && raw.away === null
						: raw.home === null || raw.away === null)
				) {
					throw integrityError("Review H2H match payload is invalid");
				}
				return {
					matchId: raw.matchId,
					groupId,
					home: mapH2HSide(raw.home),
					away: mapH2HSide(raw.away),
					isBye: raw.isBye === true,
				};
			})
		: [];
	const standings = Array.isArray(value.standings)
		? value.standings.map((raw) => {
				if (!isRecord(raw)) throw integrityError("Review H2H standing payload is invalid");
				const groupId = positiveInt(raw.groupId);
				const entryId = positiveInt(raw.entryId);
				if (!groupId || !entryId) throw integrityError("Review H2H standing payload is invalid");
				const rank = Number(raw.rank);
				const played = Number(raw.played);
				const won = Number(raw.won);
				const drawn = Number(raw.drawn);
				const lost = Number(raw.lost);
				const matchPoints = Number(raw.matchPoints);
				const pointsFor = Number(raw.pointsFor);
				const pointsAgainst = Number(raw.pointsAgainst);
				if (
					![rank, played, won, drawn, lost, matchPoints].every(
						(number) => Number.isSafeInteger(number) && number >= 0
					) ||
					![pointsFor, pointsAgainst].every((number) => Number.isSafeInteger(number)) ||
					rank < 1
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
	return { matches, standings };
}

function mapKnockoutSide(value: unknown): MyTournamentReviewKnockoutSide | null {
	if (!isRecord(value)) return null;
	const entryId = positiveInt(value.entryId);
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
		numericValues.some(
			(number) => number !== null && number !== undefined && !Number.isSafeInteger(Number(number))
		)
	) {
		return null;
	}
	return {
		entryId,
		entryName,
		grossPoints: nullableNumber(value.grossPoints),
		transferCost: nullableNumber(value.transferCost),
		netPoints: nullableNumber(value.netPoints),
		goalsScored: nullableNumber(value.goalsScored),
		goalsConceded: nullableNumber(value.goalsConceded),
	};
}

function mapKnockout(value: unknown): MyTournamentReviewKnockoutMatch[] {
	if (!isRecord(value) || !Array.isArray(value.matches)) return [];
	return value.matches.map((raw) => {
		if (!isRecord(raw)) throw integrityError("Review knockout match payload is invalid");
		const matchId = positiveInt(raw.matchId);
		const playAgainstId = positiveInt(raw.playAgainstId);
		if (!matchId || !playAgainstId)
			throw integrityError("Review knockout match payload is invalid");
		const round = raw.round === null || raw.round === undefined ? null : positiveInt(raw.round);
		const winnerEntryId =
			raw.winnerEntryId === null || raw.winnerEntryId === undefined
				? null
				: positiveInt(raw.winnerEntryId);
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
			(winnerEntryId !== null && winnerEntryId !== home?.entryId && winnerEntryId !== away?.entryId)
		) {
			throw integrityError("Review knockout match payload is invalid");
		}
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
	after: string | null | undefined
): {
	items: T[];
	nextCursor: string | null;
	hasNextPage: boolean;
} {
	const start = decodeCursor(after);
	const items = values.slice(start, start + first);
	const hasNextPage = start + items.length < values.length;
	return {
		items,
		nextCursor: hasNextPage ? encodeCursor(start + items.length) : null,
		hasNextPage,
	};
}

function pointsFromPayload(
	row: PublicationRow,
	first: number,
	after: string | null | undefined,
	view: "GAMEWEEK" | "SEASON" = "GAMEWEEK"
): MyTournamentReviewPoints {
	const payload = isRecord(row.payload) ? row.payload : {};
	const source = isRecord(payload.points) ? payload.points : {};
	const rows = mapPointsRows(source.rows);
	if (rows.length !== Number(row.row_count)) {
		throw integrityError("Review points row count does not match publication metadata");
	}
	if (source.headline !== "gross") {
		throw integrityError("Review points headline metric is invalid");
	}
	const grossPointsTotal = requiredInteger(
		view === "SEASON" ? source.seasonGrossPointsTotal : source.grossPointsTotal,
		view === "SEASON" ? "seasonGrossPointsTotal" : "grossPointsTotal"
	);
	const grossPointsAverage = requiredNumber(
		view === "SEASON" ? source.seasonGrossPointsAverage : source.grossPointsAverage,
		view === "SEASON" ? "seasonGrossPointsAverage" : "grossPointsAverage"
	);
	const netPointsTotal = requiredInteger(
		view === "SEASON" ? source.seasonNetPointsTotal : source.netPointsTotal,
		view === "SEASON" ? "seasonNetPointsTotal" : "netPointsTotal"
	);
	const seasonGrossPointsTotal = requiredInteger(
		source.seasonGrossPointsTotal,
		"seasonGrossPointsTotal"
	);
	const seasonGrossPointsAverage = requiredNumber(
		source.seasonGrossPointsAverage,
		"seasonGrossPointsAverage"
	);
	const seasonNetPointsTotal = requiredInteger(source.seasonNetPointsTotal, "seasonNetPointsTotal");
	const page = pageSlice(rows, first, after);
	return {
		headlineMetric: "gross",
		grossPointsTotal,
		grossPointsAverage,
		netPointsTotal,
		seasonGrossPointsTotal,
		seasonGrossPointsAverage,
		seasonNetPointsTotal,
		rows:
			view === "SEASON"
				? page.items.map((item) => ({
						...item,
						grossPoints: item.seasonGrossPoints,
						netPoints: item.seasonNetPoints,
					}))
				: page.items,
		nextCursor: page.nextCursor,
		hasNextPage: page.hasNextPage,
	};
}

function h2hFromPayload(
	row: PublicationRow,
	first: number,
	after: string | null | undefined
): MyTournamentReviewH2H {
	const payload = isRecord(row.payload) ? row.payload : {};
	const source = mapH2H(payload.h2h);
	if (
		source.matches.length !== Number(row.row_count) ||
		source.standings.length !== Number(row.ready_subject_count)
	) {
		throw integrityError("Review H2H row count does not match publication metadata");
	}
	const page = pageSlice(source.matches, first, after);
	return {
		matches: page.items,
		standings: source.standings,
		nextCursor: page.nextCursor,
		hasNextPage: page.hasNextPage,
	};
}

function knockoutFromPayload(
	row: PublicationRow,
	first: number,
	after: string | null | undefined
): MyTournamentReviewKnockout {
	const payload = isRecord(row.payload) ? row.payload : {};
	const matches = mapKnockout(payload.knockout);
	if (matches.length !== Number(row.row_count)) {
		throw integrityError("Review knockout row count does not match publication metadata");
	}
	const page = pageSlice(matches, first, after);
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
	after: string | null | undefined
): MyTournamentGameweekReview {
	if (!row) return emptyGameweek("UNAVAILABLE");
	const scope = mapScopeMeta(row);
	if (scope.format === "POINTS") {
		return {
			state: "READY",
			scope,
			points: pointsFromPayload(row, first, after),
			h2h: null,
			knockout: null,
		};
	}
	if (scope.format === "H2H") {
		return {
			state: "READY",
			scope,
			points: null,
			h2h: h2hFromPayload(row, first, after),
			knockout: null,
		};
	}
	return {
		state: "READY",
		scope,
		points: null,
		h2h: null,
		knockout: knockoutFromPayload(row, first, after),
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

export type MyTournamentReviewRepository = {
	loadCatalog(
		context: GraphQLContext,
		scope: MyTournamentReviewScope
	): Promise<MyTournamentReviewCatalog>;
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
	loadStatus(context: GraphQLContext, tournamentId: number): Promise<MyTournamentReviewStatus>;
};

export const createMyTournamentReviewRepository = (): MyTournamentReviewRepository => ({
	async loadCatalog(context, scope) {
		const viewerEntryId = context.principal ? viewerEntryIdForPrincipal(context.principal) : null;
		const catalogEntryId =
			scope === "MANAGED" ? (context.principal?.fplEntryId ?? null) : viewerEntryId;
		const rawRows = await context.database.query<CatalogRow>(MY_TOURNAMENT_REVIEW_CATALOG_SQL, [
			context.currentSeason.seasonId,
			scope,
			catalogEntryId,
		]);
		const rows = rawRows.rows.map(mapCatalogRow);
		const revisionKey = rows
			.map(
				(row) =>
					`${row.tournamentId}:${row.latestAvailableEventId ?? 0}:${row.latestRevision ?? "0"}`
			)
			.join(",");
		const adminReadAll = Boolean(context.principal && hasPlatformAdminAccess(context.principal));
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2:catalog:${scope}:viewer:${viewerEntryId ?? 0}:catalog-entry:${catalogEntryId ?? 0}:admin:${adminReadAll ? 1 : 0}:${revisionKey}`
		);
		const cached = await readJsonQueryCache(context, key, (value) =>
			cacheDecoder<MyTournamentReviewCatalog>(value, catalogCache)
		);
		if (cached) return cached;
		const result: MyTournamentReviewCatalog = {
			state: rows.some((row) => row.state === "READY")
				? "READY"
				: rows.length
					? rows[0]!.state
					: "UNAVAILABLE",
			asOf: new Date().toISOString(),
			viewerEntryId,
			adminReadAll,
			tournaments: rows,
		};
		await writeJsonQueryCache(context, key, result, REVIEW_CATALOG_CACHE_TTL_SECONDS);
		return result;
	},

	async loadGameweekReview(context, args) {
		const first = boundedFirst(args.first);
		const revision = args.revision?.trim() || null;
		if (
			revision &&
			(!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) <= 0)
		) {
			throw new GraphQLError("revision must be a positive integer", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const result = await context.database.query<PublicationRow>(
			MY_TOURNAMENT_REVIEW_PUBLICATION_SQL,
			[context.currentSeason.seasonId, args.tournamentId, args.eventId, revision]
		);
		const row = result.rows[0] ?? null;
		const unavailableState = row
			? "READY"
			: requireNonReadyObligationState(
					(
						await context.database.query<{ state: string }>(
							MY_TOURNAMENT_REVIEW_GAMEWEEK_STATE_SQL,
							[context.currentSeason.seasonId, args.tournamentId, args.eventId]
						)
					).rows[0]?.state
				);
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2:gameweek:${args.tournamentId}:${args.eventId}:${row ? String(row.revision) : `${revision ?? "none"}:${unavailableState}`}:${first}:${args.after ?? ""}`
		);
		const cached = await readJsonQueryCache(context, key, (value) =>
			cacheDecoder<MyTournamentGameweekReview>(value, gameweekCache)
		);
		if (cached) return cached;
		const payload = row ? mapGameweek(row, first, args.after) : emptyGameweek(unavailableState);
		await writeJsonQueryCache(context, key, payload, REVIEW_CACHE_TTL_SECONDS);
		return payload;
	},

	async loadSeasonReview(context, args) {
		const first = boundedFirst(args.first);
		const result = await context.database.query<PublicationRow>(MY_TOURNAMENT_REVIEW_SEASON_SQL, [
			context.currentSeason.seasonId,
			args.tournamentId,
			args.throughEventId,
		]);
		const rows = parsePublicationRows(result.rows);
		for (const row of rows) mapScopeMeta(row);
		const latest = rows[0] ?? null;
		const unavailableState = latest
			? "READY"
			: requireNonReadyObligationState(
					(
						await context.database.query<{ state: string }>(MY_TOURNAMENT_REVIEW_SEASON_STATE_SQL, [
							context.currentSeason.seasonId,
							args.tournamentId,
							args.throughEventId,
						])
					).rows[0]?.state
				);
		const finalizedEventIds =
			parseFinalizedEventIds(latest?.finalized_event_ids) ??
			[...new Set(rows.map((row) => Number(row.event_id)))].sort((a, b) => a - b);
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2:season:${args.tournamentId}:${args.throughEventId}:${first}:${args.after ?? ""}:${unavailableState}:${finalizedEventIds.join(",")}:${rows.map((row) => `${row.event_id}:${row.revision}`).join(",")}`
		);
		const cached = await readJsonQueryCache(context, key, (value) =>
			cacheDecoder<MyTournamentSeasonReview>(value, seasonCache)
		);
		if (cached) return cached;
		if (!latest) {
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
			};
			await writeJsonQueryCache(context, key, unavailable, REVIEW_CACHE_TTL_SECONDS);
			return unavailable;
		}
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
			points:
				latestFormat === "POINTS" ? pointsFromPayload(latest, first, args.after, "SEASON") : null,
			h2h: latestFormat === "H2H" ? h2hFromPayload(latest, first, args.after) : null,
			knockout: latestFormat === "KNOCKOUT" ? knockoutFromPayload(latest, first, args.after) : null,
		};
		await writeJsonQueryCache(context, key, season, REVIEW_CACHE_TTL_SECONDS);
		return season;
	},

	async loadStatus(context, tournamentId) {
		const result = await context.database.query<ObligationRow>(MY_TOURNAMENT_REVIEW_STATUS_SQL, [
			context.currentSeason.seasonId,
			tournamentId,
		]);
		const events = result.rows.map((row) => {
			const eventId = positiveInt(row.event_id);
			const format = reviewFormat(row.format);
			const state = reviewState(row.state);
			const executionAttempts = Number(row.execution_attempts);
			const sourceRechecks = Number(row.source_rechecks);
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
		const revisionKey = events
			.map(
				(row) =>
					`${row.eventId}:${row.revision ?? "0"}:${row.state}:${row.executionAttempts}:${row.sourceRechecks}`
			)
			.join(",");
		const key = gqlCacheKey(
			context,
			`my-tournament-review-v2:status:${tournamentId}:${revisionKey}`
		);
		const cached = await readJsonQueryCache(context, key, (value) => {
			if (!isRecord(value) || value.tournamentId !== tournamentId || !statusCache(value)) {
				return null;
			}
			return value as MyTournamentReviewStatus;
		});
		if (cached) return cached;
		const status: MyTournamentReviewStatus = {
			tournamentId,
			latestFinalizedEventId: events.length ? events[events.length - 1]!.eventId : null,
			latestAvailableEventId: events.reduce<number | null>(
				(latest, row) => (row.revision ? row.eventId : latest),
				null
			),
			events,
		};
		await writeJsonQueryCache(context, key, status, REVIEW_CACHE_TTL_SECONDS);
		return status;
	},
});

export const myTournamentReviewRepository = createMyTournamentReviewRepository();
