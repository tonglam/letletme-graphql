import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { MarketPulse, MarketLineup } from "./repository";
import { marketService } from "./service";
import type { MarketSnapshotContext } from "./context";
import type {
	MarketOwnershipDay,
	MarketOwnershipOverview,
	MarketOwnershipPeriod,
} from "./ownership-repository";
import { marketOwnershipService } from "./service";

type MarketPulseArgs = {
	days?: number | null;
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

export const marketResolvers = {
	Query: {
		marketPulse: async (
			_parent: unknown,
			args: MarketPulseArgs,
			context: GraphQLContext
		): Promise<MarketPulse> =>
			marketService.getMarketPulse(context, normalizeMarketPulseDays(args.days)),
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
};
