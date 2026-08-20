export const entriesTypeDefs = /* GraphQL */ `
	enum Chip {
		NONE
		BENCH_BOOST
		FREE_HIT
		TRIPLE_CAPTAIN
		WILDCARD
		MANAGER
	}

	type Entry {
		id: Int!
		entryName: String!
		playerName: String!
		region: String
		startedEvent: Int
		overallPoints: Int
		overallRank: Int
		bank: Int
		teamValue: Int
		totalTransfers: Int
	}

	type EntryEventResult {
		entry: Entry!
		eventId: Int!
		eventPoints: Int!
		eventRank: Int
		overallPoints: Int!
		overallRank: Int!
		eventTransfers: Int!
		eventTransfersCost: Int!
		eventNetPoints: Int!
		eventBenchPoints: Int!
		eventChip: Chip!
		eventPlayedCaptain: Player
		eventCaptainPoints: Int!
		eventPicks: [ElementEventResultData!]!
		eventAutoSub: [ElementEventResultData!]!
		teamValue: Int
		bank: Int
	}

	type EntryHistoryInfo {
		season: String!
		totalPoints: Int!
		overallRank: Int!
	}

	type EntryHistoryPayload {
		results: [EntryEventResult!]!
		history: [EntryHistoryInfo!]!
	}

	type EntryGameweekTransfers {
		eventId: Int!
		eventTransfers: Int!
		eventTransfersCost: Int!
		transfers: [EntryEventTransfersData!]!
	}

	extend type Query {
		"""
		Public entry lookup behind the trusted ingress. Unknown IDs fall back to
		the public FPL entry API so bind/search can preview teams that are not
		yet in competition.entries. A successful fallback also enqueues
		letletme_data entry-info sync when LETLETME_DATA_URL is configured.
		This does not write PostgreSQL, establish an identity binding, or grant
		access to protected entry history.
		"""
		entry(id: Int!): Entry
		"""
		Persisted public entry snapshot for read-only consumers. This resolver
		never calls the public FPL API, enqueues Data work, or writes query caches.
		Unknown IDs return null.
		"""
		entrySnapshot(id: Int!): Entry
		"""
		Fuzzy public lookup of synced FPL entries by team name or manager name.
		Results are bounded and do not grant access to protected entry history.
		"""
		searchEntries(query: String!, limit: Int = 10): [Entry!]!
		entryHistory(entryId: Int!): EntryHistoryPayload!
		entryEventResult(entryId: Int!, eventId: Int!): EntryEventResult
		entryTransferHistory(entryId: Int!, live: Boolean = false): [EntryGameweekTransfers!]!
	}
`;
