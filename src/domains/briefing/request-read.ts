import type { GraphQLContext } from "../../graphql/context";
import type { BriefingLocale, BriefingWeekRead } from "../../infra/content-publication";
import { briefingRepository } from "./repository";

const briefingWeekMemo = new WeakMap<object, Map<BriefingLocale, Promise<BriefingWeekRead>>>();

export const readBriefingWeekForRequest = (
	context: GraphQLContext,
	locale: BriefingLocale
): Promise<BriefingWeekRead> => {
	const scope = context.requestScope ?? context;
	let byLocale = briefingWeekMemo.get(scope);
	if (!byLocale) {
		byLocale = new Map();
		briefingWeekMemo.set(scope, byLocale);
	}
	let load = byLocale.get(locale);
	if (!load) {
		load = briefingRepository.readWeek(context.database, context.redis, locale);
		byLocale.set(locale, load);
	}
	return load;
};
