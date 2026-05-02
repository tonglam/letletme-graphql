import type { GraphQLContext } from "../../graphql/context";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import type { League, LeagueEventResult } from "./repository";
import { LeagueType } from "./repository";
import { leaguesService } from "./service";

const eventsMemo = new WeakMap<GraphQLContext, Map<number, Event | null>>();

const getEventByIdMemoized = async (
	context: GraphQLContext,
	eventId: number,
): Promise<Event | null> => {
	let memo = eventsMemo.get(context);
	if (!memo) {
		memo = new Map();
		eventsMemo.set(context, memo);
	}
	const cached = memo.get(eventId);
	if (cached !== undefined) {
		return cached;
	}
	const event = await eventsService.getEventById(context, eventId);
	memo.set(eventId, event);
	return event;
};

type EntryLeaguesArgs = {
	entryId: number;
};

type LeagueEventResultsArgs = {
	leagueId: number;
	eventId: number;
};

const leagueTypeToEnum = (type: LeagueType): string => {
	return type === LeagueType.H2H ? "H2H" : "CLASSIC";
};

export const leaguesResolvers = {
	Query: {
		entryLeagues: async (
			_parent: unknown,
			args: EntryLeaguesArgs,
			context: GraphQLContext,
		): Promise<League[]> =>
			leaguesService.getEntryLeagues(context, args.entryId),

		leagueEventResults: async (
			_parent: unknown,
			args: LeagueEventResultsArgs,
			context: GraphQLContext,
		): Promise<LeagueEventResult[]> =>
			leaguesService.getLeagueEventResults(
				context,
				args.leagueId,
				args.eventId,
			),
	},
	League: {
		type: (parent: League): string => leagueTypeToEnum(parent.type),
	},
	LeagueEventResult: {
		league: (parent: LeagueEventResult): League => parent.league,
		event: async (
			parent: LeagueEventResult,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
	},
};
