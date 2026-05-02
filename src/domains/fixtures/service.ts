import type { GraphQLContext } from "../../graphql/context";
import type { Fixture, FixturesFilter } from "./repository";
import { fixturesRepository } from "./repository";

export const fixturesService = {
	listFixtures(
		context: GraphQLContext,
		filter: FixturesFilter | null | undefined,
		limit: number,
		offset: number,
	): Promise<Fixture[]> {
		return fixturesRepository.listFixtures(context, filter, limit, offset);
	},

	getEventFixtures(
		context: GraphQLContext,
		eventId: number,
	): Promise<Fixture[]> {
		return fixturesRepository.getEventFixtures(context, eventId);
	},

	getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]> {
		return fixturesRepository.getCurrentFixtures(context);
	},
};
