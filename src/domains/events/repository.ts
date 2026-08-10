import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { MAX_EVENT_ID } from "../../infra/config";
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

const GRAPHQL_INT_MIN = -2_147_483_648;
const GRAPHQL_INT_MAX = 2_147_483_647;

const parseNullableInt = (raw: unknown): number | null => {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "number" && typeof raw !== "string") return null;
	if (typeof raw === "string" && raw.trim().length === 0) return null;
	const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;
	return Number.isInteger(parsed) && parsed >= GRAPHQL_INT_MIN && parsed <= GRAPHQL_INT_MAX
		? parsed
		: null;
};

const parseOptionalIntField = (
	obj: Record<string, unknown>,
	key: string
): { value: number | null; valid: boolean } => {
	if (!Object.hasOwn(obj, key) || obj[key] === null) return { value: null, valid: true };
	const value = parseNullableInt(obj[key]);
	return { value, valid: value !== null };
};

const parseBooleanFlag = (value: unknown): boolean | null => {
	if (value === undefined || value === null) return false;
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	return null;
};

const parseEventFromRedisJson = (raw: string, expectedId?: number): Event | null => {
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const id = parseNullableInt(obj.id) ?? 0;
		if (!Number.isInteger(id) || id <= 0 || (expectedId !== undefined && id !== expectedId)) {
			return null;
		}
		const finished = parseBooleanFlag(obj.finished);
		const dataChecked = parseBooleanFlag(obj.dataChecked);
		const isPrevious = parseBooleanFlag(obj.isPrevious);
		const isCurrent = parseBooleanFlag(obj.isCurrent);
		const isNext = parseBooleanFlag(obj.isNext);
		const cupLeagueCreate = parseBooleanFlag(obj.cupLeagueCreate);
		const h2hKoMatchesCreated = parseBooleanFlag(obj.h2hKoMatchesCreated);
		if (
			finished === null ||
			dataChecked === null ||
			isPrevious === null ||
			isCurrent === null ||
			isNext === null ||
			cupLeagueCreate === null ||
			h2hKoMatchesCreated === null
		) {
			return null;
		}
		const numericFields = {
			averageEntryScore: parseOptionalIntField(obj, "averageEntryScore"),
			highestScoringEntry: parseOptionalIntField(obj, "highestScoringEntry"),
			deadlineTimeEpoch: parseOptionalIntField(obj, "deadlineTimeEpoch"),
			deadlineTimeGameOffset: parseOptionalIntField(obj, "deadlineTimeGameOffset"),
			highestScore: parseOptionalIntField(obj, "highestScore"),
			mostSelected: parseOptionalIntField(obj, "mostSelected"),
			mostTransferredIn: parseOptionalIntField(obj, "mostTransferredIn"),
			topElement: parseOptionalIntField(obj, "topElement"),
			transfersMade: parseOptionalIntField(obj, "transfersMade"),
			mostCaptained: parseOptionalIntField(obj, "mostCaptained"),
			mostViceCaptained: parseOptionalIntField(obj, "mostViceCaptained"),
		};
		if (Object.values(numericFields).some((field) => !field.valid)) return null;
		return {
			id,
			name: String(obj.name ?? ""),
			deadlineTime: normalizeDeadlineTime(obj.deadlineTime, obj.deadlineTimeEpoch),
			averageEntryScore: numericFields.averageEntryScore.value,
			finished,
			dataChecked,
			highestScoringEntry: numericFields.highestScoringEntry.value,
			deadlineTimeEpoch: numericFields.deadlineTimeEpoch.value,
			deadlineTimeGameOffset: numericFields.deadlineTimeGameOffset.value,
			highestScore: numericFields.highestScore.value,
			isPrevious,
			isCurrent,
			isNext,
			cupLeagueCreate,
			h2hKoMatchesCreated,
			chipPlays: parseChipPlays(obj.chipPlays),
			mostSelected: numericFields.mostSelected.value,
			mostTransferredIn: numericFields.mostTransferredIn.value,
			topElement: numericFields.topElement.value,
			topElementInfo: parseTopElementInfo(obj.topElementInfo),
			transfersMade: numericFields.transfersMade.value,
			mostCaptained: numericFields.mostCaptained.value,
			mostViceCaptained: numericFields.mostViceCaptained.value,
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

const filterAndSliceEvents = (
	events: Event[],
	filter: EventsFilter | undefined,
	offset: number,
	limit: number
): Event[] =>
	events
		.filter((event) => {
			if (filter?.isPrevious !== undefined && event.isPrevious !== filter.isPrevious) return false;
			if (filter?.isCurrent !== undefined && event.isCurrent !== filter.isCurrent) return false;
			if (filter?.isNext !== undefined && event.isNext !== filter.isNext) return false;
			if (filter?.finished !== undefined && event.finished !== filter.finished) return false;
			if (filter?.dataChecked !== undefined && event.dataChecked !== filter.dataChecked)
				return false;
			return true;
		})
		.slice(offset, offset + limit);

const applyCurrentEventPointer = (events: Event[], currentEventId: number | null): Event[] => {
	if (!currentEventId) return events;
	return events.map((event) => ({
		...event,
		isPrevious: event.id === currentEventId - 1,
		isCurrent: event.id === currentEventId,
		isNext: event.id === currentEventId + 1,
	}));
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
		const currentEvent = await getCurrentEventFromRedis(context);
		let raw: string | null = null;
		try {
			raw = await context.redis.hget(`Event:${season}`, String(id));
		} catch (error) {
			context.logger.warn({ err: error, season, id }, "Failed to read Event hash");
		}
		if (raw) {
			const event = parseEventFromRedisJson(raw, id);
			if (event) {
				return applyCurrentEventPointer([event], currentEvent?.id ?? null)[0] ?? null;
			}
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

		return applyCurrentEventPointer([mapEvent(row)], currentEvent?.id ?? null)[0] ?? null;
	},

	async getCurrentEventInfo(context: GraphQLContext): Promise<CurrentEventInfo | null> {
		const season = await getCurrentSeason(context);
		const current = await getCurrentEventFromRedis(context);

		try {
			const rawEvents = await context.redis.hvals(`Event:${season}`);
			if (rawEvents.length > 0) {
				const parsedEvents = rawEvents.map((raw) => parseEventFromRedisJson(raw));
				if (parsedEvents.every((event): event is Event => event !== null)) {
					const pointerCovered =
						current === null ||
						(parsedEvents.some((event) => event.id === current.id) &&
							(current.id >= MAX_EVENT_ID ||
								parsedEvents.some((event) => event.id === current.id + 1)));
					if (pointerCovered) {
						const resolved = resolveCurrentAndNext(parsedEvents.map(toEventMetadata), current?.id);
						if (resolved.current || resolved.next) {
							return {
								season,
								currentEvent: resolved.current?.id ?? null,
								nextEvent: resolved.next?.id ?? null,
								nextUtcDeadline: resolved.next?.deadlineTime ?? null,
							};
						}
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
		const currentEvent = await getCurrentEventFromRedis(context);

		// For isCurrent/isNext filters, derive the answer from event:current rather than
		// trusting the flags stored in Event:{season}. The sync writes event:current first
		// and updates the hash flags separately, so the hash can lag behind.
		if (normalizedFilter?.isCurrent === true || normalizedFilter?.isNext === true) {
			if (currentEvent) {
				const season = await getCurrentSeason(context);

				if (normalizedFilter.isCurrent === true) {
					let raw: string | null = null;
					try {
						raw = await context.redis.hget(`Event:${season}`, String(currentEvent.id));
					} catch (error) {
						context.logger.warn({ err: error, season }, "Failed to read current Event hash row");
					}
					const event = raw ? parseEventFromRedisJson(raw, currentEvent.id) : null;
					if (event) {
						return filterAndSliceEvents(
							[{ ...event, isCurrent: true, isNext: false }],
							normalizedFilter,
							safeOffset,
							safeLimit
						);
					}
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
					const event = raw ? parseEventFromRedisJson(raw, nextId) : null;
					if (event) {
						return filterAndSliceEvents(
							[{ ...event, isNext: true, isCurrent: false }],
							normalizedFilter,
							safeOffset,
							safeLimit
						);
					}
					// The current pointer can be readable while the next row is still
					// missing from Redis. Fall through to the complete hash/DB path.
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
			const parsedEvents = rawList.map((raw) => parseEventFromRedisJson(raw));
			if (parsedEvents.some((event) => event === null)) {
				context.logger.warn(
					{ season, count: rawList.length },
					"Event hash contains malformed rows; falling back to database"
				);
			} else {
				const events = applyCurrentEventPointer(
					parsedEvents.filter((e): e is Event => e !== null).sort((a, b) => a.id - b.id),
					currentEvent?.id ?? null
				);

				return filterAndSliceEvents(events, normalizedFilter, safeOffset, safeLimit);
			}
		}

		// Fallback: Supabase query
		const query = context.supabase.from("events").select("*");

		const { data, error } = await query.order("id", { ascending: true });

		if (error) {
			context.logger.error({ err: error, filter: normalizedFilter }, "Failed to fetch events");
			throw new Error("Failed to fetch events");
		}

		return filterAndSliceEvents(
			applyCurrentEventPointer(
				(data as DbEventRow[] | null)?.map(mapEvent) ?? [],
				currentEvent?.id ?? null
			),
			normalizedFilter,
			safeOffset,
			safeLimit
		);
	},
};
