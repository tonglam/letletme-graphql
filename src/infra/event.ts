import type { GraphQLContext } from "../graphql/context";

const EVENT_CURRENT_KEY = "event:current";

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

	const idValue = Number(parsed.id);
	if (!Number.isFinite(idValue) || idValue <= 0) {
		return null;
	}

	return {
		id: idValue,
		name: typeof parsed.name === "string" ? parsed.name : null,
		deadlineTime:
			typeof parsed.deadlineTime === "string" ? parsed.deadlineTime : null,
		deadlineTimeEpoch:
			typeof parsed.deadlineTimeEpoch === "number"
				? parsed.deadlineTimeEpoch
				: null,
		isCurrent: Boolean(parsed.isCurrent),
		isNext: Boolean(parsed.isNext),
		finished: Boolean(parsed.finished),
		dataChecked: Boolean(parsed.dataChecked),
	};
};

export const getCurrentEventFromRedis = async (
	context: GraphQLContext,
): Promise<CurrentEventCache | null> => {
	try {
		const raw = await context.redis.get(EVENT_CURRENT_KEY);
		const parsed = parseCurrentEvent(raw);
		if (!parsed) {
			if (raw) {
				context.logger.warn(
					{ key: EVENT_CURRENT_KEY },
					"event:current payload malformed",
				);
			}
			return null;
		}
		return parsed;
	} catch (err) {
		context.logger.warn(
			{ err, key: EVENT_CURRENT_KEY },
			"Failed to read event:current",
		);
		return null;
	}
};

export const getCurrentEventId = async (
	context: GraphQLContext,
): Promise<number | null> => {
	const current = await getCurrentEventFromRedis(context);
	return current?.id ?? null;
};
