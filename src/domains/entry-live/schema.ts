export const entryLiveTypeDefs = /* GraphQL */ `
	"""
	Summary of an entry's performance for a single event,
	derived from the same official event-live score authority as the detail desk.
	"""
	type EntryLive {
		entry: Entry!
		event: Event!

		"Raw event result for this entry/event."
		eventPoints: Int!
		eventRank: Int
		overallPoints: Int!
		overallRank: Int!
		eventTransfers: Int!
		eventTransfersCost: Int!
		eventNetPoints: Int!

		"Overall points before this event (from previous event result, if any)."
		previousOverallPoints: Int
		"Overall rank before this event (from previous event result, if any)."
		previousOverallRank: Int

		"""
		Convenience field: previousOverallPoints + eventNetPoints.
		Represents a live-style total assuming this event is still in progress.
		"""
		liveTotalPoints: Int!
		"Traceable official score source, publication revision, and freshness."
		score: LiveManagerScore!
	}

	extend type Query {
		"""
		Aggregated view of an entry's performance for a given event.

		For an active or settling event this query fails closed unless the official
		event-live player publication and all 15 official picks are available.
		"""
		entryLive(entryId: Int!, eventId: Int!): EntryLive

		"""
		Full live calculation for an entry and event.
		This lookup is public behind the trusted ingress for live scoreboards and
		comparison pages; it does not authorize protected entry data.

		This is the GraphQL-native equivalent of the LiveCalcData payload:
		- static data (entry/player/team/fixtures) comes from cached repositories
		- dynamic data (event live points) comes from the revisioned Data manager-score authority
		- player detail is joined only when it matches the authority revision
		"""
		calcLivePointsByEntry(eventId: Int!, entryId: Int!): LiveCalcData!

		"""
		Batch live calculation for multiple entries in a single event.
		Shares revisioned manager scores and player detail data across all entries,
		then returns only rows that reconcile to the same score authority.
		"""
		calcLivePointsForEntries(eventId: Int!, entryIds: [Int!]!): BatchLiveCalcResult!
	}

	type LiveCalcData {
		availability: EntryLiveAvailability!
		provisional: Boolean!
		snapshot: LiveSnapshotMeta
		"Official manager headline with an explicit freshness/source contract."
		score: LiveManagerScore!
		"@deprecated Use score.eventRank or score.leagueRank."
		rank: Int! @deprecated(reason: "Use score.eventRank or score.leagueRank")
		event: Int!
		entry: Int!
		entryName: String!
		playerName: String!
		region: String
		startedEvent: Int!
		overallPoints: Int!
		overallRank: Int!
		value: Float!
		bank: Float!
		teamValue: Float!
		totalTransfers: Int!
		lastOverallPoints: Int!
		lastOverallRank: Int!
		lastValue: Float!
		chip: Chip!
		livePoints: Int! @deprecated(reason: "Use score.eventPoints")
		transferCost: Int!
		liveNetPoints: Int! @deprecated(reason: "Use score.netEventPoints")
		liveTotalPoints: Int! @deprecated(reason: "Use score.totalPoints when totalScope is OVERALL")
		played: Int!
		toPlay: Int!
		playedCaptain: Int!
		captainName: String!
		pickList: [ElementEventResultData!]!
		transfersList: [EntryEventTransfersData!]!
		activeCaptain: ActiveCaptain!
	}

	enum EntryLiveAvailability {
		READY
		NO_PICKS
		LINEUP_UNAVAILABLE
	}

	enum LiveManagerScoreSource {
		FPL_EVENT_LIVE
		FPL_FINAL_RESULT
		UNAVAILABLE
	}

	enum LiveManagerRankSource {
		FPL_ENTRY_SUMMARY
		FPL_CLASSIC_STANDINGS
	}

	enum LiveManagerScoreState {
		FRESH
		STALE
		SETTLING
		FINAL
		UNAVAILABLE
	}

	enum LiveManagerScoreTotalScope {
		OVERALL
		CLASSIC_PHASE
		UNKNOWN
	}

	enum LiveManagerScoreSemantics {
		GROSS
		NET
		ZERO_COST_EQUIVALENT
		UNKNOWN
	}

	enum LiveManagerScoreCalculationMode {
		PROJECTED_AUTOSUBS
		FINAL_RESULT
	}

	enum LiveManagerScoreReconciliation {
		MATCHED
		SOURCE_SKEW
		NOT_COMPARABLE
		NO_LINEUP
	}

	enum LiveManagerScoreReason {
		UPSTREAM_UNAVAILABLE
		UPSTREAM_RATE_LIMITED
		SOURCE_TOO_OLD
		MISSING_SCORE
		MISSING_LINEUP
		UNSUPPORTED_H2H
		SEMANTICS_UNKNOWN
		SOURCE_SKEW
	}

	type LiveManagerScoreProvenance {
		scoreSource: LiveManagerScoreSource!
		calculationMode: LiveManagerScoreCalculationMode!
		algorithmVersion: String
		inputRevision: String!
		scoreRevision: String!
		rankRevision: String
		livePublicationId: String
		liveRevision: String
		liveCheckedAt: DateTime
		picksRevision: String
		picksCheckedAt: DateTime
		previousTotalsRevision: String
		previousTotalsThroughEventId: Int
		resultRevision: String
		resultCheckedAt: DateTime
		dataCheckedAt: DateTime
		rankSource: LiveManagerRankSource
		rankCheckedAt: DateTime
	}

	type LiveManagerScoreEffectiveLineup {
		elementId: Int!
		position: Int!
		sourceMultiplier: Int!
		effectiveMultiplier: Int!
		pickActive: Boolean!
		autoSub: Boolean!
		isCaptain: Boolean!
		isViceCaptain: Boolean!
		captainForScoring: Boolean!
	}

	type LiveManagerScore {
		eventPoints: Int
		netEventPoints: Int
		totalPoints: Int
		totalScope: LiveManagerScoreTotalScope!
		eventRank: Int
		overallRank: Int
		leagueRank: Int
		transferCost: Int!
		source: LiveManagerScoreSource!
		state: LiveManagerScoreState!
		eventPointSemantics: LiveManagerScoreSemantics!
		calculationMode: LiveManagerScoreCalculationMode
		algorithmVersion: String
		provenance: LiveManagerScoreProvenance
		effectiveLineup: [LiveManagerScoreEffectiveLineup!]
		revision: String
		checkedAt: DateTime
		upstreamUpdatedAt: DateTime
		staleAt: DateTime
		nextRefreshAt: DateTime
		reconciliation: LiveManagerScoreReconciliation!
		reasonCodes: [LiveManagerScoreReason!]!
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
