import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { getCurrentEventId } from "../../infra/event";
import { getCurrentSeason } from "../../infra/season";
import { metrics } from "../../infra/metrics";
import {
	isLiveSnapshotConsistencyActive,
	isLiveSnapshotDatabaseFallback,
	LiveSnapshotCoherenceError,
	loadLiveSnapshotMeta,
	type LiveSnapshotMeta,
} from "../live/snapshot-meta";

export type Fixture = {
	id: number;
	code: number;
	eventId: number | null;
	finished: boolean;
	finishedProvisional: boolean;
	kickoffTime: string | null;
	minutes: number;
	started: boolean | null;
	teamHId: number;
	teamAId: number;
	teamHScore: number | null;
	teamAScore: number | null;
	teamHDifficulty: number | null;
	teamADifficulty: number | null;
};

export type FixturesFilter = {
	id?: number;
	eventId?: number;
	teamId?: number;
	finished?: boolean;
};

type DbFixtureRow = {
	id: number;
	code: number;
	event_id: number | null;
	finished: boolean;
	finished_provisional: boolean;
	kickoff_time: string | null;
	minutes: number;
	started: boolean | null;
	team_h_id: number;
	team_a_id: number;
	team_h_score: number | null;
	team_a_score: number | null;
	team_h_difficulty: number | null;
	team_a_difficulty: number | null;
};

const toIso = (value: string | Date | null): string | null => {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const mapFixture = (row: DbFixtureRow): Fixture => ({
	id: row.id,
	code: row.code,
	eventId: row.event_id,
	finished: row.finished,
	finishedProvisional: row.finished_provisional,
	kickoffTime: toIso(row.kickoff_time),
	minutes: row.minutes,
	started: row.started,
	teamHId: row.team_h_id,
	teamAId: row.team_a_id,
	teamHScore: row.team_h_score,
	teamAScore: row.team_a_score,
	teamHDifficulty: row.team_h_difficulty,
	teamADifficulty: row.team_a_difficulty,
});

const normalizeFilter = (filter?: FixturesFilter | null): FixturesFilter | undefined => {
	if (!filter) {
		return undefined;
	}
	return {
		id: filter.id ?? undefined,
		eventId: filter.eventId ?? undefined,
		teamId: filter.teamId ?? undefined,
		finished: filter.finished ?? undefined,
	};
};

const clampLimit = (limit: number): number => {
	const safeLimit = Number.isFinite(limit) ? limit : 50;
	return Math.min(Math.max(safeLimit, 1), 200);
};

const asNum = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const asPositiveInt = (value: number | null): number | null =>
	value !== null && Number.isInteger(value) && value > 0 ? value : null;

const asNonNegativeInt = (value: number | null): number | null =>
	value !== null && Number.isInteger(value) && value >= 0 ? value : null;

const asBool = (value: unknown): boolean | null => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value === 1 ? true : value === 0 ? false : null;
	}
	if (typeof value === "string") {
		const n = value.trim().toLowerCase();
		if (n === "true" || n === "1") return true;
		if (n === "false" || n === "0") return false;
	}
	return null;
};

const asStr = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseJsonUnknown = (value: string): unknown | null => {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
};

