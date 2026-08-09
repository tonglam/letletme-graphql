import type { GraphQLContext } from "../../graphql/context";
import { getCoreDataSnapshot, type CoreEventData } from "../../infra/data-snapshot";
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
		if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	}

	const epoch = Number(deadlineTimeEpoch);
	if (deadlineTimeEpoch !== null && deadlineTimeEpoch !== undefined && Number.isFinite(epoch)) {
		return new Date(epoch * 1000).toISOString();
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

const mapEvent = (row: CoreEventData): Event => ({
	id: row.id,
	name: row.name,
	deadlineTime: normalizeDeadlineTime(row.deadlineTime, row.deadlineTimeEpoch),
	averageEntryScore: row.averageEntryScore,
	finished: row.finished,
	dataChecked: row.dataChecked,
	highestScoringEntry: row.highestScoringEntry,
	deadlineTimeEpoch: row.deadlineTimeEpoch,
	deadlineTimeGameOffset: row.deadlineTimeGameOffset,
	highestScore: row.highestScore,
	isPrevious: row.isPrevious,
	isCurrent: row.isCurrent,
	isNext: row.isNext,
	cupLeagueCreate: row.cupLeagueCreate,
	h2hKoMatchesCreated: row.h2hKoMatchesCreated,
	chipPlays: parseChipPlays(row.chipPlays),
	mostSelected: row.mostSelected,
	mostTransferredIn: row.mostTransferredIn,
	topElement: row.topElement,
	topElementInfo: parseTopElementInfo(row.topElementInfo),
	transfersMade: row.transfersMade,
	mostCaptained: row.mostCaptained,
	mostViceCaptained: row.mostViceCaptained,
});

const normalizeFilter = (filter?: EventsFilter | null): EventsFilter | undefined =>
	filter
		? {
				isPrevious: filter.isPrevious ?? undefined,
				isCurrent: filter.isCurrent ?? undefined,
				isNext: filter.isNext ?? undefined,
				finished: filter.finished ?? undefined,
				dataChecked: filter.dataChecked ?? undefined,
			}
		: undefined;

const clampLimit = (limit: number): number =>
	Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);

export type CurrentEventInfo = {
	season: string;
	currentEvent: number | null;
	nextEvent: number | null;
	nextUtcDeadline: string | null;
};

type EventMetadata = Pick<
	Event,
	"id" | "deadlineTime" | "deadlineTimeEpoch" | "isCurrent" | "isNext"
>;

const resolveCurrentAndNext = (
	events: EventMetadata[],
	preferredCurrentId?: number | null
): { current: EventMetadata | null; next: EventMetadata | null } => {
	const sorted = [...events].sort((left, right) => left.id - right.id);
	const preferredCurrent = preferredCurrentId
		? (sorted.find((event) => event.id === preferredCurrentId) ?? null)
		: null;
	const flaggedCurrent = sorted.find((event) => event.isCurrent) ?? null;
	const current = preferredCurrent ?? flaggedCurrent;
	if (current) {
		return {
			current,
			next: sorted.find((event) => event.id === current.id + 1) ?? null,
		};
	}
	const flaggedNext = sorted.find((event) => event.isNext) ?? null;
	return { current: null, next: flaggedNext };
};

const matchesFilter = (event: Event, filter: EventsFilter | undefined): boolean => {
	if (!filter) return true;
	if (filter.isPrevious !== undefined && event.isPrevious !== filter.isPrevious) return false;
	if (filter.isCurrent !== undefined && event.isCurrent !== filter.isCurrent) return false;
	if (filter.isNext !== undefined && event.isNext !== filter.isNext) return false;
	if (filter.finished !== undefined && event.finished !== filter.finished) return false;
	if (filter.dataChecked !== undefined && event.dataChecked !== filter.dataChecked) return false;
	return true;
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
	async getEventById(context, id) {
		if (!Number.isSafeInteger(id) || id <= 0) return null;
		const snapshot = await getCoreDataSnapshot(context);
		const event = snapshot.events.find((candidate) => candidate.id === id);
		return event ? mapEvent(event) : null;
	},

	async getCurrentEventInfo(context) {
		const [season, snapshot] = await Promise.all([
			getCurrentSeason(context),
			getCoreDataSnapshot(context),
		]);
		const resolved = resolveCurrentAndNext(snapshot.events.map(mapEvent), snapshot.currentEventId);
		if (!resolved.current && !resolved.next) return null;
		return {
			season,
			currentEvent: resolved.current?.id ?? null,
			nextEvent: resolved.next?.id ?? null,
			nextUtcDeadline: resolved.next?.deadlineTime ?? null,
		};
	},

	async listEvents(context, filter, limit, offset) {
		const snapshot = await getCoreDataSnapshot(context);
		const normalizedFilter = normalizeFilter(filter);
		const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);
		return snapshot.events
			.map(mapEvent)
			.filter((event) => matchesFilter(event, normalizedFilter))
			.sort((left, right) => left.id - right.id)
			.slice(safeOffset, safeOffset + clampLimit(limit));
	},
};
