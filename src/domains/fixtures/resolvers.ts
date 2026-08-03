import type { GraphQLContext } from "../../graphql/context";
import { buildTeamMap } from "../../infra/team-map";
import type { Team } from "../../infra/types";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import { withLiveSnapshotConsistency, withLiveSnapshotRoot } from "../live/snapshot-meta";
import type { Fixture, FixturesFilter } from "./repository";
import { fixturesService } from "./service";

const eventsMemo = new WeakMap<GraphQLContext, Map<number, Event | null>>();

const getEventByIdMemoized = async (
	context: GraphQLContext,
	eventId: number
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

const teamsMemo = new WeakMap<GraphQLContext, Map<number, Team>>();

const getTeamById = async (context: GraphQLContext, teamId: number): Promise<Team | null> => {
	let memo = teamsMemo.get(context);
	if (!memo) {
		memo = await buildTeamMap(context);
		teamsMemo.set(context, memo);
	}
	return memo.get(teamId) ?? null;
};

type FixturesArgs = {
	filter?: FixturesFilter | null;
	limit?: number | null;
	offset?: number | null;
};

type EventFixturesArgs = {
	eventId: number;
};

export const fixturesResolvers = {
	Query: {
		fixtures: async (
			_parent: unknown,
			args: FixturesArgs,
			context: GraphQLContext
		): Promise<Fixture[]> =>
			fixturesService.listFixtures(
				context,
				args.filter ?? undefined,
				args.limit ?? 50,
				args.offset ?? 0
			),

		eventFixtures: async (
			_parent: unknown,
			args: EventFixturesArgs,
			context: GraphQLContext
		): Promise<Fixture[]> =>
			withLiveSnapshotRoot(context, () =>
				withLiveSnapshotConsistency(context, args.eventId, () =>
					fixturesService.getEventFixtures(context, args.eventId)
				)
			),
	},
	Fixture: {
		event: async (
			parent: Fixture,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> =>
			parent.eventId ? getEventByIdMemoized(context, parent.eventId) : null,
		homeTeam: async (
			parent: Fixture,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Team | null> => getTeamById(context, parent.teamHId),
		awayTeam: async (
			parent: Fixture,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Team | null> => getTeamById(context, parent.teamAId),
		homeScore: (parent: Fixture): number | null => parent.teamHScore,
		awayScore: (parent: Fixture): number | null => parent.teamAScore,
		homeTeamDifficulty: (parent: Fixture): number | null => parent.teamHDifficulty,
		awayTeamDifficulty: (parent: Fixture): number | null => parent.teamADifficulty,
	},
};
