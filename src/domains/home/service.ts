import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { CoreEventContext } from "../events/repository";
import { eventsService } from "../events/service";
import type { Fixture } from "../fixtures/repository";
import { fixturesService } from "../fixtures/service";
import { homeRepository, type HomePersonalDesk } from "./repository";
import { marketService } from "../market/service";
import type { MarketAvailabilityUpdate, MarketPulse } from "../market/repository";

export type HomePublicBootstrap = {
	context: CoreEventContext;
	fixtures: Fixture[];
};

export type HomeMarketPulse = Pick<
	MarketPulse,
	"coverage" | "mostSelected" | "ownershipMovers" | "availabilityUpdates" | "priceChanges"
>;

const HOME_MARKET_LIMIT = 5;
const HOME_MARKET_MIN_OWNERSHIP = 1;

const selectHomeAvailability = (
	updates: readonly MarketAvailabilityUpdate[]
): MarketAvailabilityUpdate[] => {
	const preferred = updates.filter(
		(update) => update.player.selectedByPercent >= HOME_MARKET_MIN_OWNERSHIP
	);
	if (preferred.length >= HOME_MARKET_LIMIT) {
		return preferred.slice(0, HOME_MARKET_LIMIT);
	}
	const preferredSet = new Set(preferred);
	return [...preferred, ...updates.filter((update) => !preferredSet.has(update))].slice(
		0,
		HOME_MARKET_LIMIT
	);
};

export const compactHomeMarketPulse = (pulse: MarketPulse): HomeMarketPulse => ({
	coverage: pulse.coverage,
	mostSelected: pulse.mostSelected.slice(0, HOME_MARKET_LIMIT),
	ownershipMovers: {
		risers: pulse.ownershipMovers.risers.slice(0, HOME_MARKET_LIMIT),
		fallers: pulse.ownershipMovers.fallers.slice(0, HOME_MARKET_LIMIT),
	},
	availabilityUpdates: selectHomeAvailability(pulse.availabilityUpdates),
	priceChanges: pulse.priceChanges.slice(0, HOME_MARKET_LIMIT),
});

const authError = (
	message: string,
	code: "UNAUTHENTICATED" | "FORBIDDEN",
	status: 401 | 403
): GraphQLError => new GraphQLError(message, { extensions: { code, http: { status } } });

export const homeService = {
	async getMarketPulse(context: GraphQLContext, days: number): Promise<HomeMarketPulse> {
		const startedAt = performance.now();
		const pulse = await marketService.getMarketPulse(context, days);
		const compact = compactHomeMarketPulse(pulse);
		context.logger.info(
			{
				requestId: context.requestId,
				operationName: context.operationName,
				mostSelectedRows: compact.mostSelected.length,
				ownershipRows:
					compact.ownershipMovers.risers.length + compact.ownershipMovers.fallers.length,
				availabilityRows: compact.availabilityUpdates.length,
				priceRows: compact.priceChanges.length,
				totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
			},
			"Home market pulse loaded"
		);
		return compact;
	},

	async getPublicBootstrap(context: GraphQLContext): Promise<HomePublicBootstrap> {
		const startedAt = performance.now();
		const eventContextStartedAt = performance.now();
		const eventContext = await eventsService.getCoreEventContext(context);
		const eventContextDurationMs = performance.now() - eventContextStartedAt;
		const fixturesStartedAt = performance.now();
		const fixtures = eventContext.nextEventId
			? await fixturesService.getEventFixtures(context, eventContext.nextEventId)
			: [];
		const fixturesDurationMs = performance.now() - fixturesStartedAt;
		context.logger.info(
			{
				requestId: context.requestId,
				operationName: context.operationName,
				coreRevision: eventContext.revision,
				eventContextDurationMs: Number(eventContextDurationMs.toFixed(2)),
				fixturesDurationMs: Number(fixturesDurationMs.toFixed(2)),
				fixtureCount: fixtures.length,
				totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
			},
			"Home public bootstrap loaded"
		);
		return { context: eventContext, fixtures };
	},

	getPersonalDesk(context: GraphQLContext): Promise<HomePersonalDesk> {
		if (!context.principal) {
			throw authError("Authentication required", "UNAUTHENTICATED", 401);
		}
		if (!context.principal.fplEntryId || !context.principal.fplEntryVerifiedAt) {
			throw authError("A verified FPL binding is required", "FORBIDDEN", 403);
		}
		return homeRepository.getPersonalDesk(context, context.principal.fplEntryId);
	},
};