const mapSyncJobFixture = (raw: unknown): Fixture | null => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return null;
	}
	const row = raw as Record<string, unknown>;

	const id = asNum(row.id);
	const code = asNum(row.code);
	const eventId = asNum(row.eventId ?? row.event ?? row.event_id);
	const teamH = asNum(row.teamH ?? row.team_h ?? row.teamHId ?? row.team_h_id);
	const teamA = asNum(row.teamA ?? row.team_a ?? row.teamAId ?? row.team_a_id);

	const normalizedId = asPositiveInt(id);
	const normalizedEventId = asPositiveInt(eventId);
	const normalizedTeamH = asPositiveInt(teamH);
	const normalizedTeamA = asPositiveInt(teamA);
	const normalizedCode = asNonNegativeInt(code);
	if (
		normalizedId === null ||
		normalizedEventId === null ||
		normalizedTeamH === null ||
		normalizedTeamA === null ||
		normalizedCode === null
	) {
		return null;
	}

	const finished = asBool(row.finished) ?? false;
	const finishedProvisional = asBool(row.finishedProvisional ?? row.finished_provisional) ?? false;
	const kickoffTime = asStr(row.kickoffTime ?? row.kickoff_time);
	const minutes = asNum(row.minutes) ?? 0;
	const started = asBool(row.started);

	const teamHScore = asNum(row.teamHScore ?? row.team_h_score ?? row.teamHScore);
	const teamAScore = asNum(row.teamAScore ?? row.team_a_score ?? row.teamAScore);
	const teamHDifficulty = asNum(row.teamHDifficulty ?? row.team_h_difficulty);
	const teamADifficulty = asNum(row.teamADifficulty ?? row.team_a_difficulty);

	// A present but invalid timestamp means this cache field is not authoritative.
	if (kickoffTime !== null && toIso(kickoffTime) === null) {
		return null;
	}

	return {
		id: normalizedId,
		code: normalizedCode,
		eventId: normalizedEventId,
		finished,
		finishedProvisional,
		kickoffTime: toIso(kickoffTime),
		minutes: Math.trunc(minutes),
		started,
		teamHId: normalizedTeamH,
		teamAId: normalizedTeamA,
		teamHScore: teamHScore !== null ? Math.trunc(teamHScore) : null,
		teamAScore: teamAScore !== null ? Math.trunc(teamAScore) : null,
		teamHDifficulty: teamHDifficulty !== null ? Math.trunc(teamHDifficulty) : null,
		teamADifficulty: teamADifficulty !== null ? Math.trunc(teamADifficulty) : null,
	};
};

const loadEventFixturesFromRedis = async (
	context: GraphQLContext,
	eventId: number
): Promise<Fixture[] | null> => {
	const season = await getCurrentSeason(context);
	const hashKey = `Fixtures:${season}:${eventId}`;
	const meta = await loadLiveSnapshotMeta(context, eventId, { season });

	let hashEntries: Record<string, string>;
	try {
		hashEntries = await context.redis.hgetall(hashKey);
		if (meta && Object.keys(hashEntries).length !== meta.fixtureCount) {
			context.logger.warn(
				{
					hashKey,
					revision: meta.revision,
					expectedCount: meta.fixtureCount,
					actualCount: Object.keys(hashEntries).length,
				},
				"Incomplete Fixtures revision"
			);
			if (isLiveSnapshotConsistencyActive(context, eventId)) {
				throw new LiveSnapshotCoherenceError(
					eventId,
					"Fixtures",
					`Incomplete Fixtures revision ${meta.revision}`
				);
			}
			return null;
		}
	} catch (error) {
		if (error instanceof LiveSnapshotCoherenceError) throw error;
		context.logger.warn({ err: error, hashKey }, "Failed to read Fixtures hash from Redis");
		if (meta && isLiveSnapshotConsistencyActive(context, eventId)) {
			throw new LiveSnapshotCoherenceError(
				eventId,
				"Fixtures",
				`Fixtures view unavailable for revision ${meta.revision}`
			);
		}
		return null;
	}

	const fields = Object.entries(hashEntries);
	if (fields.length === 0) {
		// A confirmed blank gameweek is a complete, authoritative empty view.
		// Do not turn it into a database fallback: the live snapshot may be
		// available in Redis even when the relational read plane is unavailable.
		if (meta?.fixtureCount === 0 && meta.fixtureTeamCount === 0) {
			return [];
		}
		return null;
	}

	const fixtures: Fixture[] = [];
	const seenFixtureIds = new Set<number>();
	let malformed = false;
	for (const [fieldName, fieldValue] of fields) {
		const parsed = parseJsonUnknown(fieldValue);
		const fixture = mapSyncJobFixture(parsed);
		if (
			fixture &&
			fieldName === String(fixture.id) &&
			fixture.eventId === eventId &&
			!seenFixtureIds.has(fixture.id)
		) {
			seenFixtureIds.add(fixture.id);
			fixtures.push(fixture);
		} else {
			malformed = true;
		}
	}
	if (malformed) {
		metrics.cacheRepositoryEvents.labels("fixtures", "malformed").inc();
		context.logger.warn({ hashKey }, "Malformed Fixtures cache");
		if (meta && isLiveSnapshotConsistencyActive(context, eventId)) {
			throw new LiveSnapshotCoherenceError(
				eventId,
				"Fixtures",
				`Malformed Fixtures view for revision ${meta.revision}`
			);
		}
		return null;
	}

	fixtures.sort((a, b) => {
		if (!a.kickoffTime && !b.kickoffTime) return 0;
		if (!a.kickoffTime) return 1;
		if (!b.kickoffTime) return -1;
		return a.kickoffTime.localeCompare(b.kickoffTime);
	});

	if (fixtures.length === 0 && meta?.fixtureCount === 0 && meta.fixtureTeamCount === 0) {
		return [];
	}
	return fixtures.length > 0 ? fixtures : null;
};

