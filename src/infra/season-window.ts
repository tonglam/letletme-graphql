import type { GraphQLContext } from "../graphql/context";

export type ActiveSeasonDateWindow = {
	fromDate: string;
	untilDate: string;
};

const fallbackWindow = (season: string): ActiveSeasonDateWindow => {
	const startYear = Number.parseInt(season.slice(0, 2), 10) + 2000;
	if (!Number.isInteger(startYear)) {
		return { fromDate: "1970-01-01", untilDate: "9999-12-31" };
	}
	return {
		fromDate: `${startYear}-06-01`,
		untilDate: `${startYear + 1}-09-01`,
	};
};

const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10);

/** Resolve the bounded market/history window for the active FPL season. */
export async function getActiveSeasonDateWindow(
	context: GraphQLContext,
	season: string
): Promise<ActiveSeasonDateWindow> {
	const fallback = fallbackWindow(season);
	try {
		const { data, error } = await context.supabase
			.from("events")
			.select("deadline_time")
			.eq("id", 1)
			.limit(1);
		if (error) {
			context.logger.warn({ err: error, season }, "Failed to resolve active season date window");
			return fallback;
		}
		const rawDeadline = (data?.[0] as { deadline_time?: unknown } | undefined)?.deadline_time;
		if (typeof rawDeadline !== "string" && !(rawDeadline instanceof Date)) return fallback;
		const deadline = rawDeadline instanceof Date ? rawDeadline : new Date(rawDeadline);
		if (Number.isNaN(deadline.getTime())) return fallback;
		const from = new Date(deadline);
		from.setUTCDate(from.getUTCDate() - 60);
		const until = new Date(deadline);
		until.setUTCFullYear(until.getUTCFullYear() + 1);
		return { fromDate: toDateOnly(from), untilDate: toDateOnly(until) };
	} catch (error) {
		context.logger.warn({ err: error, season }, "Failed to resolve active season date window");
		return fallback;
	}
}
