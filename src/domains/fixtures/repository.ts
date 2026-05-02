import type { GraphQLContext } from "../../graphql/context";
import { getCurrentEventId } from "../../infra/event";
import { getCurrentSeason } from "../../infra/season";

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
	return new Date(value).toISOString();
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

const normalizeFilter = (
	filter?: FixturesFilter | null,
): FixturesFilter | undefined => {
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
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

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

const asStr = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

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
	const eventId = asNum(row.event ?? row.event_id);
	const teamH = asNum(row.teamH ?? row.team_h ?? row.teamHId ?? row.team_h_id);
	const teamA = asNum(row.teamA ?? row.team_a ?? row.teamAId ?? row.team_a_id);

	if (id === null || eventId === null || teamH === null || teamA === null) {
		return null;
	}

	const finished = asBool(row.finished) ?? false;
	const finishedProvisional =
		asBool(row.finishedProvisional ?? row.finished_provisional) ?? false;
	const kickoffTime = asStr(row.kickoffTime ?? row.kickoff_time);
	const minutes = asNum(row.minutes) ?? 0;
	const started = asBool(row.started);

	const teamHScore = asNum(
		row.teamHScore ?? row.team_h_score ?? row.teamHScore,
	);
	const teamAScore = asNum(
		row.teamAScore ?? row.team_a_score ?? row.teamAScore,
	);
	const teamHDifficulty = asNum(row.teamHDifficulty ?? row.team_h_difficulty);
	const teamADifficulty = asNum(row.teamADifficulty ?? row.team_a_difficulty);

	return {
		id: Math.trunc(id),
		code: Math.trunc(code ?? 0),
		eventId: Math.trunc(eventId),
		finished,
		finishedProvisional,
		kickoffTime: toIso(kickoffTime),
		minutes: Math.trunc(minutes),
		started,
		teamHId: Math.trunc(teamH),
		teamAId: Math.trunc(teamA),
		teamHScore: teamHScore !== null ? Math.trunc(teamHScore) : null,
		teamAScore: teamAScore !== null ? Math.trunc(teamAScore) : null,
		teamHDifficulty:
			teamHDifficulty !== null ? Math.trunc(teamHDifficulty) : null,
		teamADifficulty:
			teamADifficulty !== null ? Math.trunc(teamADifficulty) : null,
	};
};

const loadEventFixturesFromRedis = async (
	context: GraphQLContext,
	eventId: number,
): Promise<Fixture[] | null> => {
	const season = await getCurrentSeason(context);
	const hashKey = `Fixtures:${season}:${eventId}`;

	let hashEntries: Record<string, string>;
	try {
		hashEntries = await context.redis.hgetall(hashKey);
	} catch (error) {
		context.logger.warn(
			{ err: error, hashKey },
			"Failed to read Fixtures hash from Redis",
		);
		return null;
	}

	const fields = Object.values(hashEntries);
	if (fields.length === 0) {
		return null;
	}

	const fixtures: Fixture[] = [];
	for (const fieldValue of fields) {
		const parsed = parseJsonUnknown(fieldValue);
		const fixture = mapSyncJobFixture(parsed);
		if (fixture) {
			fixtures.push(fixture);
		}
	}

	fixtures.sort((a, b) => {
		if (!a.kickoffTime && !b.kickoffTime) return 0;
		if (!a.kickoffTime) return 1;
		if (!b.kickoffTime) return -1;
		return a.kickoffTime.localeCompare(b.kickoffTime);
	});

	return fixtures.length > 0 ? fixtures : null;
};

const FIXTURE_COLUMNS =
	"id, code, event_id, finished, finished_provisional, kickoff_time, minutes, started, team_h_id, team_a_id, team_h_score, team_a_score, team_h_difficulty, team_a_difficulty";

interface FixturesRepository {
	listFixtures(
		context: GraphQLContext,
		filter: FixturesFilter | null | undefined,
		limit: number,
		offset: number,
	): Promise<Fixture[]>;
	getEventFixtures(
		context: GraphQLContext,
		eventId: number,
	): Promise<Fixture[]>;
	getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]>;
}

export const fixturesRepository: FixturesRepository = {
	async listFixtures(
		context: GraphQLContext,
		filter: FixturesFilter | null | undefined,
		limit: number,
		offset: number,
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
				`team_h_id.eq.${normalizedFilter.teamId},team_a_id.eq.${normalizedFilter.teamId}`,
			);
		}

		const { data, error } = await query
			.order("kickoff_time", { ascending: true })
			.range(safeOffset, safeOffset + safeLimit - 1);

		if (error) {
			context.logger.error(
				{ err: error, filter: normalizedFilter },
				"Failed to fetch fixtures",
			);
			throw new Error("Failed to fetch fixtures");
		}

		return (data as DbFixtureRow[] | null)?.map(mapFixture) ?? [];
	},

	async getEventFixtures(
		context: GraphQLContext,
		eventId: number,
	): Promise<Fixture[]> {
		if (!Number.isFinite(eventId) || eventId <= 0) {
			return [];
		}

		const fromRedis = await loadEventFixturesFromRedis(context, eventId);
		if (fromRedis) {
			return fromRedis;
		}

		const { data, error } = await context.supabase
			.from("event_fixtures")
			.select(FIXTURE_COLUMNS)
			.eq("event_id", eventId)
			.order("kickoff_time", { ascending: true });

		if (error) {
			context.logger.error(
				{ err: error, eventId },
				"Failed to fetch event fixtures",
			);
			throw new Error("Failed to fetch event fixtures");
		}

		return (data as DbFixtureRow[] | null)?.map(mapFixture) ?? [];
	},

	async getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]> {
		const currentEventId = await getCurrentEventId(context);
		if (!currentEventId) {
			return [];
		}
		return this.getEventFixtures(context, currentEventId);
	},
};
