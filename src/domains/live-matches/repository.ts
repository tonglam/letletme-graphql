import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { QueryResultRow } from "pg";

import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import type { GraphQLContext } from "../../graphql/context";

export const LIVE_MATCHES_CONTRACT_VERSION = "live-matches-v2" as const;
export const LIVE_MATCHES_REDIS_PREFIX = "llm:data:v2:fpl:live-match";
export const LIVE_MATCHES_POSTGRES_TIMEOUT_MS = 400;
export const LIVE_MATCHES_PROCESS_LKG_LIMIT = 8;
export const LIVE_MATCH_ACTIVE_EVENT_REVALIDATION_MS = 30_000;
export const LIVE_MATCH_MAX_FIXTURES = 32;
export const LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE = 64;
export const LIVE_MATCH_MAX_STATS_PER_PLAYER = 32;
export const LIVE_MATCH_MAX_PUBLICATION_BYTES = 128 * 1024;
export const LIVE_MATCH_MAX_DESK_BYTES = 128 * 1024;
export const LIVE_MATCH_MAX_DETAIL_ITEM_BYTES = 256 * 1024;
export const LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES = 2 * 1024 * 1024;
const LIVE_MATCH_MAX_REDIS_BUNDLE_BYTES = 12 * 1024 * 1024;

type MatchLifecycleState =
	"PRE_DEADLINE" | "LIVE_ACTIVE" | "BETWEEN_FIXTURES" | "DAY_SETTLING" | "GW_REVIEW" | "FINALIZED";

type StreamRevision = Readonly<{
	revision: string;
	contentUpdatedAt: string;
}>;

type PublicationItem = Readonly<{
	name: "desk";
	key: string;
	type: "string";
	count: number;
	bytes: number;
	sha256: string;
}>;

export type MatchDeskFixture = Readonly<{
	fixtureId: number;
	eventId: number;
	homeTeamId: number;
	homeTeamName: string;
	homeTeamShortName: string;
	awayTeamId: number;
	awayTeamName: string;
	awayTeamShortName: string;
	homeScore: number | null;
	awayScore: number | null;
	kickoffTime: string | null;
	minutes: number;
	started: boolean;
	finished: boolean;
	finishedProvisional: boolean;
}>;

export type MatchDetailStat = Readonly<{
	identifier: string;
	value: number;
	points: number;
	pointsModification: number | null;
}>;

export type MatchDetailPlayer = Readonly<{
	id: number;
	webName: string;
	position: number;
	teamId: number;
	totalPoints: number;
	stats: readonly MatchDetailStat[];
}>;

export type MatchFixtureDetail = Readonly<{
	fixtureId: number;
	players: readonly MatchDetailPlayer[];
}>;

type MatchDeskPublication = Readonly<{
	contractVersion: typeof LIVE_MATCHES_CONTRACT_VERSION;
	publicationId: string;
	generation: number;
	season: string;
	eventId: number;
	state: MatchLifecycleState;
	sourceCheckedAt: string;
	publishedAt: string;
	checkpointedAt: string | null;
	expectedNextCheckAt: string | null;
	staleAt: string | null;
	revisions: {
		lifecycle: StreamRevision;
		fixtureIdentity: StreamRevision;
		scoreState: StreamRevision;
	};
	desk: PublicationItem;
}>;

type FixtureDetailItem = Readonly<{
	fixtureId: number;
	key: string;
	type: "string";
	count: number;
	bytes: number;
	sha256: string;
}>;

type MatchDetailPublication = Readonly<{
	contractVersion: typeof LIVE_MATCHES_CONTRACT_VERSION;
	publicationId: string;
	generation: number;
	season: string;
	eventId: number;
	/** Internal finalization fence; never exposed in the GraphQL schema. */
	finalized: boolean;
	observedDeskGeneration: number;
	fixtureIdentityRevision: string;
	sourceCheckedAt: string;
	publishedAt: string;
	checkpointedAt: string | null;
	expectedNextCheckAt: string | null;
	staleAt: string | null;
	detail: StreamRevision;
	fixtures: readonly FixtureDetailItem[];
}>;

type MatchDeskCandidate = Readonly<{
	publication: MatchDeskPublication;
	fixtures: readonly MatchDeskFixture[];
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "PROCESS_LKG" | "POSTGRES_CHECKPOINT";
}>;

type MatchDetailCandidate = Readonly<{
	publication: MatchDetailPublication;
	fixtures: readonly MatchFixtureDetail[];
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "PROCESS_LKG" | "POSTGRES_CHECKPOINT";
}>;

export type LiveMatchdayRead = Readonly<{
	season: string;
	eventId: number | null;
	desk: MatchDeskCandidate | null;
	detail: MatchDetailCandidate | null;
	redisReadFailed: boolean;
	postgresReadFailed: boolean;
}>;

type RedisDeskRaw = Readonly<{
	publication: string | null;
	payload: string | null;
	metadata: string | null;
}>;

type RedisDetailItemRaw = Readonly<{
	fixtureId: number | null;
	key: string | null;
	payload: string | null;
	metadata: string | null;
}>;

type RedisDetailRaw = Readonly<{
	publication: string | null;
	manifest: string | null;
	items: readonly RedisDetailItemRaw[];
}>;

type RedisReadBundle = Readonly<{
	eventId: number | null;
	desk: { active: RedisDeskRaw; previous: RedisDeskRaw };
	detail: { active: RedisDetailRaw; previous: RedisDetailRaw };
}>;

type SelectedLkg = Readonly<{
	desk: MatchDeskCandidate;
	detail: MatchDetailCandidate | null;
}>;

type CheckpointRow = QueryResultRow & {
	event_id: unknown;
	desk: unknown;
	detail: unknown;
};

type PostgresCheckpointRead = Readonly<{
	eventId: number | null;
	desk: MatchDeskCandidate | null;
	detail: MatchDetailCandidate | null;
}>;

const processLkg = new Map<string, SelectedLkg>();
const processActiveEvent = new Map<string, number>();
const processActiveEventCheckedAt = new Map<string, number>();
const postgresDetailMissUntil = new Map<string, number>();
let postgresCircuitOpenUntil = 0;
let postgresCircuitFailures = 0;
const postgresReadFlights = new Map<string, Promise<PostgresCheckpointRead | null>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isIso = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const safeInteger = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const finiteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const nonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

// Data's V2 checkpoint contract reserves a fixed-width publication identity.
// Keep the reader boundary equally strict so an arbitrary non-empty value
// cannot become a trusted publication reference after Redis/PG recovery.
const validPublicationId = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

const stableJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
};

const sha256 = (value: unknown): string =>
	createHash("sha256").update(stableJson(value), "utf8").digest("hex");

const sha256Raw = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex");

const canonicalBytes = (value: unknown): number => Buffer.byteLength(stableJson(value), "utf8");

const deskLifecycleRevision = (state: MatchLifecycleState): string => sha256({ state });

