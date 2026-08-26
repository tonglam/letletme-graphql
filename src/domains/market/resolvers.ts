import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { MarketAvailabilityPage, MarketPulse, MarketLineup } from "./repository";
import { marketService } from "./service";
import type { MarketSnapshotContext } from "./context";
import type {
	MarketOwnershipDay,
	MarketOwnershipOverview,
	MarketOwnershipPeriod,
} from "./ownership-repository";
import { marketOwnershipService } from "./service";
import { buildDataCompleteness } from "../../graphql/data-completeness";

type MarketPulseArgs = {
	days?: number | null;
};

type MarketAvailabilityPageArgs = {
	days?: number | null;
	limit?: number | null;
	offset?: number | null;
};

type MarketOwnershipOverviewArgs = {
	period: MarketOwnershipPeriod;
	limit?: number | null;
};

type MarketOwnershipDayArgs = {
	date?: Date | null;
	limit?: number | null;
};

export function normalizeMarketPulseDays(days: number | null | undefined): number {
	const normalized = days ?? 7;
	if (!Number.isInteger(normalized) || normalized < 1 || normalized > 30) {
		throw new GraphQLError("days must be an integer between 1 and 30", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
}

export function normalizeMarketOwnershipLimit(limit: number | null | undefined): number {
	const normalized = limit ?? 10;
	if (!Number.isInteger(normalized) || normalized < 1 || normalized > 50) {
		throw new GraphQLError("limit must be an integer between 1 and 50", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
}

export function normalizeMarketAvailabilityLimit(limit: number | null | undefined): number {
	const normalized = limit ?? 20;
	if (!Number.isInteger(normalized) || normalized < 1 || normalized > 20) {
		throw new GraphQLError("limit must be an integer between 1 and 20", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
}

export function normalizeMarketAvailabilityOffset(offset: number | null | undefined): number {
	const normalized = offset ?? 0;
	if (!Number.isInteger(normalized) || normalized < 0 || normalized > 5000) {
		throw new GraphQLError("offset must be an integer between 0 and 5000", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
}

export const marketResolvers = {
	Query: {
		marketPulse: async (
			_parent: unknown,
			args: MarketPulseArgs,
			context: GraphQLContext
		): Promise<MarketPulse> =>
			marketService.getMarketPulse(context, normalizeMarketPulseDays(args.days)),
		marketAvailabilityPage: async (
			_parent: unknown,
			args: MarketAvailabilityPageArgs,
			context: GraphQLContext
		): Promise<MarketAvailabilityPage> =>
			marketService.getMarketAvailabilityPage(
				context,
				normalizeMarketPulseDays(args.days),
				normalizeMarketAvailabilityLimit(args.limit),
				normalizeMarketAvailabilityOffset(args.offset)
			),
		marketLineup: async (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext
		): Promise<MarketLineup | null> => marketService.getMarketLineup(context),
		marketSnapshotContext: async (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext
		): Promise<MarketSnapshotContext> => marketService.getMarketSnapshotContext(context),
		marketOwnershipOverview: async (
			_parent: unknown,
			args: MarketOwnershipOverviewArgs,
			context: GraphQLContext
		): Promise<MarketOwnershipOverview> =>
			marketOwnershipService.getOverview(
				context,
				args.period,
				normalizeMarketOwnershipLimit(args.limit)
			),
		marketOwnershipDay: async (
			_parent: unknown,
			args: MarketOwnershipDayArgs,
			context: GraphQLContext
		): Promise<MarketOwnershipDay> =>
			marketOwnershipService.getDay(
				context,
				args.date ?? null,
				normalizeMarketOwnershipLimit(args.limit)
			),
	},
	MarketPulse: {
		availabilityUpdateCount: (pulse: MarketPulse): number =>
			pulse.availabilityUpdateCount ?? pulse.availabilityUpdates.length,
	},
	MarketSnapshotContext: {
		completeness: (parent: MarketSnapshotContext, _args: unknown, context: GraphQLContext) =>
			buildDataCompleteness({
				contractKey: "market-price",
				scopeKey: `season:${context.currentSeason.seasonCode}:source-day:${parent.snapshotDate}`,
				revision: parent.revision,
				sourceCheckedAt: parent.capturedAt,
				expectedCount: parent.rowCount,
				observedCount: parent.rowCount,
				complete: parent.source === "DATA_PUBLICATION" && parent.rowCount > 0,
			}),
	},
};
