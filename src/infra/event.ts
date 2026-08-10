import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../graphql/context";

const EVENT_CURRENT_KEY = "event:current";
const currentEventIdMemo = new WeakMap<GraphQLContext, Promise<number | null>>();

export type CurrentEventCache = {
	id: number;
	name: string | null;
	deadlineTime: string | null;
	deadlineTimeEpoch: number | null;
	isCurrent: boolean;
	isNext: boolean;
	finished: boolean;
	dataChecked: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseBooleanFlag = (value: unknown): boolean | null => {
	if (value === undefined || value === null) return false;
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	return null;
};

const parsePositiveIntegerId = (value: unknown): number | null => {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	}
	return null;
};

const parseCurrentEvent = (raw: string | null): CurrentEventCache | null => {
	if (!raw) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(parsed)) {
		return null;
	}

	const idValue = parsePositiveIntegerId(parsed.id);
	if (idValue === null) {
		return null;
	}
	const isCurrent = parseBooleanFlag(parsed.isCurrent);
	const isNext = parseBooleanFlag(parsed.isNext);
	const finished = parseBooleanFlag(parsed.finished);
	const dataChecked = parseBooleanFlag(parsed.dataChecked);
	if (isCurrent === null || isNext === null || finished === null || dataChecked === null) {
		return null;
	}

	return {
		id: idValue,
		name: typeof parsed.name === "string" ? parsed.name : null,
		deadlineTime: typeof parsed.deadlineTime === "string" ? parsed.deadlineTime : null,
		deadlineTimeEpoch:
			typeof parsed.deadlineTimeEpoch === "number" ? parsed.deadlineTimeEpoch : null,
		isCurrent,
		isNext,
		finished,
		dataChecked,
	};
};

export const getCurrentEventFromRedis = async (
	context: GraphQLContext
): Promise<CurrentEventCache | null> => {
	try {
		const raw = await context.redis.get(EVENT_CURRENT_KEY);
		const parsed = parseCurrentEvent(raw);
		if (!parsed) {
			if (raw) {
				context.logger.warn({ key: EVENT_CURRENT_KEY }, "event:current payload malformed");
			}
			return null;
		}
		return parsed;
	} catch (err) {
		context.logger.warn({ err, key: EVENT_CURRENT_KEY }, "Failed to read event:current");
		return null;
	}
};

const getCurrentEventFromDatabase = async (
	context: GraphQLContext
): Promise<CurrentEventCache | null> => {
	const { data, error } = await context.supabase
		.from("events")
		.select(
			"id, name, deadline_time, deadline_time_epoch, is_current, is_next, finished, data_checked"
		)
		.eq("is_current", true)
		.order("id", { ascending: false })
		.limit(1);
	if (error) {
		context.logger.error({ err: error }, "Failed to load current event metadata");
		throw new GraphQLError("Current event metadata is unavailable", {
			extensions: {
				code: "CACHE_METADATA_UNAVAILABLE",
				http: { status: 503 },
			},
		});
	}
	const row = data?.[0] as Record<string, unknown> | undefined;
	if (!row || typeof row.id !== "number") return null;
	return {
		id: row.id,
		name: typeof row.name === "string" ? row.name : null,
		deadlineTime: typeof row.deadline_time === "string" ? row.deadline_time : null,
		deadlineTimeEpoch: typeof row.deadline_time_epoch === "number" ? row.deadline_time_epoch : null,
		isCurrent: Boolean(row.is_current),
		isNext: Boolean(row.is_next),
		finished: Boolean(row.finished),
		dataChecked: Boolean(row.data_checked),
	};
};

export const getCurrentEventId = (context: GraphQLContext): Promise<number | null> => {
	const cached = currentEventIdMemo.get(context);
	if (cached) return cached;

	// A GraphQL context is created per operation. Pin the first current-event
	// lookup so sibling live roots cannot straddle a gameweek transition and
	// label event N data with event N+1 snapshot metadata.
	const loading = (async (): Promise<number | null> => {
		const current =
			(await getCurrentEventFromRedis(context)) ?? (await getCurrentEventFromDatabase(context));
		return current?.id ?? null;
	})();
	currentEventIdMemo.set(context, loading);
	return loading;
};