const deskFixtureIdentityRevision = (fixtures: readonly MatchDeskFixture[]): string =>
	sha256(
		fixtures.map((fixture) => ({
			fixtureId: fixture.fixtureId,
			eventId: fixture.eventId,
			homeTeamId: fixture.homeTeamId,
			homeTeamName: fixture.homeTeamName,
			homeTeamShortName: fixture.homeTeamShortName,
			awayTeamId: fixture.awayTeamId,
			awayTeamName: fixture.awayTeamName,
			awayTeamShortName: fixture.awayTeamShortName,
			kickoffTime: fixture.kickoffTime,
		}))
	);

const deskScoreStateRevision = (fixtures: readonly MatchDeskFixture[]): string =>
	sha256(
		fixtures.map((fixture) => ({
			fixtureId: fixture.fixtureId,
			homeScore: fixture.homeScore,
			awayScore: fixture.awayScore,
			minutes: fixture.minutes,
			started: fixture.started,
			finished: fixture.finished,
			finishedProvisional: fixture.finishedProvisional,
		}))
	);

const deskRevisionsMatchPayload = (
	publication: MatchDeskPublication,
	fixtures: readonly MatchDeskFixture[]
): boolean =>
	publication.revisions.lifecycle.revision === deskLifecycleRevision(publication.state) &&
	publication.revisions.fixtureIdentity.revision === deskFixtureIdentityRevision(fixtures) &&
	publication.revisions.scoreState.revision === deskScoreStateRevision(fixtures);

const parsedJson = (raw: string | null): unknown => {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
};

const deskItemKey = (season: string, eventId: number, generation: number): string =>
	`${LIVE_MATCHES_REDIS_PREFIX}:desk:${season}:${eventId}:${generation}:desk`;

const detailItemKeyMatches = (
	key: unknown,
	season: string,
	eventId: number,
	fixtureId: number,
	sha: string
): key is string => {
	if (typeof key !== "string") return false;
	const prefix = `${LIVE_MATCHES_REDIS_PREFIX}:detail:${season}:${eventId}:`;
	const suffix = `:${fixtureId}:${sha}`;
	if (!key.startsWith(prefix) || !key.endsWith(suffix)) return false;
	const generation = key.slice(prefix.length, key.length - suffix.length);
	return /^[1-9][0-9]*$/.test(generation);
};

/**
 * Redis is read with one script so a desk/detail pair cannot be observed
 * through a sequence of independently changing MGETs. The script returns raw
 * JSON; all contract validation remains in TypeScript where it is testable.
 */
export const LIVE_MATCHES_READ_BUNDLE_LUA = `
local season = ARGV[1]
local requested_event = ARGV[2]

local function null_value()
  return cjson.null
end

local function redis_type(key)
  local value = redis.call("TYPE", key)
  if type(value) == "table" then value = value["ok"] end
  return value
end

local function read_string(key)
  if redis_type(key) ~= "string" then return nil end
  return redis.call("GET", key)
end

local function positive_integer(value)
  return type(value) == "number" and value > 0 and value == math.floor(value)
end

local function bounded_integer(value, maximum)
  return type(value) == "number" and value >= 0 and value <= maximum and value == math.floor(value)
end

local function valid_sha(value)
  return type(value) == "string" and string.len(value) == 64 and string.match(value, "^[0-9a-f]+$") ~= nil
end

local event_id = requested_event
if event_id == "" then
  event_id = read_string("${LIVE_MATCHES_REDIS_PREFIX}:" .. season .. ":active-event") or ""
end
if event_id ~= "" and string.match(event_id, "^[1-9][0-9]*$") == nil then event_id = "" end

local function desk_candidate(pointer)
  if event_id == "" then return { publication = null_value(), payload = null_value(), metadata = null_value() } end
  local publication_key = "${LIVE_MATCHES_REDIS_PREFIX}:desk:" .. season .. ":" .. event_id .. ":" .. pointer
  local publication = read_string(publication_key)
  if not publication then return { publication = null_value(), payload = null_value(), metadata = null_value() } end
  if string.len(publication) > ${LIVE_MATCH_MAX_PUBLICATION_BYTES} then
    return { publication = publication, payload = null_value(), metadata = null_value() }
  end
  local decoded = nil
  local ok = pcall(function() decoded = cjson.decode(publication) end)
  if not ok or type(decoded) ~= "table" or decoded.contractVersion ~= "live-matches-v2" or decoded.season ~= season or decoded.eventId ~= tonumber(event_id) or not positive_integer(decoded.generation) then
    return { publication = publication, payload = null_value(), metadata = null_value() }
  end
  local item = decoded.desk
  local expected_key = "${LIVE_MATCHES_REDIS_PREFIX}:desk:" .. season .. ":" .. event_id .. ":" .. tostring(decoded.generation) .. ":desk"
  if type(item) ~= "table" or item.name ~= "desk" or item.key ~= expected_key or item.type ~= "string" or not bounded_integer(item.count, ${LIVE_MATCH_MAX_FIXTURES}) or not bounded_integer(item.bytes, ${LIVE_MATCH_MAX_DESK_BYTES}) or not valid_sha(item.sha256) then
    return { publication = publication, payload = null_value(), metadata = null_value() }
  end
  local expected_metadata = tostring(item.count) .. "|" .. tostring(item.bytes) .. "|" .. item.sha256
  if redis_type(item.key) ~= "string" or redis.call("STRLEN", item.key) ~= item.bytes or read_string(item.key .. ":meta") ~= expected_metadata then
    return { publication = publication, payload = null_value(), metadata = null_value() }
  end
  return {
    publication = publication,
    payload = read_string(item.key) or null_value(),
    metadata = expected_metadata
  }
end

local function detail_candidate(pointer)
  if event_id == "" then return { publication = null_value(), manifest = null_value(), items = {} } end
  local publication_key = "${LIVE_MATCHES_REDIS_PREFIX}:detail:" .. season .. ":" .. event_id .. ":" .. pointer
  local publication = read_string(publication_key)
  if not publication then return { publication = null_value(), manifest = null_value(), items = {} } end
  if string.len(publication) > ${LIVE_MATCH_MAX_PUBLICATION_BYTES} then
    return { publication = publication, manifest = null_value(), items = {} }
  end
  local decoded = nil
  local ok = pcall(function() decoded = cjson.decode(publication) end)
  if not ok or type(decoded) ~= "table" or decoded.contractVersion ~= "live-matches-v2" or decoded.season ~= season or decoded.eventId ~= tonumber(event_id) or not positive_integer(decoded.generation) or type(decoded.fixtures) ~= "table" or #decoded.fixtures > ${LIVE_MATCH_MAX_FIXTURES} then
    return { publication = publication, manifest = null_value(), items = {} }
  end
  local manifest_key = "${LIVE_MATCHES_REDIS_PREFIX}:detail:" .. season .. ":" .. event_id .. ":" .. tostring(decoded.generation) .. ":manifest"
  local manifest = read_string(manifest_key)
  local items = {}
  if not manifest or string.len(manifest) > ${LIVE_MATCH_MAX_PUBLICATION_BYTES} or manifest ~= publication then
    return { publication = publication, manifest = manifest or null_value(), items = items }
  end
  local total_bytes = 0
  local seen = {}
  for _, item in ipairs(decoded.fixtures) do
    if type(item) ~= "table" or not positive_integer(item.fixtureId) or type(item.key) ~= "string" or item.type ~= "string" or not bounded_integer(item.count, ${LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE}) or not bounded_integer(item.bytes, ${LIVE_MATCH_MAX_DETAIL_ITEM_BYTES}) or not valid_sha(item.sha256) then
      return { publication = publication, manifest = manifest, items = {} }
    end
    local fixture_key = tostring(item.fixtureId)
    if seen[fixture_key] then return { publication = publication, manifest = manifest, items = {} } end
    seen[fixture_key] = true
    local prefix = "${LIVE_MATCHES_REDIS_PREFIX}:detail:" .. season .. ":" .. event_id .. ":"
    local suffix = ":" .. fixture_key .. ":" .. item.sha256
    if string.sub(item.key, 1, string.len(prefix)) ~= prefix or string.sub(item.key, -string.len(suffix)) ~= suffix then
      return { publication = publication, manifest = manifest, items = {} }
    end
    local item_generation = string.sub(item.key, string.len(prefix) + 1, string.len(item.key) - string.len(suffix))
    if string.match(item_generation, "^[1-9][0-9]*$") == nil then
      return { publication = publication, manifest = manifest, items = {} }
    end
    total_bytes = total_bytes + item.bytes
    if total_bytes > ${LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES} then
      return { publication = publication, manifest = manifest, items = {} }
    end
  end
  for _, item in ipairs(decoded.fixtures) do
    local expected_metadata = tostring(item.count) .. "|" .. tostring(item.bytes) .. "|" .. item.sha256
    if redis_type(item.key) ~= "string" or redis.call("STRLEN", item.key) ~= item.bytes or read_string(item.key .. ":meta") ~= expected_metadata then
      return { publication = publication, manifest = manifest, items = {} }
    end
    table.insert(items, {
      fixtureId = item.fixtureId,
      key = item.key,
      payload = read_string(item.key) or null_value(),
      metadata = expected_metadata
    })
  end
  return { publication = publication, manifest = manifest or null_value(), items = items }
end

return cjson.encode({
  eventId = event_id == "" and null_value() or tonumber(event_id),
  desk = { active = desk_candidate("active"), previous = desk_candidate("previous") },
  detail = { active = detail_candidate("active"), previous = detail_candidate("previous") }
})
`;

