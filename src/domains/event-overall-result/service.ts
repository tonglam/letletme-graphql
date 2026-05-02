import type { GraphQLContext } from "../../graphql/context";
import type { EventResult } from "./repository";
import { eventOverallResultRepository } from "./repository";

export const eventOverallResultService = {
	async getEventOverallResult(context: GraphQLContext): Promise<EventResult[]> {
		return eventOverallResultRepository.getEventOverallResult(context);
	},
};
