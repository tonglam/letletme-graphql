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
import { fixturesResolvers } from "../domains/fixtures/resolvers";
import { fixturesTypeDefs } from "../domains/fixtures/schema";
import { leaguesResolvers } from "../domains/leagues/resolvers";
import { leaguesTypeDefs } from "../domains/leagues/schema";
import { liveResolvers } from "../domains/live/resolvers";
import { liveTypeDefs } from "../domains/live/schema";
import { liveMatchesResolvers } from "../domains/live-matches/resolvers";
import { liveMatchesTypeDefs } from "../domains/live-matches/schema";
import { marketResolvers } from "../domains/market/resolvers";
import { marketTypeDefs } from "../domains/market/schema";
import { miniProgramResolvers } from "../domains/mini-program/resolvers";
import { miniProgramTypeDefs } from "../domains/mini-program/schema";
import { playerDetailResolvers } from "../domains/player-detail/resolvers";
import { playerDetailTypeDefs } from "../domains/player-detail/schema";
import { playerValuesResolvers } from "../domains/player-values/resolvers";
import { playerValuesTypeDefs } from "../domains/player-values/schema";
import { playersResolvers } from "../domains/players/resolvers";
import { playersTypeDefs } from "../domains/players/schema";
import { tournamentsResolvers } from "../domains/tournaments/resolvers";
import { tournamentsTypeDefs } from "../domains/tournaments/schema";
import { wechatAuthResolvers } from "../domains/wechat-auth/resolvers";
import { wechatAuthTypeDefs } from "../domains/wechat-auth/schema";
import { baseResolvers, baseTypeDefs } from "./base-schema";

export const schema = makeExecutableSchema({
	typeDefs: [
		baseTypeDefs, // Must be first to define Query and Mutation
		authTypeDefs,
		wechatAuthTypeDefs,
		eventsTypeDefs,
		playersTypeDefs,
		playerValuesTypeDefs,
		fixturesTypeDefs,
		liveTypeDefs,
		miniProgramTypeDefs,
		entryLiveTypeDefs,
		liveMatchesTypeDefs,
		marketTypeDefs,
		leaguesTypeDefs,
		tournamentsTypeDefs,
		entriesTypeDefs,
		eventOverallResultTypeDefs,
		eventStatsTypeDefs,
		playerDetailTypeDefs,
	],
	resolvers: [
		baseResolvers,
		authResolvers,
		wechatAuthResolvers,
		eventsResolvers,
		playersResolvers,
		playerValuesResolvers,
		fixturesResolvers,
		liveResolvers,
		miniProgramResolvers,
		liveMatchesResolvers,
		marketResolvers,
		entryLiveResolvers,
		leaguesResolvers,
		tournamentsResolvers,
		entriesResolvers,
		eventOverallResultResolvers,
		eventStatsResolvers,
		playerDetailResolvers,
	],
});