/** PostgreSQL is a cold fallback only; it is never part of the warm Redis path. */
export const LIVE_MATCH_CHECKPOINT_SQL = `
WITH target_event AS (
  SELECT COALESCE(
    $2::integer,
    (
      SELECT checkpoint.event_id
      FROM fpl.live_match_desk_checkpoints checkpoint
      WHERE checkpoint.season_id = $1
      ORDER BY checkpoint.event_id DESC
      LIMIT 1
    )
  ) AS event_id
)
SELECT
  target_event.event_id,
  (
    SELECT to_jsonb(checkpoint)
    FROM fpl.live_match_desk_checkpoints checkpoint
    WHERE checkpoint.season_id = $1
      AND checkpoint.event_id = target_event.event_id
    LIMIT 1
  ) AS desk,
  (
    SELECT to_jsonb(checkpoint)
    FROM fpl.live_match_detail_checkpoints checkpoint
    WHERE checkpoint.season_id = $1
      AND checkpoint.event_id = target_event.event_id
    LIMIT 1
  ) AS detail
FROM target_event
`;

/** Planner, decoded-column, and reader-role gate for the cold fallback. */
export const LIVE_MATCHES_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "live-matches-v2.checkpoint-fallback",
		sql: LIVE_MATCH_CHECKPOINT_SQL,
		values: [2026, 1],
		runtime: "must-return-row",
		resultTypes: [
			{ relation: "fpl.live_match_desk_checkpoints", column: "season_id", pgType: "smallint" },
			{ relation: "fpl.live_match_desk_checkpoints", column: "event_id", pgType: "integer" },
			{ relation: "fpl.live_match_desk_checkpoints", column: "publication_id", pgType: "text" },
			{ relation: "fpl.live_match_desk_checkpoints", column: "generation", pgType: "bigint" },
			{ relation: "fpl.live_match_desk_checkpoints", column: "state", pgType: "text" },
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "manifest",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "revisions",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{ relation: "fpl.live_match_desk_checkpoints", column: "row_count", pgType: "integer" },
			{ relation: "fpl.live_match_desk_checkpoints", column: "payload_bytes", pgType: "integer" },
			{ relation: "fpl.live_match_desk_checkpoints", column: "payload_sha256", pgType: "text" },
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "source_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "checkpointed_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "expected_next_check_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_desk_checkpoints",
				column: "stale_at",
				pgType: "timestamp with time zone",
			},
			{ relation: "fpl.live_match_detail_checkpoints", column: "season_id", pgType: "smallint" },
			{ relation: "fpl.live_match_detail_checkpoints", column: "event_id", pgType: "integer" },
			{ relation: "fpl.live_match_detail_checkpoints", column: "publication_id", pgType: "text" },
			{ relation: "fpl.live_match_detail_checkpoints", column: "generation", pgType: "bigint" },
			{ relation: "fpl.live_match_detail_checkpoints", column: "state", pgType: "text" },
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "observed_desk_generation",
				pgType: "bigint",
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "fixture_identity_revision",
				pgType: "text",
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "manifest",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "revisions",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{ relation: "fpl.live_match_detail_checkpoints", column: "row_count", pgType: "integer" },
			{ relation: "fpl.live_match_detail_checkpoints", column: "payload_bytes", pgType: "integer" },
			{ relation: "fpl.live_match_detail_checkpoints", column: "payload_sha256", pgType: "text" },
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "source_checked_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "published_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "checkpointed_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "expected_next_check_at",
				pgType: "timestamp with time zone",
			},
			{
				relation: "fpl.live_match_detail_checkpoints",
				column: "stale_at",
				pgType: "timestamp with time zone",
			},
		],
	},
];

const validState = (value: unknown): value is MatchLifecycleState =>
	typeof value === "string" &&
	new Set<MatchLifecycleState>([
		"PRE_DEADLINE",
		"LIVE_ACTIVE",
		"BETWEEN_FIXTURES",
		"DAY_SETTLING",
		"GW_REVIEW",
		"FINALIZED",
	]).has(value as MatchLifecycleState);

const validRevision = (value: unknown): value is StreamRevision =>
	isRecord(value) && /^[0-9a-f]{64}$/.test(String(value.revision)) && isIso(value.contentUpdatedAt);

