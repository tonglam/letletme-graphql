export const trendsTypeDefs = /* GraphQL */ `
	enum TrendCohortKind {
		TRACKED_OFFICIAL_COMPETITION
		CUSTOM_COMPETITION
		RANK_SAMPLE
	}
	enum TrendCohortAccess {
		PUBLIC
		MINE
	}
	enum TrendCapability {
		OWNERSHIP
		EFFECTIVE_OWNERSHIP
		CAPTAINCY
		VICE_CAPTAINCY
		TRANSFERS
		SELECTION_CHANGE
		PERSONAL_EXPOSURE
		CHIPS
		FORMATIONS
		TEMPLATE
	}

	type TrendEvidenceContext {
		evidenceClass: String!
		sourceKey: String!
		sourceLabel: String!
		seasonScope: String!
		season: String!
		eventId: Int!
		scopeKind: String!
		scopeKey: String!
		scopeLabel: String!
		observedAt: DateTime
		capturedAt: DateTime
		publishedAt: DateTime
		truthState: String!
		coverageState: String!
		availabilityState: String!
		exact: Boolean!
		targetPopulation: Int
		denominator: Int
		sampleSize: Int
		methodKey: String!
		methodVersion: String!
		limitations: [String!]!
	}

	type TrendCapabilityStatus {
		capability: TrendCapability!
		state: String!
	}

	type TrendCohort {
		id: ID!
		kind: TrendCohortKind!
		access: TrendCohortAccess!
		displayName: String!
		exact: Boolean!
		latestEventId: Int
		revision: String
		availability: String!
		capabilities: [TrendCapabilityStatus!]!
	}

	type TrendCohortCatalogPayload {
		season: String!
		revision: String!
		cohorts: [TrendCohort!]!
	}

	type TrendRow {
		elementId: Int!
		playerName: String!
		playerPosition: Int!
		teamShortName: String!
		count: Int!
		percentage: Float
	}

	type TrendCapabilitySection {
		capability: TrendCapability!
		state: String!
		evidenceContext: TrendEvidenceContext!
		rows: [TrendRow!]
	}

	type TrendCohortSnapshotPayload {
		cohort: TrendCohort!
		eventId: Int!
		sections: [TrendCapabilitySection!]!
	}

	extend type Query {
		trendCohorts(access: TrendCohortAccess!): TrendCohortCatalogPayload!
		trendCohortSnapshot(
			cohortId: ID!
			eventId: Int!
			limit: Int = 12
			access: TrendCohortAccess = PUBLIC
		): TrendCohortSnapshotPayload!
	}
`;
