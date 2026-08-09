import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { getCurrentEventFromRedis } from "../../infra/event";
import { getCurrentSeason } from "../../infra/season";

export type ChipPlay = {
	chipName: string;
	numberPlayed: number;
};

export type TopElementInfo = {
	element: number;
	points: number;
};

export type Event = {
	id: number;
	name: string;
	deadlineTime: string | null;
	averageEntryScore: number | null;
	finished: boolean;
	dataChecked: boolean;
	highestScoringEntry: number | null;
	deadlineTimeEpoch: number | null;
	deadlineTimeGameOffset: number | null;
	highestScore: number | null;
	isPrevious: boolean;
	isCurrent: boolean;
	isNext: boolean;
	cupLeagueCreate: boolean;
	h2hKoMatchesCreated: boolean;
	chipPlays: ChipPlay[] | null;
	mostSelected: number | null;
	mostTransferredIn: number | null;
	topElement: number | null;
	topElementInfo: TopElementInfo | null;
	transfersMade: number | null;
	mostCaptained: number | null;
	mostViceCaptained: number | null;
};

export type EventsFilter = {
	isPrevious?: boolean | null;
	isCurrent?: boolean | null;
	isNext?: boolean | null;
	finished?: boolean | null;
	dataChecked?: boolean | null;
};

type DbEventRow = {
	id: number;
	name: string;
	deadline_time: string | null;
	average_entry_score: number | null;
	finished: boolean;
	data_checked: boolean;
	highest_scoring_entry: number | null;
	deadline_time_epoch: number | null;
	deadline_time_game_offset: number | null;
	highest_score: number | null;
	is_previous: boolean;
	is_current: boolean;
	is_next: boolean;
	cup_league_create: boolean;
	h2h_ko_matches_created: boolean;
	chip_plays: unknown[] | null;
	most_selected: number | null;
	most_transferred_in: number | null;
	top_element: number | null;
	top_element_info: unknown | null;
	transfers_made: number | null;
	most_captained: number | null;
	most_vice_captained: number | null;
};