const validPublicationItem = (
	value: unknown,
	expectedKey: string,
	name: "desk"
): value is PublicationItem =>
	isRecord(value) &&
	value.name === name &&
	value.key === expectedKey &&
	value.type === "string" &&
	safeInteger(value.count) !== null &&
	(safeInteger(value.count) as number) >= 0 &&
	(safeInteger(value.count) as number) <= LIVE_MATCH_MAX_FIXTURES &&
	safeInteger(value.bytes) !== null &&
	(safeInteger(value.bytes) as number) >= 0 &&
	(safeInteger(value.bytes) as number) <= LIVE_MATCH_MAX_DESK_BYTES &&
	typeof value.sha256 === "string" &&
	/^[0-9a-f]{64}$/.test(value.sha256);

const validBasePublication = (
	value: unknown,
	season: string,
	eventId: number
): value is Omit<MatchDeskPublication, "revisions" | "desk"> & {
	revisions: Record<string, unknown>;
	desk?: unknown;
} =>
	isRecord(value) &&
	value.contractVersion === LIVE_MATCHES_CONTRACT_VERSION &&
	validPublicationId(value.publicationId) &&
	safeInteger(value.generation) !== null &&
	(safeInteger(value.generation) as number) > 0 &&
	value.season === season &&
	value.eventId === eventId &&
	validState(value.state) &&
	isIso(value.sourceCheckedAt) &&
	isIso(value.publishedAt) &&
	(value.checkpointedAt === null || isIso(value.checkpointedAt)) &&
	(value.expectedNextCheckAt === null || isIso(value.expectedNextCheckAt)) &&
	(value.staleAt === null || isIso(value.staleAt)) &&
	isRecord(value.revisions) &&
	validRevision(value.revisions.lifecycle) &&
	validRevision(value.revisions.fixtureIdentity) &&
	validRevision(value.revisions.scoreState);

const parseDeskPublication = (
	raw: string | null,
	season: string,
	eventId: number
): MatchDeskPublication | null => {
	if (raw === null || Buffer.byteLength(raw, "utf8") > LIVE_MATCH_MAX_PUBLICATION_BYTES)
		return null;
	const value = parsedJson(raw);
	if (!validBasePublication(value, season, eventId)) return null;
	const generation = value.generation as number;
	if (!validPublicationItem(value.desk, deskItemKey(season, eventId, generation), "desk"))
		return null;
	return value as unknown as MatchDeskPublication;
};

const validDetailItem = (
	value: unknown,
	season: string,
	eventId: number
): value is FixtureDetailItem => {
	if (!isRecord(value)) return false;
	const fixtureId = safeInteger(value.fixtureId);
	return (
		fixtureId !== null &&
		fixtureId > 0 &&
		value.type === "string" &&
		typeof value.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(value.sha256) &&
		detailItemKeyMatches(value.key, season, eventId, fixtureId, value.sha256) &&
		safeInteger(value.count) !== null &&
		(safeInteger(value.count) as number) >= 0 &&
		(safeInteger(value.count) as number) <= LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE &&
		safeInteger(value.bytes) !== null &&
		(safeInteger(value.bytes) as number) >= 0 &&
		(safeInteger(value.bytes) as number) <= LIVE_MATCH_MAX_DETAIL_ITEM_BYTES
	);
};

const parseDetailPublication = (
	raw: string | null,
	season: string,
	eventId: number
): MatchDetailPublication | null => {
	if (raw === null || Buffer.byteLength(raw, "utf8") > LIVE_MATCH_MAX_PUBLICATION_BYTES)
		return null;
	const value = parsedJson(raw);
	if (
		!isRecord(value) ||
		value.contractVersion !== LIVE_MATCHES_CONTRACT_VERSION ||
		!validPublicationId(value.publicationId) ||
		safeInteger(value.generation) === null ||
		(safeInteger(value.generation) as number) <= 0 ||
		value.season !== season ||
		value.eventId !== eventId ||
		typeof value.finalized !== "boolean" ||
		safeInteger(value.observedDeskGeneration) === null ||
		(safeInteger(value.observedDeskGeneration) as number) <= 0 ||
		typeof value.fixtureIdentityRevision !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.fixtureIdentityRevision) ||
		!isIso(value.sourceCheckedAt) ||
		!isIso(value.publishedAt) ||
		(value.checkpointedAt !== null && !isIso(value.checkpointedAt)) ||
		(value.expectedNextCheckAt !== null && !isIso(value.expectedNextCheckAt)) ||
		(value.staleAt !== null && !isIso(value.staleAt)) ||
		!validRevision(value.detail) ||
		!Array.isArray(value.fixtures)
	)
		return null;
	const fixtures = value.fixtures as unknown[];
	if (
		fixtures.length > LIVE_MATCH_MAX_FIXTURES ||
		new Set(fixtures.map((item) => (isRecord(item) ? item.fixtureId : null))).size !==
			fixtures.length ||
		!fixtures.every((item) => validDetailItem(item, season, eventId)) ||
		fixtures.reduce(
			(total, item) =>
				total + (isRecord(item) && safeInteger(item.bytes) !== null ? Number(item.bytes) : 0),
			0
		) > LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES
	)
		return null;
	return value as unknown as MatchDetailPublication;
};

const parsePayload = <T>(
	raw: string | null,
	item: Readonly<{ count: number; bytes: number; sha256: string }>,
	validate: (value: unknown) => value is T
): T | null => {
	if (
		raw === null ||
		Buffer.byteLength(raw, "utf8") !== item.bytes ||
		sha256Raw(raw) !== item.sha256
	)
		return null;
	const value = parsedJson(raw);
	if (value === null || !validate(value)) return null;
	return value;
};

const validDeskFixture = (value: unknown, eventId: number): value is MatchDeskFixture => {
	if (!isRecord(value)) return false;
	const fixtureId = safeInteger(value.fixtureId);
	const event = safeInteger(value.eventId);
	const homeTeamId = safeInteger(value.homeTeamId);
	const awayTeamId = safeInteger(value.awayTeamId);
	const minutes = safeInteger(value.minutes);
	return (
		fixtureId !== null &&
		fixtureId > 0 &&
		event === eventId &&
		homeTeamId !== null &&
		homeTeamId > 0 &&
		awayTeamId !== null &&
		awayTeamId > 0 &&
		homeTeamId !== awayTeamId &&
		nonEmptyString(value.homeTeamName) &&
		nonEmptyString(value.homeTeamShortName) &&
		nonEmptyString(value.awayTeamName) &&
		nonEmptyString(value.awayTeamShortName) &&
		minutes !== null &&
		minutes >= 0 &&
		(value.homeScore === null ||
			(safeInteger(value.homeScore) !== null && (value.homeScore as number) >= 0)) &&
		(value.awayScore === null ||
			(safeInteger(value.awayScore) !== null && (value.awayScore as number) >= 0)) &&
		(value.kickoffTime === null || isIso(value.kickoffTime)) &&
		typeof value.started === "boolean" &&
		typeof value.finished === "boolean" &&
		typeof value.finishedProvisional === "boolean"
	);
};

