# GraphQL domain manifest

This file is a controlled, generated view of the GraphQL boundary. The
executable source of truth is `src/graphql/domain-manifest.ts`, together with
the root-field authorization and rate-limit registries it validates. Run
`bun run docs:check` after adding a domain or changing a root field.

<!-- BEGIN GENERATED GRAPHQL DOMAIN MANIFEST -->
| Domain | TypeDefs | Resolvers | Root fields | Auth classes | Rate-limit budgets |
| --- | --- | --- | --- | --- | --- |
| foundation | `src/graphql/base-schema.ts` | `src/graphql/base-schema.ts` | _empty, __typename, __schema, __type | public | _empty=0, __typename=0, __schema=0, __type=0 |
| auth | `src/domains/auth/schema.ts` | `src/domains/auth/resolvers.ts` | me | public | me=0 |
| events | `src/domains/events/schema.ts` | `src/domains/events/resolvers.ts` | event, events, currentEventInfo, coreEventContext | public | event=0, events=0, currentEventInfo=1, coreEventContext=0 |
| gameweek | `src/domains/gameweek/schema.ts` | `src/domains/gameweek/resolvers.ts` | gameweekDesk | public | gameweekDesk=5 |
| home | `src/domains/home/schema.ts` | `src/domains/home/resolvers.ts` | homePublicBootstrap, homeGameweek, homePersonalDesk, homeMarketPulse, homeMarketDesk | public, viewerEntry | homePublicBootstrap=5, homeGameweek=5, homePersonalDesk=30, homeMarketPulse=5, homeMarketDesk=5 |
| players | `src/domains/players/schema.ts` | `src/domains/players/resolvers.ts` | player, players, playersForPicker, team, teams, topTransfersIn, topTransfersOut | public | player=0, players=0, playersForPicker=0, team=0, teams=2, topTransfersIn=0, topTransfersOut=0 |
| player-values | `src/domains/player-values/schema.ts` | `src/domains/player-values/resolvers.ts` | playerValues, playerValueHistory | public | playerValues=5, playerValueHistory=5 |
| fixtures | `src/domains/fixtures/schema.ts` | `src/domains/fixtures/resolvers.ts` | fixtures, eventFixtures | public | fixtures=0, eventFixtures=5 |
| live | `src/domains/live/schema.ts` | `src/domains/live/resolvers.ts` | liveScores, playerLive, eventLive, eventLiveExplain, eventLiveExplains, liveSnapshot | public | liveScores=5, playerLive=0, eventLive=5, eventLiveExplain=0, eventLiveExplains=5, liveSnapshot=0 |
| live-desks | `src/domains/live-desks/schema.ts` | `src/domains/live-desks/resolvers.ts` | liveContext, liveMatchdayDesk, liveFixturePlayers, entryLiveCompetitionsDesk, entryLiveCompetitionBoard, tournamentSelectionIndex, tournamentEntrySquads, tournamentLiveParticipants | public, viewerEntryArg, viewerTournamentMember | liveContext=0, liveMatchdayDesk=0, liveFixturePlayers=0, entryLiveCompetitionsDesk=0, entryLiveCompetitionBoard=0, tournamentSelectionIndex=0, tournamentEntrySquads=0, tournamentLiveParticipants=0 |
| mini-program | `src/domains/mini-program/schema.ts` | `src/domains/mini-program/resolvers.ts` | miniProgramNotice | public | miniProgramNotice=1 |
| entry-live | `src/domains/entry-live/schema.ts` | `src/domains/entry-live/resolvers.ts` | entryLive, calcLivePointsByEntry, calcLivePointsForEntries | viewerEntryArg, public, calcOwnEntries | entryLive=0, calcLivePointsByEntry=10, calcLivePointsForEntries=0 |
| market | `src/domains/market/schema.ts` | `src/domains/market/resolvers.ts` | marketPulse, marketAvailabilityPage, marketLineup, marketOwnershipOverview, marketOwnershipDay, marketSnapshotContext | public | marketPulse=10, marketAvailabilityPage=5, marketLineup=0, marketOwnershipOverview=10, marketOwnershipDay=10, marketSnapshotContext=1 |
| price-changes | `src/domains/price-changes/schema.ts` | `src/domains/price-changes/resolvers.ts` | priceChangeBoard, priceChangeLiveCursor, priceChangeLiveBoard | public | priceChangeBoard=10, priceChangeLiveCursor=1, priceChangeLiveBoard=10 |
| my-fpl | `src/domains/my-fpl/schema.ts` | `src/domains/my-fpl/resolvers.ts` | myFplTeamDesk, myFplTeamGameweek, myFplTeamTransfers, myFplCompetitionsDesk, myFplCompetitionBoard, myFplCompetitionSeasonPath, myFplCompetitionSetupStatus | viewerEntry, viewerTournamentMember | myFplTeamDesk=5, myFplTeamGameweek=5, myFplTeamTransfers=5, myFplCompetitionsDesk=10, myFplCompetitionBoard=10, myFplCompetitionSeasonPath=5, myFplCompetitionSetupStatus=5 |
| leagues | `src/domains/leagues/schema.ts` | `src/domains/leagues/resolvers.ts` | entryLeagues, leagueEventResults | viewerEntryArg, leagueMember | entryLeagues=0, leagueEventResults=0 |
| tournaments | `src/domains/tournaments/schema.ts` | `src/domains/tournaments/resolvers.ts` | entryTournaments, entryParticipatingTournaments, manageableTournaments, tournament, managedTournament, tournamentParticipants, tournamentEntryIds, tournamentEventResults, tournamentEntryRankingSummary, tournamentSeasonSnapshot, tournamentBattleGroupResults, entryH2HMatchResults, tournamentOfficialH2H, entryOfficialH2HDesk, tournamentDetailDesk, managedTournamentStatus | viewerEntryArg, verifiedEntryArg, viewerTournamentMember, tournamentAdmin | entryTournaments=0, entryParticipatingTournaments=0, manageableTournaments=0, tournament=0, managedTournament=0, tournamentParticipants=30, tournamentEntryIds=0, tournamentEventResults=30, tournamentEntryRankingSummary=10, tournamentSeasonSnapshot=30, tournamentBattleGroupResults=0, entryH2HMatchResults=0, tournamentOfficialH2H=30, entryOfficialH2HDesk=30, tournamentDetailDesk=30, managedTournamentStatus=2 |
| entries | `src/domains/entries/schema.ts` | `src/domains/entries/resolvers.ts` | entryLookup, entrySnapshot, entryNameUsage, searchEntries, entryHistory, entryEventResult, entryTransferHistory | public, viewerEntryArg | entryLookup=5, entrySnapshot=0, entryNameUsage=5, searchEntries=10, entryHistory=0, entryEventResult=0, entryTransferHistory=0 |
| event-overall-result | `src/domains/event-overall-result/schema.ts` | `src/domains/event-overall-result/resolvers.ts` | eventOverallResult | public | eventOverallResult=5 |
| event-stats | `src/domains/event-stats/schema.ts` | `src/domains/event-stats/resolvers.ts` | tournamentSelectionStats | viewerTournamentMember | tournamentSelectionStats=10 |
| public-league-trends | `src/domains/public-league-trends/schema.ts` | `src/domains/public-league-trends/resolvers.ts` | publicLeagueTrends, publicLeagueSelectionStats | public | publicLeagueTrends=10, publicLeagueSelectionStats=10 |
| trends | `src/domains/trends/schema.ts` | `src/domains/trends/resolvers.ts` | trendCohorts, trendCohortSnapshot | public | trendCohorts=5, trendCohortSnapshot=10 |
| player-detail | `src/domains/player-detail/schema.ts` | `src/domains/player-detail/resolvers.ts` | playerDetail | public | playerDetail=5 |
| player-state | `src/domains/player-state/schema.ts` | `src/domains/player-state/resolvers.ts` | playerStateProfile | public | playerStateProfile=5 |
| player-stats | `src/domains/player-stats/schema.ts` | `src/domains/player-stats/resolvers.ts` | playerStatsBootstrap, playerStatsDesk | public | playerStatsBootstrap=10, playerStatsDesk=5 |
| briefing | `src/domains/briefing/schema.ts` | `src/domains/briefing/resolvers.ts` | briefingWeek, briefingStory | public | briefingWeek=5, briefingStory=5 |
| team-selection | `src/domains/team-selection/schema.ts` | `src/domains/team-selection/resolvers.ts` | teamSelectionDesk | public | teamSelectionDesk=5 |
<!-- END GENERATED GRAPHQL DOMAIN MANIFEST -->
