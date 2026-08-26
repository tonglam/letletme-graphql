import { DateTimeResolver, JSONResolver } from "graphql-scalars";
import type { GraphQLContext } from "../../graphql/context";
import type { CoreEventContext, CurrentEventInfo, Event, EventsFilter } from "./repository";
import { eventsService } from "./service";
import { buildDataCompleteness } from "../../graphql/data-completeness";

type EventArgs = {
	id: number;
};

type EventsArgs = {
	filter?: EventsFilter | null;
	limit?: number | null;
	offset?: number | null;
};

export const eventsResolvers = {
	DateTime: DateTimeResolver,
	JSON: JSONResolver,
	Query: {
		event: async (
			_parent: unknown,
			args: EventArgs,
			context: GraphQLContext
		): Promise<Event | null> => eventsService.getEventById(context, args.id),
		events: async (_parent: unknown, args: EventsArgs, context: GraphQLContext): Promise<Event[]> =>
			eventsService.listEvents(
				context,
				args.filter ?? undefined,
				args.limit ?? 50,
				args.offset ?? 0
			),
		currentEventInfo: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<CurrentEventInfo | null> => eventsService.getCurrentEventInfo(context),
		coreEventContext: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<CoreEventContext> => eventsService.getCoreEventContext(context),
	},
	CoreEventContext: {
		completeness: (parent: CoreEventContext) =>
			buildDataCompleteness({
				contractKey: "core-fixtures",
				scopeKey: `season:${parent.season}`,
				revision: parent.revision,
				sourceCheckedAt: parent.sourceCheckedAt,
				// The core snapshot reader validates the publication manifest before
				// this context is returned, so no second row count is invented here.
				complete: true,
			}),
	},
};