const validDetailPlayer = (value: unknown): value is MatchDetailPlayer => {
	if (!isRecord(value)) return false;
	const id = safeInteger(value.id);
	const position = safeInteger(value.position);
	const teamId = safeInteger(value.teamId);
	const totalPoints = safeInteger(value.totalPoints);
	return (
		id !== null &&
		id > 0 &&
		nonEmptyString(value.webName) &&
		position !== null &&
		position >= 1 &&
		position <= 4 &&
		teamId !== null &&
		teamId > 0 &&
		totalPoints !== null &&
		Array.isArray(value.stats) &&
		value.stats.length <= LIVE_MATCH_MAX_STATS_PER_PLAYER &&
		new Set(value.stats.map((stat) => (isRecord(stat) ? stat.identifier : null))).size ===
			value.stats.length &&
		value.stats.every((stat) => {
			if (!isRecord(stat)) return false;
			return (
				nonEmptyString(stat.identifier) &&
				finiteNumber(stat.value) &&
				finiteNumber(stat.points) &&
				(stat.pointsModification === null || finiteNumber(stat.pointsModification))
			);
		})
	);
};

const validDeskPayload = (value: unknown, eventId: number): value is readonly MatchDeskFixture[] =>
	Array.isArray(value) &&
	value.length <= LIVE_MATCH_MAX_FIXTURES &&
	canonicalBytes(value) <= LIVE_MATCH_MAX_DESK_BYTES &&
	new Set(value.map((fixture) => (isRecord(fixture) ? fixture.fixtureId : null))).size ===
		value.length &&
	value.every((fixture) => validDeskFixture(fixture, eventId));

const validFixtureDetail = (value: unknown): value is MatchFixtureDetail =>
	isRecord(value) &&
	safeInteger(value.fixtureId) !== null &&
	(safeInteger(value.fixtureId) as number) > 0 &&
	Array.isArray(value.players) &&
	value.players.length <= LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE &&
	canonicalBytes(value.players) <= LIVE_MATCH_MAX_DETAIL_ITEM_BYTES &&
	new Set(value.players.map((player) => (isRecord(player) ? player.id : null))).size ===
		value.players.length &&
	value.players.every(validDetailPlayer);

const validDetailPayload = (value: unknown): value is readonly MatchFixtureDetail[] =>
	Array.isArray(value) &&
	value.length <= LIVE_MATCH_MAX_FIXTURES &&
	canonicalBytes(value) <= LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES &&
	new Set(value.map((fixture) => (isRecord(fixture) ? fixture.fixtureId : null))).size ===
		value.length &&
	value.every(validFixtureDetail);

const validDetailForDesk = (
	desk: readonly MatchDeskFixture[],
	detail: readonly MatchFixtureDetail[]
): boolean => {
	const deskByFixture = new Map(desk.map((fixture) => [fixture.fixtureId, fixture]));
	return detail.every((fixture) => {
		const deskFixture = deskByFixture.get(fixture.fixtureId);
		if (!deskFixture) return false;
		const allowedTeamIds = new Set([deskFixture.homeTeamId, deskFixture.awayTeamId]);
		const started =
			deskFixture.started ||
			deskFixture.finished ||
			deskFixture.finishedProvisional ||
			deskFixture.minutes > 0;
		return (
			(!started || fixture.players.length > 0) &&
			fixture.players.every((player) => allowedTeamIds.has(player.teamId))
		);
	});
};

const decodeDeskCandidate = (
	raw: RedisDeskRaw,
	season: string,
	eventId: number,
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS"
): MatchDeskCandidate | null => {
	const publication = parseDeskPublication(raw.publication, season, eventId);
	if (
		!publication ||
		raw.metadata !==
			`${publication.desk.count}|${publication.desk.bytes}|${publication.desk.sha256}`
	)
		return null;
	const fixtures = parsePayload(
		raw.payload,
		publication.desk,
		(value): value is readonly MatchDeskFixture[] => validDeskPayload(value, eventId)
	);
	return fixtures &&
		fixtures.length === publication.desk.count &&
		deskRevisionsMatchPayload(publication, fixtures)
		? { publication, fixtures, servedFrom }
		: null;
};

const sameDetailMetadata = (
	publication: MatchDetailPublication,
	manifest: MatchDetailPublication
): boolean =>
	publication.publicationId === manifest.publicationId &&
	publication.generation === manifest.generation &&
	publication.finalized === manifest.finalized &&
	publication.observedDeskGeneration === manifest.observedDeskGeneration &&
	publication.fixtureIdentityRevision === manifest.fixtureIdentityRevision &&
	publication.sourceCheckedAt === manifest.sourceCheckedAt &&
	publication.publishedAt === manifest.publishedAt &&
	publication.checkpointedAt === manifest.checkpointedAt &&
	publication.expectedNextCheckAt === manifest.expectedNextCheckAt &&
	publication.staleAt === manifest.staleAt &&
	publication.detail.revision === manifest.detail.revision &&
	publication.detail.contentUpdatedAt === manifest.detail.contentUpdatedAt &&
	publication.fixtures.length === manifest.fixtures.length &&
	publication.fixtures.every((item, index) => {
		const other = manifest.fixtures[index];
		return (
			other !== undefined &&
			item.fixtureId === other.fixtureId &&
			item.key === other.key &&
			item.count === other.count &&
			item.bytes === other.bytes &&
			item.sha256 === other.sha256
		);
	});

const decodeDetailCandidate = (
	raw: RedisDetailRaw,
	season: string,
	eventId: number,
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS"
): MatchDetailCandidate | null => {
	const publication = parseDetailPublication(raw.publication, season, eventId);
	const manifest = parseDetailPublication(raw.manifest, season, eventId);
	if (
		!publication ||
		!manifest ||
		!sameDetailMetadata(publication, manifest) ||
		raw.items.length !== publication.fixtures.length
	)
		return null;
	const byFixture = new Map<number, MatchFixtureDetail>();
	for (const item of publication.fixtures) {
		const rawItem = raw.items.find(
			(candidate) => candidate.fixtureId === item.fixtureId && candidate.key === item.key
		);
		if (!rawItem || rawItem.metadata !== `${item.count}|${item.bytes}|${item.sha256}`) return null;
		const players = parsePayload(
			rawItem.payload,
			item,
			(value): value is readonly MatchDetailPlayer[] =>
				Array.isArray(value) &&
				value.length <= LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE &&
				canonicalBytes(value) <= LIVE_MATCH_MAX_DETAIL_ITEM_BYTES &&
				value.length === item.count &&
				new Set(value.map((player) => (isRecord(player) ? player.id : null))).size ===
					value.length &&
				value.every(validDetailPlayer)
		);
		if (!players) return null;
		byFixture.set(item.fixtureId, { fixtureId: item.fixtureId, players });
	}
	const fixtures = [...byFixture.values()];
	if (sha256(fixtures) !== publication.detail.revision) return null;
	return {
		publication,
		fixtures,
		servedFrom,
	};
};

