import { makeExecutableSchema } from "@graphql-tools/schema";
import { authResolvers } from "../domains/auth/resolvers";
import { authTypeDefs } from "../domains/auth/schema";
import { entriesResolvers } from "../domains/entries/resolvers";
import { entriesTypeDefs } from "../domains/entries/schema";
import { entryLiveResolvers } from "../domains/entry-live/resolvers";
import { entryLiveTypeDefs } from "../domains/entry-live/schema";
import { eventOverallResultResolvers } from "../domains/event-overall-result/resolvers";
import { eventOverallResultTypeDefs } from "../domains/event-overall-result/schema";
import { eventStatsResolvers } from "../domains/event-stats/resolvers";
import { eventStatsTypeDefs } from "../domains/event-stats/schema";
import { eventsResolvers } from "../domains/events/resolvers";
import { eventsTypeDefs } from "../domains/events/schema";
import { gameweekResolvers } from "../domains/gameweek/resolvers";
import { gameweekTypeDefs } from "../domains/gameweek/schema";
import { homeResolvers } from "../domains/home/resolvers";
import { homeTypeDefs } from "../domains/home/schema";
import { fixturesResolvers } from "../domains/fixtures/resolvers";
import { fixturesTypeDefs } from "../domains/fixtures/schema";
import { leaguesResolvers } from "../domains/leagues/resolvers";
import { leaguesTypeDefs } from "../domains/leagues/schema";
import { liveResolvers } from "../domains/live/resolvers";
import { liveTypeDefs } from "../domains/live/schema";
import { liveDesksResolvers } from "../domains/live-desks/resolvers";
import { liveDesksTypeDefs } from "../domains/live-desks/schema";
import { marketResolvers } from "../domains/market/resolvers";
import { marketTypeDefs } from "../domains/market/schema";
import { myFplResolvers } from "../domains/my-fpl/resolvers";
import { myFplTypeDefs } from "../domains/my-fpl/schema";
import { miniProgramResolvers } from "../domains/mini-program/resolvers";
import { miniProgramTypeDefs } from "../domains/mini-program/schema";
import { playerDetailResolvers } from "../domains/player-detail/resolvers";
import { playerDetailTypeDefs } from "../domains/player-detail/schema";
import { playerStateResolvers } from "../domains/player-state/resolvers";
import { playerStateTypeDefs } from "../domains/player-state/schema";
import { playerStatsResolvers } from "../domains/player-stats/resolvers";
import { playerStatsTypeDefs } from "../domains/player-stats/schema";
import { playerValuesResolvers } from "../domains/player-values/resolvers";
import { playerValuesTypeDefs } from "../domains/player-values/schema";
import { publicLeagueTrendsResolvers } from "../domains/public-league-trends/resolvers";
import { publicLeagueTrendsTypeDefs } from "../domains/public-league-trends/schema";
import { trendsResolvers } from "../domains/trends/resolvers";
import { trendsTypeDefs } from "../domains/trends/schema";
import { playersResolvers } from "../domains/players/resolvers";
import { playersTypeDefs } from "../domains/players/schema";
import { tournamentsResolvers } from "../domains/tournaments/resolvers";
import { tournamentsTypeDefs } from "../domains/tournaments/schema";
import { baseResolvers, baseTypeDefs } from "./base-schema";

export const schema = makeExecutableSchema({
	typeDefs: [
		baseTypeDefs, // Must be first to define Query
		authTypeDefs,
		eventsTypeDefs,
		gameweekTypeDefs,
		homeTypeDefs,
		playersTypeDefs,
		playerValuesTypeDefs,
		fixturesTypeDefs,
		liveTypeDefs,
		liveDesksTypeDefs,
		miniProgramTypeDefs,
		entryLiveTypeDefs,
		marketTypeDefs,
		myFplTypeDefs,
		leaguesTypeDefs,
		tournamentsTypeDefs,
		entriesTypeDefs,
		eventOverallResultTypeDefs,
		eventStatsTypeDefs,
		publicLeagueTrendsTypeDefs,
		trendsTypeDefs,
		playerDetailTypeDefs,
		playerStateTypeDefs,
		playerStatsTypeDefs,
	],
	resolvers: [
		baseResolvers,
		authResolvers,
		eventsResolvers,
		gameweekResolvers,
		homeResolvers,
		playersResolvers,
		playerValuesResolvers,
		fixturesResolvers,
		liveResolvers,
		liveDesksResolvers,
		miniProgramResolvers,
		marketResolvers,
		myFplResolvers,
		entryLiveResolvers,
		leaguesResolvers,
		tournamentsResolvers,
		entriesResolvers,
		eventOverallResultResolvers,
		eventStatsResolvers,
		publicLeagueTrendsResolvers,
		trendsResolvers,
		playerDetailResolvers,
		playerStateResolvers,
		playerStatsResolvers,
	],
});