const mapEvent = (row: DbEventRow): Event => ({
	id: row.id,
	name: row.name,
	deadlineTime: normalizeDeadlineTime(row.deadline_time, row.deadline_time_epoch),
	averageEntryScore: row.average_entry_score,
	finished: row.finished,
	dataChecked: row.data_checked,
	highestScoringEntry: row.highest_scoring_entry,
	deadlineTimeEpoch: row.deadline_time_epoch,
	deadlineTimeGameOffset: row.deadline_time_game_offset,
	highestScore: row.highest_score,
	isPrevious: row.is_previous,
	isCurrent: row.is_current,
	isNext: row.is_next,
	cupLeagueCreate: row.cup_league_create,
	h2hKoMatchesCreated: row.h2h_ko_matches_created,
	chipPlays: parseChipPlays(row.chip_plays),
	mostSelected: row.most_selected,
	mostTransferredIn: row.most_transferred_in,
	topElement: row.top_element,
	topElementInfo: parseTopElementInfo(row.top_element_info),
	transfersMade: row.transfers_made,
	mostCaptained: row.most_captained,
	mostViceCaptained: row.most_vice_captained,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeDeadlineTime = (
	deadlineTime: unknown,
	deadlineTimeEpoch: unknown
): string | null => {
	if (typeof deadlineTime === "string" && deadlineTime.trim().length > 0) {
		const normalizedInput = deadlineTime
			.trim()
			.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, "$1T$2")
			.replace(/([+-]\d{2})$/, "$1:00");
		const timestamp = Date.parse(normalizedInput);
		if (Number.isFinite(timestamp)) {
			const date = new Date(timestamp);
			if (Number.isFinite(date.getTime())) return date.toISOString();
		}
	}

	const epoch = Number(deadlineTimeEpoch);
	if (deadlineTimeEpoch !== null && deadlineTimeEpoch !== undefined && Number.isFinite(epoch)) {
		const timestamp = epoch * 1000;
		if (Number.isFinite(timestamp)) {
			const date = new Date(timestamp);
			if (Number.isFinite(date.getTime())) return date.toISOString();
		}
	}

	return null;
};

const parseChipPlays = (raw: unknown): ChipPlay[] | null => {
	if (!Array.isArray(raw)) return null;
	const parsed = raw
		.map((item): ChipPlay | null => {
			if (!isRecord(item)) return null;
			return {
				chipName: String(item.chipName ?? item.chip_name ?? ""),
				numberPlayed: Number(item.numberPlayed ?? item.num_played ?? 0),
			};
		})
		.filter((item): item is ChipPlay => item !== null);
	return parsed.length > 0 ? parsed : null;
};

const parseTopElementInfo = (raw: unknown): TopElementInfo | null => {
	if (!isRecord(raw)) return null;
	return {
		element: Number(raw.element ?? raw.id ?? 0),
		points: Number(raw.points ?? 0),
	};
};

const parseEventFromRedisJson = (raw: string): Event | null => {
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		return {
			id: Number(obj.id ?? 0),
			name: String(obj.name ?? ""),
			deadlineTime: normalizeDeadlineTime(obj.deadlineTime, obj.deadlineTimeEpoch),
			averageEntryScore: obj.averageEntryScore !== null ? Number(obj.averageEntryScore) : null,
			finished: Boolean(obj.finished),
			dataChecked: Boolean(obj.dataChecked),
			highestScoringEntry:
				obj.highestScoringEntry !== null ? Number(obj.highestScoringEntry) : null,
			deadlineTimeEpoch: obj.deadlineTimeEpoch !== null ? Number(obj.deadlineTimeEpoch) : null,
			deadlineTimeGameOffset:
				obj.deadlineTimeGameOffset !== null ? Number(obj.deadlineTimeGameOffset) : null,
			highestScore: obj.highestScore !== null ? Number(obj.highestScore) : null,
			isPrevious: Boolean(obj.isPrevious),
			isCurrent: Boolean(obj.isCurrent),
			isNext: Boolean(obj.isNext),
			cupLeagueCreate: Boolean(obj.cupLeagueCreate),
			h2hKoMatchesCreated: Boolean(obj.h2hKoMatchesCreated),
			chipPlays: parseChipPlays(obj.chipPlays),
			mostSelected: obj.mostSelected !== null ? Number(obj.mostSelected) : null,
			mostTransferredIn: obj.mostTransferredIn !== null ? Number(obj.mostTransferredIn) : null,
			topElement: obj.topElement !== null ? Number(obj.topElement) : null,
			topElementInfo: parseTopElementInfo(obj.topElementInfo),
			transfersMade: obj.transfersMade !== null ? Number(obj.transfersMade) : null,
			mostCaptained: obj.mostCaptained !== null ? Number(obj.mostCaptained) : null,
			mostViceCaptained: obj.mostViceCaptained !== null ? Number(obj.mostViceCaptained) : null,
		};
	} catch {
		return null;
	}
};

const normalizeFilter = (filter?: EventsFilter | null): EventsFilter | undefined => {
	if (!filter) {
		return undefined;
	}
	return {
		isPrevious: filter.isPrevious ?? undefined,
		isCurrent: filter.isCurrent ?? undefined,
		isNext: filter.isNext ?? undefined,
		finished: filter.finished ?? undefined,
		dataChecked: filter.dataChecked ?? undefined,
	};
};

const clampLimit = (limit: number): number => {
	const safeLimit = Number.isFinite(limit) ? limit : 50;
	return Math.min(Math.max(safeLimit, 1), 200);
};

export type CurrentEventInfo = {
	season: string;
	currentEvent: number | null;
	nextEvent: number | null;
	nextUtcDeadline: string | null;
};

type EventMetadata = {
	id: number;
	deadlineTime: string | null;
	deadlineTimeEpoch: number | null;
	isCurrent: boolean;
	isNext: boolean;
};

const toEventMetadata = (event: Event): EventMetadata => ({
	id: event.id,
	deadlineTime: event.deadlineTime,
	deadlineTimeEpoch: event.deadlineTimeEpoch,
	isCurrent: event.isCurrent,
	isNext: event.isNext,
});