const readRedisBundle = async (
	redis: Redis,
	season: string,
	eventId?: number
): Promise<RedisReadBundle | null> => {
	try {
		const raw = await redis.eval(
			LIVE_MATCHES_READ_BUNDLE_LUA,
			0,
			season,
			eventId === undefined ? "" : String(eventId)
		);
		if (typeof raw !== "string") return null;
		if (Buffer.byteLength(raw, "utf8") > LIVE_MATCH_MAX_REDIS_BUNDLE_BYTES) return null;
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || !isRecord(value.desk) || !isRecord(value.detail)) return null;
		const candidate = (input: unknown): RedisDeskRaw => {
			if (!isRecord(input)) return { publication: null, payload: null, metadata: null };
			return {
				publication: typeof input.publication === "string" ? input.publication : null,
				payload: typeof input.payload === "string" ? input.payload : null,
				metadata: typeof input.metadata === "string" ? input.metadata : null,
			};
		};
		const detail = (input: unknown): RedisDetailRaw => {
			if (!isRecord(input)) return { publication: null, manifest: null, items: [] };
			const items =
				Array.isArray(input.items) && input.items.length <= LIVE_MATCH_MAX_FIXTURES
					? input.items.map((item): RedisDetailItemRaw => {
							if (!isRecord(item))
								return { fixtureId: null, key: null, payload: null, metadata: null };
							return {
								fixtureId: safeInteger(item.fixtureId),
								key: typeof item.key === "string" ? item.key : null,
								payload: typeof item.payload === "string" ? item.payload : null,
								metadata: typeof item.metadata === "string" ? item.metadata : null,
							};
						})
					: [];
			return {
				publication: typeof input.publication === "string" ? input.publication : null,
				manifest: typeof input.manifest === "string" ? input.manifest : null,
				items,
			};
		};
		return {
			eventId: safeInteger(value.eventId),
			desk: {
				active: candidate(value.desk.active),
				previous: candidate(value.desk.previous),
			},
			detail: {
				active: detail(value.detail.active),
				previous: detail(value.detail.previous),
			},
		};
	} catch {
		return null;
	}
};

const lkgKey = (season: string, eventId: number): string => `${season}:${eventId}`;

const isActiveLkgKey = (key: string): boolean => {
	for (const [season, eventId] of processActiveEvent) {
		if (lkgKey(season, eventId) === key) return true;
	}
	return false;
};

const rememberLkg = (season: string, eventId: number, value: SelectedLkg): void => {
	const key = lkgKey(season, eventId);
	if (processLkg.has(key)) processLkg.delete(key);
	processLkg.set(key, value);
	while (processLkg.size > LIVE_MATCHES_PROCESS_LKG_LIMIT) {
		// The active event is a protected availability fallback. Historical
		// explicit reads may evict one another, but they must never evict the
		// current event's process LKG while Redis/PG are recovering.
		const oldest = [...processLkg.keys()].find((candidate) => !isActiveLkgKey(candidate));
		if (oldest === undefined) break;
		processLkg.delete(oldest);
	}
};

const asProcessLkg = (value: SelectedLkg): SelectedLkg => ({
	desk: { ...value.desk, servedFrom: "PROCESS_LKG" },
	detail: value.detail ? { ...value.detail, servedFrom: "PROCESS_LKG" } : null,
});

const compatibleDetail = (
	desk: MatchDeskCandidate,
	detail: MatchDetailCandidate | null
): detail is MatchDetailCandidate => {
	if (!detail) return false;
	// Once the desk has fallen back to its previous complete publication, do
	// not pair it with a detail-only update from Redis current. The pair must
	// come from the same fallback generation or from a compatible cold
	// checkpoint, otherwise a newer player detail can describe a score board
	// that is no longer the served desk.
	if (desk.servedFrom === "REDIS_PREVIOUS" && detail.servedFrom === "REDIS_CURRENT") return false;
	if (
		detail.publication.observedDeskGeneration > desk.publication.generation ||
		detail.publication.fixtureIdentityRevision !==
			desk.publication.revisions.fixtureIdentity.revision
	)
		return false;
	const deskFixtures = new Set(desk.fixtures.map((fixture) => fixture.fixtureId));
	if (!detail.fixtures.every((fixture) => deskFixtures.has(fixture.fixtureId))) return false;
	const startedDeskFixtures = desk.fixtures
		.filter(
			(fixture) =>
				fixture.started || fixture.finished || fixture.finishedProvisional || fixture.minutes > 0
		)
		.map((fixture) => fixture.fixtureId);
	const detailFixtures = new Set(detail.fixtures.map((fixture) => fixture.fixtureId));
	return (
		startedDeskFixtures.every((fixtureId) => {
			const detailFixture = detail.fixtures.find((fixture) => fixture.fixtureId === fixtureId);
			return (
				detailFixtures.has(fixtureId) &&
				detailFixture !== undefined &&
				detailFixture.players.length > 0
			);
		}) && validDetailForDesk(desk.fixtures, detail.fixtures)
	);
};

const chooseDetail = (
	desk: MatchDeskCandidate,
	candidates: readonly (MatchDetailCandidate | null)[]
): MatchDetailCandidate | null => {
	let selected: MatchDetailCandidate | null = null;
	for (const candidate of candidates) {
		if (!compatibleDetail(desk, candidate)) continue;
		if (!selected) {
			selected = candidate;
			continue;
		}
		if (candidate.publication.generation > selected.publication.generation) {
			selected = candidate;
			continue;
		}
		if (
			candidate.publication.generation === selected.publication.generation &&
			Date.parse(candidate.publication.publishedAt) > Date.parse(selected.publication.publishedAt)
		)
			selected = candidate;
	}
	return selected;
};

const selectNewestDesk = (
	candidates: readonly (MatchDeskCandidate | null)[]
): MatchDeskCandidate | null => {
	let selected: MatchDeskCandidate | null = null;
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (!selected) {
			selected = candidate;
			continue;
		}
		if (candidate.publication.generation > selected.publication.generation) {
			selected = candidate;
			continue;
		}
		if (
			candidate.publication.generation === selected.publication.generation &&
			Date.parse(candidate.publication.publishedAt) > Date.parse(selected.publication.publishedAt)
		)
			selected = candidate;
	}
	return selected;
};

const sameTimestamp = (left: unknown, right: unknown): boolean => {
	if (left === null || right === null) return left === right;
	if (typeof left !== "string" || typeof right !== "string") return false;
	const leftMs = Date.parse(left);
	const rightMs = Date.parse(right);
	return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
};

const checkpointPayload = (value: unknown): unknown => {
	if (typeof value === "string") return parsedJson(value);
	return value;
};

const checkpointManifest = (value: unknown): string | null => {
	const parsed = checkpointPayload(value);
	if (!isRecord(parsed)) return null;
	const raw = stableJson(parsed);
	return Buffer.byteLength(raw, "utf8") <= LIVE_MATCH_MAX_PUBLICATION_BYTES ? raw : null;
};

