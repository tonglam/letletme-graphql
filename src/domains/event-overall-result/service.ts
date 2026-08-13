import type { GraphQLContext } from "../../graphql/context";
import type { EventResult } from "./repository";
import { eventOverallResultRepository } from "./repository";

export const eventOverallResultService = {
	async getEventOverallResult(
		context: GraphQLContext,
		eventId?: number | null
	): Promise<EventResult[]> {
		return eventOverallResultRepository.getEventOverallResult(context, eventId);
	},
};
