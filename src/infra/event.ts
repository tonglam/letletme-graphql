import type { GraphQLContext } from "../graphql/context";
import { getCoreEventSnapshot } from "./data-snapshot";

const currentEventIdMemo = new WeakMap<GraphQLContext, Promise<number | null>>();
const nextEventIdMemo = new WeakMap<GraphQLContext, Promise<number | null>>();

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

export const getCurrentEvent = async (
	context: GraphQLContext
): Promise<CurrentEventCache | null> => {
	const snapshot = await getCoreEventSnapshot(context);
	if (snapshot.currentEventId === null) return null;
	const event = snapshot.events.find((candidate) => candidate.id === snapshot.currentEventId);
	if (!event) return null;
	return {
		id: event.id,
		name: event.name,
		deadlineTime: event.deadlineTime,
		deadlineTimeEpoch: event.deadlineTimeEpoch,
		isCurrent: event.isCurrent,
		isNext: event.isNext,
		finished: event.finished,
		dataChecked: event.dataChecked,
	};
};

export const getCurrentEventId = (context: GraphQLContext): Promise<number | null> => {
	const cached = currentEventIdMemo.get(context);
	if (cached) return cached;
	const loading = getCoreEventSnapshot(context).then((snapshot) => snapshot.currentEventId);
	currentEventIdMemo.set(context, loading);
	return loading;
};

export const getNextEventId = (context: GraphQLContext): Promise<number | null> => {
	const cached = nextEventIdMemo.get(context);
	if (cached) return cached;
	const loading = getCoreEventSnapshot(context).then((snapshot) => {
		const currentEventId = snapshot.currentEventId;
		if (currentEventId !== null) {
			return snapshot.events.find((event) => event.id === currentEventId + 1)?.id ?? null;
		}
		return snapshot.events.find((event) => event.isNext)?.id ?? null;
	});
	nextEventIdMemo.set(context, loading);
	return loading;
};