const buildPostgresDesk = (
	row: unknown,
	season: string,
	eventId: number
): MatchDeskCandidate | null => {
	if (!isRecord(row)) return null;
	const manifest = checkpointManifest(row.manifest);
	const publication = parseDeskPublication(manifest, season, eventId);
	const generation = safeInteger(row.generation);
	const rowCount = safeInteger(row.row_count);
	const bytes = safeInteger(row.payload_bytes);
	const checksum = typeof row.payload_sha256 === "string" ? row.payload_sha256 : null;
	if (
		!publication ||
		generation === null ||
		generation <= 0 ||
		row.publication_id !== publication.publicationId ||
		generation !== publication.generation ||
		row.state !== publication.state ||
		stableJson(row.revisions) !== stableJson(publication.revisions) ||
		rowCount === null ||
		rowCount < 0 ||
		rowCount > LIVE_MATCH_MAX_FIXTURES ||
		bytes === null ||
		bytes < 0 ||
		bytes > LIVE_MATCH_MAX_DESK_BYTES ||
		checksum === null ||
		!/^[0-9a-f]{64}$/.test(checksum) ||
		!sameTimestamp(row.source_checked_at, publication.sourceCheckedAt) ||
		!sameTimestamp(row.published_at, publication.publishedAt) ||
		!isIso(row.checkpointed_at) ||
		!sameTimestamp(row.checkpointed_at, publication.checkpointedAt) ||
		!sameTimestamp(row.expected_next_check_at, publication.expectedNextCheckAt) ||
		!sameTimestamp(row.stale_at, publication.staleAt) ||
		publication.desk.count !== rowCount ||
		publication.desk.bytes !== bytes ||
		publication.desk.sha256 !== checksum
	)
		return null;
	const payload = checkpointPayload(row.payload);
	if (
		!validDeskPayload(payload, eventId) ||
		(payload as readonly unknown[]).length !== rowCount ||
		canonicalBytes(payload) !== bytes ||
		sha256(payload) !== checksum
	)
		return null;
	if (!deskRevisionsMatchPayload(publication, payload)) return null;
	return { publication, fixtures: payload, servedFrom: "POSTGRES_CHECKPOINT" };
};

const buildPostgresDetail = (
	row: unknown,
	season: string,
	eventId: number
): MatchDetailCandidate | null => {
	if (!isRecord(row)) return null;
	const manifest = checkpointManifest(row.manifest);
	const publication = parseDetailPublication(manifest, season, eventId);
	const generation = safeInteger(row.generation);
	const observedDeskGeneration = safeInteger(row.observed_desk_generation);
	const fixtureIdentityRevision =
		typeof row.fixture_identity_revision === "string" ? row.fixture_identity_revision : null;
	const rowCount = safeInteger(row.row_count);
	const bytes = safeInteger(row.payload_bytes);
	const checksum = typeof row.payload_sha256 === "string" ? row.payload_sha256 : null;
	if (
		!publication ||
		generation === null ||
		generation <= 0 ||
		row.publication_id !== publication.publicationId ||
		generation !== publication.generation ||
		row.state !== (publication.finalized ? "FINALIZED" : "PROVISIONAL") ||
		observedDeskGeneration === null ||
		observedDeskGeneration <= 0 ||
		observedDeskGeneration !== publication.observedDeskGeneration ||
		fixtureIdentityRevision === null ||
		fixtureIdentityRevision !== publication.fixtureIdentityRevision ||
		stableJson(row.revisions) !== stableJson({ detail: publication.detail }) ||
		!sameTimestamp(row.source_checked_at, publication.sourceCheckedAt) ||
		!sameTimestamp(row.published_at, publication.publishedAt) ||
		!isIso(row.checkpointed_at) ||
		!sameTimestamp(row.checkpointed_at, publication.checkpointedAt) ||
		!sameTimestamp(row.expected_next_check_at, publication.expectedNextCheckAt) ||
		!sameTimestamp(row.stale_at, publication.staleAt) ||
		rowCount === null ||
		rowCount < 0 ||
		rowCount > LIVE_MATCH_MAX_FIXTURES ||
		bytes === null ||
		bytes < 0 ||
		bytes > LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES ||
		checksum === null ||
		!/^[0-9a-f]{64}$/.test(checksum) ||
		publication.detail.revision !== checksum ||
		publication.fixtures.length !== rowCount
	)
		return null;
	const payload = checkpointPayload(row.payload);
	if (
		!validDetailPayload(payload) ||
		(payload as readonly unknown[]).length !== rowCount ||
		canonicalBytes(payload) !== bytes ||
		sha256(payload) !== checksum
	)
		return null;
	const fixtures = payload as readonly MatchFixtureDetail[];
	for (const [index, fixture] of fixtures.entries()) {
		const item = publication.fixtures[index];
		if (
			!item ||
			item.fixtureId !== fixture.fixtureId ||
			item.count !== fixture.players.length ||
			item.bytes !== canonicalBytes(fixture.players) ||
			item.sha256 !== sha256(fixture.players)
		)
			return null;
	}
	return { publication, fixtures, servedFrom: "POSTGRES_CHECKPOINT" };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("live match checkpoint timeout")), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

const postgresCircuitAllowsRead = (): boolean => Date.now() >= postgresCircuitOpenUntil;

const openPostgresCircuit = (): void => {
	postgresCircuitFailures += 1;
	const delay = Math.min(300_000, 30_000 * 2 ** Math.max(0, postgresCircuitFailures - 1));
	postgresCircuitOpenUntil = Date.now() + delay;
};

const resetPostgresCircuit = (): void => {
	postgresCircuitFailures = 0;
	postgresCircuitOpenUntil = 0;
};

const readPostgresCheckpoint = async (
	context: GraphQLContext,
	seasonId: number,
	season: string,
	eventId: number | null
): Promise<PostgresCheckpointRead | null> => {
	if (!postgresCircuitAllowsRead()) return null;
	const scope = eventId === null ? `${season}:active` : lkgKey(season, eventId);
	const existing = postgresReadFlights.get(scope);
	if (existing) return existing;
	const flight = withTimeout(
		context.database.query<CheckpointRow>(LIVE_MATCH_CHECKPOINT_SQL, [seasonId, eventId]),
		LIVE_MATCHES_POSTGRES_TIMEOUT_MS
	)
		.then((result) => {
			const row = result.rows[0];
			resetPostgresCircuit();
			const selectedEventId = row ? safeInteger(row.event_id) : null;
			return row && selectedEventId !== null && selectedEventId > 0
				? {
						eventId: selectedEventId,
						desk: buildPostgresDesk(row.desk, season, selectedEventId),
						detail: buildPostgresDetail(row.detail, season, selectedEventId),
					}
				: { eventId: null, desk: null, detail: null };
		})
		.catch((error) => {
			openPostgresCircuit();
			context.logger.warn(
				{ err: error, eventId },
				"Live Match PostgreSQL checkpoint fallback unavailable"
			);
			return null;
		})
		.finally(() => {
			postgresReadFlights.delete(scope);
		});
	postgresReadFlights.set(scope, flight);
	return flight;
};

const allFixturesStarted = (desk: MatchDeskCandidate): boolean =>
	desk.fixtures.some(
		(fixture) =>
			fixture.started || fixture.finished || fixture.finishedProvisional || fixture.minutes > 0
	);

const detailFallbackKey = (season: string, eventId: number, desk: MatchDeskCandidate): string =>
	`${season}:${eventId}:${desk.publication.publicationId}:${desk.publication.generation}`;