const FIXTURE_COLUMNS =
	"id, code, event_id, finished, finished_provisional, kickoff_time, minutes, started, team_h_id, team_a_id, team_h_score, team_a_score, team_h_difficulty, team_a_difficulty";

const FIXTURE_FALLBACK_CACHE_TTL_SEC = 15;
const fixtureFallbackFlights = new WeakMap<object, Map<string, Promise<Fixture[]>>>();

const fixtureFallbackCacheKey = (
	season: string,
	eventId: number,
	meta: LiveSnapshotMeta | null
): string =>
	meta
		? gqlCacheKey(season, `fixtures:event:${eventId}:revision:${meta.revision}:fallback15`)
		: gqlCacheKey(season, `fixtures:event:${eventId}:fallback15`);

const parseFixtureFallbackCache = (raw: string, eventId: number): Fixture[] | null => {
	const parsed = parseJsonUnknown(raw);
	if (!Array.isArray(parsed)) return null;
	const fixtures: Fixture[] = [];
	const seenFixtureIds = new Set<number>();
	for (const value of parsed) {
		const fixture = mapSyncJobFixture(value);
		if (!fixture || fixture.eventId !== eventId || seenFixtureIds.has(fixture.id)) return null;
		seenFixtureIds.add(fixture.id);
		fixtures.push(fixture);
	}
	return fixtures;
};

const readFixtureFallbackCache = async (
	context: GraphQLContext,
	cacheKey: string,
	eventId: number
): Promise<Fixture[] | null> => {
	try {
		const raw = await context.redis.get(cacheKey);
		if (raw === null) return null;
		const parsed = parseFixtureFallbackCache(raw, eventId);
		if (parsed) return parsed;
		context.logger.warn({ cacheKey, eventId }, "Ignoring malformed fixture fallback cache");
	} catch (error) {
		context.logger.warn({ err: error, cacheKey, eventId }, "Failed to read fixture fallback cache");
	}
	return null;
};

