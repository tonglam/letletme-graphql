export const briefingTypeDefs = /* GraphQL */ `
	enum BriefingLocale {
		EN
		ZH_CN
	}
	enum BriefingState {
		READY
		EMPTY
		STALE
		OFFSEASON
		UNAVAILABLE
		REMOVED
	}

	type BriefingEvent {
		seasonCode: String!
		eventId: Int!
		name: String!
		deadlineTime: DateTime!
	}

	type BriefingStoryCard {
		id: ID!
		slug: String!
		storyRevision: Int!
		title: String!
		summary: String!
		sourceName: String
		sourceUrl: String
		sourceCheckedAt: DateTime
		expiresAt: DateTime
	}

	type BriefingSection {
		key: String!
		title: String!
		items: [BriefingStoryCard!]!
	}

	type BriefingWeek {
		state: BriefingState!
		revision: Int
		publicationId: ID
		publishedAt: DateTime
		sourceCheckedAt: DateTime
		staleAt: DateTime
		event: BriefingEvent
		featured: [BriefingStoryCard!]!
		sections: [BriefingSection!]!
	}

	type BriefingStory {
		state: BriefingState!
		canonicalSlug: String
		story: BriefingStoryCard
	}

	extend type Query {
		briefingWeek(locale: BriefingLocale!): BriefingWeek!
		briefingStory(slug: String!, locale: BriefingLocale!): BriefingStory
	}
`;