const detailCheckpointMayBeRetried = (
	season: string,
	eventId: number,
	desk: MatchDeskCandidate
): boolean =>
	Date.now() >= (postgresDetailMissUntil.get(detailFallbackKey(season, eventId, desk)) ?? 0);

const rememberMissingDetailCheckpoint = (
	season: string,
	eventId: number,
	desk: MatchDeskCandidate
): void => {
	if (postgresDetailMissUntil.size >= 16) {
		const oldest = postgresDetailMissUntil.keys().next().value;
		if (oldest !== undefined) postgresDetailMissUntil.delete(oldest);
	}
	postgresDetailMissUntil.set(detailFallbackKey(season, eventId, desk), Date.now() + 30_000);
};

const requestedEventId = (value: number | undefined): number | undefined =>
	value === undefined ? undefined : Number.isSafeInteger(value) && value > 0 ? value : undefined;

export const readLiveMatchday = async (
	context: GraphQLContext,
	eventId?: number
): Promise<LiveMatchdayRead> => {
	const season = context.currentSeason.seasonCode;
	const requested = requestedEventId(eventId);
	if (eventId !== undefined && requested === undefined)
		return {
			season,
			eventId: null,
			desk: null,
			detail: null,
			redisReadFailed: false,
			postgresReadFailed: false,
		};

	const redisBundle = await readRedisBundle(context.redis, season, requested);
	const redisReadFailed = redisBundle === null;
	const cachedActiveEvent = processActiveEvent.get(season);
	let unscopedPostgres: PostgresCheckpointRead | null | undefined;
	const shouldRevalidateActiveEvent =
		requested === undefined &&
		(redisBundle === null || redisBundle.eventId === null) &&
		(cachedActiveEvent === undefined ||
			Date.now() - (processActiveEventCheckedAt.get(season) ?? 0) >=
				LIVE_MATCH_ACTIVE_EVENT_REVALIDATION_MS);
	if (shouldRevalidateActiveEvent) {
		unscopedPostgres = await readPostgresCheckpoint(
			context,
			context.currentSeason.seasonId,
			season,
			null
		);
		processActiveEventCheckedAt.set(season, Date.now());
	}
	const selectedEventId =
		requested ?? redisBundle?.eventId ?? unscopedPostgres?.eventId ?? cachedActiveEvent ?? null;
	if (
		requested === undefined &&
		redisBundle?.eventId !== null &&
		redisBundle?.eventId !== undefined
	)
		processActiveEvent.set(season, redisBundle.eventId);
	if (
		requested === undefined &&
		selectedEventId !== null &&
		unscopedPostgres?.eventId === selectedEventId
	)
		processActiveEvent.set(season, selectedEventId);
	if (selectedEventId === null) {
		const postgres =
			unscopedPostgres !== undefined
				? unscopedPostgres
				: await readPostgresCheckpoint(context, context.currentSeason.seasonId, season, null);
		const fallbackEventId = postgres?.eventId ?? null;
		const fallbackDesk = postgres?.desk ?? null;
		const fallbackDetail = fallbackDesk
			? chooseDetail(fallbackDesk, [postgres?.detail ?? null])
			: null;
		if (fallbackEventId !== null && fallbackDesk) {
			processActiveEvent.set(season, fallbackEventId);
			rememberLkg(season, fallbackEventId, { desk: fallbackDesk, detail: fallbackDetail });
		}
		return {
			season,
			eventId: fallbackEventId,
			desk: fallbackDesk,
			detail: fallbackDetail,
			redisReadFailed,
			postgresReadFailed: postgres === null,
		};
	}

	const redisDesk = redisBundle
		? [
				decodeDeskCandidate(redisBundle.desk.active, season, selectedEventId, "REDIS_CURRENT"),
				decodeDeskCandidate(redisBundle.desk.previous, season, selectedEventId, "REDIS_PREVIOUS"),
			].filter((value): value is MatchDeskCandidate => value !== null)
		: [];
	const redisDetail = redisBundle
		? [
				decodeDetailCandidate(redisBundle.detail.active, season, selectedEventId, "REDIS_CURRENT"),
				decodeDetailCandidate(
					redisBundle.detail.previous,
					season,
					selectedEventId,
					"REDIS_PREVIOUS"
				),
			].filter((value): value is MatchDetailCandidate => value !== null)
		: [];
	const stored = processLkg.get(lkgKey(season, selectedEventId));
	const processLkgValue = stored ? asProcessLkg(stored) : null;
	const processDesk = processLkgValue?.desk ?? null;
	const redisDeskCandidate = redisDesk[0] ?? null;
	const initialDesk = redisDeskCandidate ?? processDesk;

	let postgresReadFailed = unscopedPostgres === null;
	let postgres: PostgresCheckpointRead | null =
		unscopedPostgres?.eventId === selectedEventId ? unscopedPostgres : null;
	const retainedDetail = initialDesk
		? chooseDetail(initialDesk, [
				...redisDetail,
				processLkgValue?.detail ?? null,
				postgres?.detail ?? null,
			])
		: null;
	if (
		!initialDesk ||
		(allFixturesStarted(initialDesk) &&
			retainedDetail === null &&
			detailCheckpointMayBeRetried(season, selectedEventId, initialDesk))
	) {
		if (unscopedPostgres === undefined) {
			postgres = await readPostgresCheckpoint(
				context,
				context.currentSeason.seasonId,
				season,
				selectedEventId
			);
			postgresReadFailed = postgres === null;
			if (initialDesk && postgres !== null && chooseDetail(initialDesk, [postgres.detail]) === null)
				rememberMissingDetailCheckpoint(season, selectedEventId, initialDesk);
		}
	}
	const effectiveDesk =
		redisDeskCandidate ?? selectNewestDesk([processDesk, postgres?.desk ?? null]);
	if (!effectiveDesk)
		return {
			season,
			eventId: selectedEventId,
			desk: null,
			detail: null,
			redisReadFailed,
			postgresReadFailed,
		};

	const detail = chooseDetail(
		effectiveDesk,
		effectiveDesk.servedFrom === "POSTGRES_CHECKPOINT"
			? [...redisDetail, postgres?.detail ?? null, processLkgValue?.detail ?? null]
			: [retainedDetail, postgres?.detail ?? null]
	);
	const result = {
		season,
		eventId: selectedEventId,
		desk: effectiveDesk,
		detail,
		redisReadFailed,
		postgresReadFailed,
	};
	rememberLkg(season, selectedEventId, {
		desk: effectiveDesk,
		detail,
	});
	return result;
};

export const resetLiveMatchProcessStateForTests = (): void => {
	processLkg.clear();
	processActiveEvent.clear();
	processActiveEventCheckedAt.clear();
	postgresDetailMissUntil.clear();
	postgresCircuitOpenUntil = 0;
	postgresCircuitFailures = 0;
	postgresReadFlights.clear();
};

export type {
	MatchDeskCandidate,
	MatchDetailCandidate,
	MatchDetailPublication,
	MatchDeskPublication,
};
