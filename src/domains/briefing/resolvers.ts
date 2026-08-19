import { DateTimeResolver } from "graphql-scalars";
import type { GraphQLContext } from "../../graphql/context";
import { type BriefingLocale } from "../../infra/content-publication";
import { briefingService } from "./service";

const locale = (value: "EN" | "ZH_CN"): BriefingLocale => (value === "ZH_CN" ? "zh-CN" : "en");

export const briefingResolvers = {
	DateTime: DateTimeResolver,
	Query: {
		briefingWeek: async (
			_parent: unknown,
			args: { locale: "EN" | "ZH_CN" },
			context: GraphQLContext
		) => briefingService.getWeek(context, locale(args.locale)),
		briefingStory: async (
			_parent: unknown,
			args: { slug: string; locale: "EN" | "ZH_CN" },
			context: GraphQLContext
		) => briefingService.getStory(context, args.slug, locale(args.locale)),
	},
};