const resolveCurrentAndNext = (
	events: EventMetadata[],
	preferredCurrentId?: number | null
): { current: EventMetadata | null; next: EventMetadata | null } => {
	const sorted = [...events].sort((a, b) => a.id - b.id);
	const nowEpoch = Math.floor(Date.now() / 1000);
	const preferredCurrent = preferredCurrentId
		? (sorted.find((event) => event.id === preferredCurrentId) ?? null)
		: null;
	const flaggedCurrent = sorted.find((event) => event.isCurrent) ?? null;
	const derivedCurrent =
		sorted
			.filter((event) => event.deadlineTimeEpoch !== null && event.deadlineTimeEpoch <= nowEpoch)
			.sort((a, b) => (b.deadlineTimeEpoch ?? 0) - (a.deadlineTimeEpoch ?? 0))[0] ?? null;
	const current = preferredCurrent ?? flaggedCurrent ?? derivedCurrent;

	if (current) {
		return {
			current,
			next: sorted.find((event) => event.id === current.id + 1) ?? null,
		};
	}

	const flaggedNext = sorted.find((event) => event.isNext) ?? null;
	const derivedNext =
		sorted
			.filter((event) => event.deadlineTimeEpoch !== null && event.deadlineTimeEpoch > nowEpoch)
			.sort((a, b) => (a.deadlineTimeEpoch ?? 0) - (b.deadlineTimeEpoch ?? 0))[0] ?? null;
	return { current: null, next: flaggedNext ?? derivedNext };
};

