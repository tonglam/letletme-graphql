import type { GraphQLContext } from "../../graphql/context";
import type {
	BriefingLocale,
	BriefingStoryCard,
	BriefingWeekRead,
} from "../../infra/content-publication";
import { readBriefingWeekForRequest } from "./request-read";

const flattenStories = (read: BriefingWeekRead): BriefingStoryCard[] =>
	read.payload
		? [...read.payload.featured, ...read.payload.sections.flatMap((section) => section.items)]
		: [];

export const briefingService = {
	async getWeek(context: GraphQLContext, locale: BriefingLocale) {
		const read = await readBriefingWeekForRequest(context, locale);
		return {
			state: read.state,
			revision: read.revision,
			publicationId: read.publicationId,
			publishedAt: read.publishedAt,
			sourceCheckedAt: read.sourceCheckedAt,
			staleAt: read.staleAt,
			event: read.payload?.event ?? read.event,
			featured: read.payload?.featured ?? [],
			sections: read.payload?.sections ?? [],
		};
	},
	async getStory(context: GraphQLContext, slug: string, locale: BriefingLocale) {
		const read = await readBriefingWeekForRequest(context, locale);
		if (!read.payload) {
			return {
				state: read.state,
				canonicalSlug: null,
				story: null,
			};
		}
		const story = flattenStories(read).find((item) => item.slug === slug);
		return {
			state: story ? read.state : "REMOVED",
			canonicalSlug: story?.slug ?? null,
			story: story ?? null,
		};
	},
};