const loadEventFixturesFromDatabase = async (
	context: GraphQLContext,
	eventId: number
): Promise<Fixture[]> => {
	const season = await getCurrentSeason(context);
	const meta = await loadLiveSnapshotMeta(context, eventId, { season });
	const cacheKey = fixtureFallbackCacheKey(season, eventId, meta);
	const cached = await readFixtureFallbackCache(context, cacheKey, eventId);
	if (cached !== null) return cached;

	const redisIdentity = context.redis as object;
	let flights = fixtureFallbackFlights.get(redisIdentity);
	if (!flights) {
		flights = new Map();
		fixtureFallbackFlights.set(redisIdentity, flights);
	}
	const existing = flights.get(cacheKey);
	if (existing) return existing;

	const flight = (async (): Promise<Fixture[]> => {
		const cachedAfterElection = await readFixtureFallbackCache(context, cacheKey, eventId);
		if (cachedAfterElection !== null) return cachedAfterElection;

		const { data, error } = await context.supabase
			.from("event_fixtures")
			.select(FIXTURE_COLUMNS)
			.eq("event_id", eventId)
			.order("kickoff_time", { ascending: true });

		if (error) {
			context.logger.error({ err: error, eventId }, "Failed to fetch event fixtures");
			throw new Error("Failed to fetch event fixtures");
		}

		const fixtures = (data as DbFixtureRow[] | null)?.map(mapFixture) ?? [];
		try {
			await context.redis.set(
				cacheKey,
				JSON.stringify(fixtures),
				"EX",
				FIXTURE_FALLBACK_CACHE_TTL_SEC
			);
		} catch (cacheError) {
			context.logger.warn(
				{ err: cacheError, cacheKey, eventId },
				"Failed to cache fixture database fallback"
			);
		}
		return fixtures;
	})();
	flights.set(cacheKey, flight);
	try {
		return await flight;
	} finally {
		if (flights.get(cacheKey) === flight) flights.delete(cacheKey);
	}
};

interface FixturesRepository {
	listFixtures(
		context: GraphQLContext,
		filter: FixturesFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Fixture[]>;
	getEventFixtures(context: GraphQLContext, eventId: number): Promise<Fixture[]>;
	getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]>;
}

export const fixturesRepository: FixturesRepository = {
	async listFixtures(
		context: GraphQLContext,
		filter: FixturesFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Fixture[]> {
		const normalizedFilter = normalizeFilter(filter);
		const safeLimit = clampLimit(limit);
		const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);

		let query = context.supabase.from("event_fixtures").select(FIXTURE_COLUMNS);

		if (normalizedFilter?.id !== undefined) {
			query = query.eq("id", normalizedFilter.id);
		}
		if (normalizedFilter?.eventId !== undefined) {
			query = query.eq("event_id", normalizedFilter.eventId);
		}
		if (normalizedFilter?.finished !== undefined) {
			query = query.eq("finished", normalizedFilter.finished);
		}
		if (normalizedFilter?.teamId !== undefined) {
			query = query.or(
				`team_h_id.eq.${normalizedFilter.teamId},team_a_id.eq.${normalizedFilter.teamId}`
			);
		}

		const { data, error } = await query
			.order("kickoff_time", { ascending: true })
			.order("id", { ascending: true })
			.range(safeOffset, safeOffset + safeLimit - 1);

		if (error) {
			context.logger.error({ err: error, filter: normalizedFilter }, "Failed to fetch fixtures");
			throw new Error("Failed to fetch fixtures");
		}

		return (data as DbFixtureRow[] | null)?.map(mapFixture) ?? [];
	},

	async getEventFixtures(context: GraphQLContext, eventId: number): Promise<Fixture[]> {
		if (!Number.isFinite(eventId) || eventId <= 0) {
			return [];
		}

		if (!isLiveSnapshotDatabaseFallback(context, eventId)) {
			const fromRedis = await loadEventFixturesFromRedis(context, eventId);
			if (fromRedis) {
				metrics.cacheRepositoryEvents.labels("fixtures", "redis").inc();
				return fromRedis;
			}
		}
		metrics.cacheRepositoryEvents.labels("fixtures", "database_fallback").inc();
		return loadEventFixturesFromDatabase(context, eventId);
	},

	async getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]> {
		const currentEventId = await getCurrentEventId(context);
		if (!currentEventId) {
			return [];
		}
		return this.getEventFixtures(context, currentEventId);
	},
};