interface EventsRepository {
	getEventById(context: GraphQLContext, id: number): Promise<Event | null>;
	listEvents(
		context: GraphQLContext,
		filter: EventsFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Event[]>;
	getCurrentEventInfo(context: GraphQLContext): Promise<CurrentEventInfo | null>;
}

export const eventsRepository: EventsRepository = {
	async getEventById(context: GraphQLContext, id: number): Promise<Event | null> {
		if (!Number.isFinite(id) || id <= 0) {
			return null;
		}

		// Try Redis hash first — Event:{season} is maintained by external sync
		const season = await getCurrentSeason(context);
		let raw: string | null = null;
		try {
			raw = await context.redis.hget(`Event:${season}`, String(id));
		} catch (error) {
			context.logger.warn({ err: error, season, id }, "Failed to read Event hash");
		}
		if (raw) {
			const event = parseEventFromRedisJson(raw);
			if (event) return event;
		}

		// Fallback: Supabase query
		const { data, error } = await context.supabase.from("events").select("*").eq("id", id).limit(1);

		if (error) {
			context.logger.error({ err: error, id }, "Failed to fetch event");
			throw new Error("Failed to fetch event");
		}

		const row = data?.[0] as DbEventRow | undefined;
		if (!row) {
			return null;
		}

		return mapEvent(row);
	},

	async getCurrentEventInfo(context: GraphQLContext): Promise<CurrentEventInfo | null> {
		const season = await getCurrentSeason(context);
		const current = await getCurrentEventFromRedis(context);

		try {
			const rawEvents = await context.redis.hvals(`Event:${season}`);
			if (rawEvents.length > 0) {
				const parsedEvents = rawEvents.map(parseEventFromRedisJson);
				if (parsedEvents.every((event): event is Event => event !== null)) {
					const resolved = resolveCurrentAndNext(parsedEvents.map(toEventMetadata), current?.id);
					if (resolved.current || resolved.next) {
						return {
							season,
							currentEvent: resolved.current?.id ?? null,
							nextEvent: resolved.next?.id ?? null,
							nextUtcDeadline: resolved.next?.deadlineTime ?? null,
						};
					}
				} else {
					context.logger.warn({ season }, "Event hash contains malformed metadata rows");
				}
			}
		} catch (error) {
			context.logger.warn({ err: error, season }, "Failed to read Event metadata hash");
		}

		const { data, error } = await context.supabase
			.from("events")
			.select("id,deadline_time,deadline_time_epoch,is_current,is_next")
			.order("id", { ascending: true });

		if (error) {
			context.logger.error({ err: error }, "Failed to fetch current/next event");
			throw new GraphQLError("Current event metadata is unavailable", {
				extensions: {
					code: "CACHE_METADATA_UNAVAILABLE",
					http: { status: 503 },
				},
			});
		}

		const rows = (data ?? []) as Array<{
			id: number;
			deadline_time: string | null;
			deadline_time_epoch: number | null;
			is_current: boolean;
			is_next: boolean;
		}>;
		const resolved = resolveCurrentAndNext(
			rows.map((row) => ({
				id: row.id,
				deadlineTime: normalizeDeadlineTime(row.deadline_time, row.deadline_time_epoch),
				deadlineTimeEpoch: row.deadline_time_epoch,
				isCurrent: row.is_current,
				isNext: row.is_next,
			})),
			current?.id
		);

		if (!resolved.current && !resolved.next) {
			return null;
		}

		return {
			season,
			currentEvent: resolved.current?.id ?? null,
			nextEvent: resolved.next?.id ?? null,
			nextUtcDeadline: resolved.next?.deadlineTime ?? null,
		};
	},

	async listEvents(
		context: GraphQLContext,
		filter: EventsFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Event[]> {
		const normalizedFilter = normalizeFilter(filter);
		const safeLimit = clampLimit(limit);
		const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);

		// For isCurrent/isNext filters, derive the answer from event:current rather than
		// trusting the flags stored in Event:{season}. The sync writes event:current first
		// and updates the hash flags separately, so the hash can lag behind.
		if (normalizedFilter?.isCurrent === true || normalizedFilter?.isNext === true) {
			const currentEvent = await getCurrentEventFromRedis(context);
			if (currentEvent) {
				const season = await getCurrentSeason(context);

				if (normalizedFilter.isCurrent === true) {
					let raw: string | null = null;
					try {
						raw = await context.redis.hget(`Event:${season}`, String(currentEvent.id));
					} catch (error) {
						context.logger.warn({ err: error, season }, "Failed to read current Event hash row");
					}
					const event = raw ? parseEventFromRedisJson(raw) : null;
					if (event) return [{ ...event, isCurrent: true, isNext: false }];
				}

				if (normalizedFilter.isNext === true) {
					const nextId = currentEvent.id + 1;
					let raw: string | null = null;
					try {
						raw = await context.redis.hget(`Event:${season}`, String(nextId));
					} catch (error) {
						context.logger.warn(
							{ err: error, season, nextId },
							"Failed to read next Event hash row"
						);
					}
					const event = raw ? parseEventFromRedisJson(raw) : null;
					if (event) return [{ ...event, isNext: true, isCurrent: false }];
					return [];
				}
			}
			// Fall through to hash scan if event:current is unavailable
		}

		// Try Redis hash first — Event:{season} is maintained by external sync
		const season = await getCurrentSeason(context);
		let rawList: string[] = [];
		try {
			rawList = await context.redis.hvals(`Event:${season}`);
		} catch (error) {
			context.logger.warn({ err: error, season }, "Failed to read Event hash values");
		}
		if (rawList.length > 0) {
			const parsedEvents = rawList.map(parseEventFromRedisJson);
			if (parsedEvents.some((event) => event === null)) {
				context.logger.warn(
					{ season, count: rawList.length },
					"Event hash contains malformed rows; falling back to database"
				);
			} else {
				const events = parsedEvents
					.filter((e): e is Event => e !== null)
					.sort((a, b) => a.id - b.id);

				const filtered = events.filter((event) => {
					if (
						normalizedFilter?.isPrevious !== undefined &&
						event.isPrevious !== normalizedFilter.isPrevious
					)
						return false;
					if (
						normalizedFilter?.isCurrent !== undefined &&
						event.isCurrent !== normalizedFilter.isCurrent
					)
						return false;
					if (normalizedFilter?.isNext !== undefined && event.isNext !== normalizedFilter.isNext)
						return false;
					if (
						normalizedFilter?.finished !== undefined &&
						event.finished !== normalizedFilter.finished
					)
						return false;
					if (
						normalizedFilter?.dataChecked !== undefined &&
						event.dataChecked !== normalizedFilter.dataChecked
					)
						return false;
					return true;
				});

				return filtered.slice(safeOffset, safeOffset + safeLimit);
			}
		}

		// Fallback: Supabase query
		let query = context.supabase.from("events").select("*");

		if (normalizedFilter?.isPrevious !== undefined) {
			query = query.eq("is_previous", normalizedFilter.isPrevious);
		}
		if (normalizedFilter?.isCurrent !== undefined) {
			query = query.eq("is_current", normalizedFilter.isCurrent);
		}
		if (normalizedFilter?.isNext !== undefined) {
			query = query.eq("is_next", normalizedFilter.isNext);
		}
		if (normalizedFilter?.finished !== undefined) {
			query = query.eq("finished", normalizedFilter.finished);
		}
		if (normalizedFilter?.dataChecked !== undefined) {
			query = query.eq("data_checked", normalizedFilter.dataChecked);
		}

		const { data, error } = await query
			.order("id", { ascending: true })
			.range(safeOffset, safeOffset + safeLimit - 1);

		if (error) {
			context.logger.error({ err: error, filter: normalizedFilter }, "Failed to fetch events");
			throw new Error("Failed to fetch events");
		}

		return (data as DbEventRow[] | null)?.map(mapEvent) ?? [];
	},
};
