export const entryLiveTypeDefs = /* GraphQL */ `
	extend type Query {
		calcLivePointsByEntry(eventId: Int!, entryId: Int!): LiveCalcData!
		calcLivePointsForEntries(eventId: Int!, entryIds: [Int!]!): BatchLiveCalcResult!
	}

	enum EntryLiveAvailability {
		READY
		PENDING
		NO_PICKS
		UNAVAILABLE
	}

	enum LiveDeliveryState {
		FRESH
		STALE
		DEGRADED
		FINAL
		UNAVAILABLE
	}

	enum LiveServedFrom {
		REDIS_CURRENT
		REDIS_PREVIOUS
		PROCESS_LKG
		POSTGRES_CHECKPOINT
		FINAL_RESULT
	}

	enum LiveScoreSource {
		FPL_EVENT_LIVE
		FPL_FINAL_RESULT
		UNAVAILABLE
	}

	enum LiveScoreCalculationMode {
		PROJECTED_AUTOSUBS
		FINAL_RESULT
	}

	enum LiveScoreTotalScope {
		OVERALL
		UNKNOWN
	}

	"""
	All revisions needed to recompute this response without a heartbeat revision.
	"""
	type LiveRevisionVector {
		publicationId: ID!
		generation: Int!
		lifecycle: String!
		fixtureIdentity: String!
		scoreCore: String!
		displayStats: String!
		explain: String!
		picksBase: String
		officialAdjustment: String
		previousTotals: String
		finalResult: String
		rules: String!
		algorithm: String!
		input: String!
	}

	type LiveTimes {
		sourceCheckedAt: DateTime!
		contentUpdatedAt: DateTime!
		publishedAt: DateTime!
		checkpointedAt: DateTime
		servedAt: DateTime!
		staleAt: DateTime!
		nextRefreshAt: DateTime
	}

	type LiveDelivery {
		state: LiveDeliveryState!
		servedFrom: LiveServedFrom!
		reasonCodes: [String!]!
	}

	type LiveScore {
		eventPoints: Int!
		netEventPoints: Int!
		totalPoints: Int
		totalScope: LiveScoreTotalScope!
		transferCost: Int!
		source: LiveScoreSource!
		calculationMode: LiveScoreCalculationMode!
		revisions: LiveRevisionVector!
		times: LiveTimes!
		delivery: LiveDelivery!
	}

	type LiveRank {
		eventRank: Int
		overallRank: Int
		leagueRank: Int
		revision: String
		contentUpdatedAt: DateTime
		state: LiveDeliveryState!
	}

	"""
	Global event publication metadata shared by all entry projections.
	"""
	type LiveSnapshotMeta {
		season: String!
		eventId: Int!
		state: LiveSnapshotState!
		revisions: LiveRevisionVector!
		times: LiveTimes!
		delivery: LiveDelivery!
	}

	type LiveCalcData {
		availability: EntryLiveAvailability!
		delivery: LiveDelivery!
		snapshot: LiveSnapshotMeta!
		score: LiveScore!
		rank: LiveRank
		provisional: Boolean!
		event: Int!
		entry: Int!
		entryName: String!
		playerName: String!
		region: String
		startedEvent: Int!
		value: Float!
		bank: Float!
		teamValue: Float!
		totalTransfers: Int!
		lastValue: Float!
		chip: Chip!
		played: Int!
		toPlay: Int!
		playedCaptain: Int!
		captainName: String!
		pickList: [ElementEventResultData!]!
		transfersList: [EntryEventTransfersData!]!
		activeCaptain: ActiveCaptain!
	}

	type ActiveCaptain {
		id: Int!
		name: String!
		points: Int!
	}

	type ElementEventResultData {
		season: String
		event: Int!
		element: Int!
		code: Int!
		webName: String!
		price: Float!
		elementType: Int!
		elementTypeName: String!
		teamId: Int!
		teamCode: Int!
		teamName: String!
		teamShortName: String!
		againstId: Int!
		againstName: String!
		againstShortName: String!
		wasHome: String!
		score: String!
		position: Int!
		multiplier: Int!
		isCaptain: Boolean!
		isViceCaptain: Boolean!
		isGwStarted: Boolean!
		isGwFinished: Boolean!
		isPlayed: Boolean!
		playStatus: Int!
		minutes: Int!
		goalsScored: Int!
		assists: Int!
		cleanSheets: Int!
		goalsConceded: Int!
		defensiveContribution: Int!
		ownGoals: Int!
		penaltiesSaved: Int!
		penaltiesMissed: Int!
		yellowCards: Int!
		redCards: Int!
		saves: Int!
		bonus: Int!
		bps: Int!
		totalPoints: Int!
		starts: Boolean
		expectedGoals: Float
		expectedAssists: Float
		expectedGoalInvolvements: Float
		expectedGoalsConceded: Float
		inDreamTeam: Boolean
		pickActive: Boolean!
		autoSub: Boolean!
		bgw: Boolean!
		dgw: Boolean!
	}

	type EntryEventTransfersData {
		event: Int!
		entry: Int!
		elementIn: Int!
		elementInWebName: String!
		elementInType: Int!
		elementInTypeName: String!
		elementInTeamId: Int!
		elementInTeamName: String!
		elementInTeamShortName: String!
		elementInCost: Float!
		elementInPoints: Int!
		elementInPlayed: Boolean!
		elementOut: Int!
		elementOutWebName: String!
		elementOutTeamId: Int!
		elementOutTeamName: String!
		elementOutTeamShortName: String!
		elementOutType: Int!
		elementOutTypeName: String!
		elementOutCost: Float!
		elementOutPoints: Int!
		elementOutPlayed: Boolean!
		time: String!
	}

	type BatchLiveCalcResult {
		results: [LiveCalcData!]!
		errors: [EntryCalcError!]!
		meta: BatchCalcMeta!
	}

	type EntryCalcError {
		entryId: Int!
		message: String!
	}

	type BatchCalcMeta {
		eventId: Int!
		totalEntries: Int!
		succeededCount: Int!
		failedCount: Int!
	}
`;
