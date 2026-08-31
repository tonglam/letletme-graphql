import type { GraphQLContext } from "../../graphql/context";
import { measureRequestStage } from "../../http/request-timing";
import {
	createMyFplRepository,
	myFplRepository,
	type MyFplRepository,
	type MyFplCompetitionBoardPage,
	type MyFplCompetitionSeasonPath,
	type MyFplCompetitionSetupStatus,
	type MyFplCompetitionsDesk,
	type MyFplTeamDesk,
	type MyFplTeamGameweek,
	type MyFplTeamTransfers,
	type MyFplSnapshotMeta,
} from "./repository";
import { buildDataCompleteness } from "../../graphql/data-completeness";
import {
	myTournamentReviewRepository,
	type MyTournamentGameweekReview,
	type MyTournamentReviewCatalog,
	type MyTournamentReviewRepository,
	type MyTournamentReviewScope,
	type MyTournamentReviewStatus,
	type MyTournamentSeasonReview,
} from "./tournament-review-v2.repository";

type TeamDeskArgs = { eventId?: number | null; snapshotRevision?: string | null };
type TeamGameweekArgs = { eventId: number; snapshotRevision?: string | null };
type CompetitionsDeskArgs = {
	tournamentId?: number | null;
	eventId?: number | null;
	snapshotRevision?: string | null;
};
type CompetitionBoardArgs = {
	tournamentId: number;
	eventId: number;
	page?: number | null;
	pageSize?: number | null;
	search?: string | null;
	snapshotRevision?: string | null;
};
type CompetitionSeasonPathArgs = {
	tournamentId: number;
	throughEventId: number;
	snapshotRevision?: string | null;
};
type CompetitionSetupStatusArgs = { tournamentId: number };
type MyTournamentReviewCatalogArgs = { scope?: MyTournamentReviewScope | null };
type MyTournamentGameweekReviewArgs = {
	tournamentId: number;
	eventId: number;
	first?: number | null;
	after?: string | null;
	revision?: string | null;
};
type MyTournamentSeasonReviewArgs = {
	tournamentId: number;
	throughEventId: number;
	first?: number | null;
	after?: string | null;
};
type MyTournamentReviewStatusArgs = { tournamentId: number };

export const createMyFplResolvers = (
	repository: MyFplRepository = myFplRepository,
	reviewRepository: MyTournamentReviewRepository = myTournamentReviewRepository
) => ({
	Query: {
		myFplTeamDesk: (
			_parent: unknown,
			args: TeamDeskArgs,
			context: GraphQLContext
		): Promise<MyFplTeamDesk> =>
			measureRequestStage(context.requestTiming, "myFplTeamDesk", () =>
				repository.loadTeamDesk(context, args.eventId, args.snapshotRevision)
			),
		myFplTeamGameweek: (
			_parent: unknown,
			args: TeamGameweekArgs,
			context: GraphQLContext
		): Promise<MyFplTeamGameweek> =>
			measureRequestStage(context.requestTiming, "myFplTeamGameweek", () =>
				repository.loadTeamGameweek(context, args.eventId, args.snapshotRevision)
			),
		myFplTeamTransfers: (
			_parent: unknown,
			args: { snapshotRevision?: string | null },
			context: GraphQLContext
		): Promise<MyFplTeamTransfers> =>
			measureRequestStage(context.requestTiming, "myFplTeamTransfers", () =>
				repository.loadTeamTransfers(context, args.snapshotRevision)
			),
		myFplCompetitionsDesk: (
			_parent: unknown,
			args: CompetitionsDeskArgs,
			context: GraphQLContext
		): Promise<MyFplCompetitionsDesk> =>
			measureRequestStage(context.requestTiming, "myFplCompetitionsDesk", () =>
				repository.loadCompetitionsDesk(
					context,
					args.tournamentId,
					args.eventId,
					args.snapshotRevision
				)
			),
		myFplCompetitionBoard: (
			_parent: unknown,
			args: CompetitionBoardArgs,
			context: GraphQLContext
		): Promise<MyFplCompetitionBoardPage> =>
			measureRequestStage(context.requestTiming, "myFplCompetitionBoard", () =>
				repository.loadCompetitionBoard(context, args)
			),
		myFplCompetitionSeasonPath: (
			_parent: unknown,
			args: CompetitionSeasonPathArgs,
			context: GraphQLContext
		): Promise<MyFplCompetitionSeasonPath> =>
			measureRequestStage(context.requestTiming, "myFplCompetitionSeasonPath", () =>
				repository.loadCompetitionSeasonPath(
					context,
					args.tournamentId,
					args.throughEventId,
					args.snapshotRevision
				)
			),
		myFplCompetitionSetupStatus: (
			_parent: unknown,
			args: CompetitionSetupStatusArgs,
			context: GraphQLContext
		): Promise<MyFplCompetitionSetupStatus> =>
			measureRequestStage(context.requestTiming, "myFplCompetitionSetupStatus", () =>
				repository.loadCompetitionSetupStatus(context, args.tournamentId)
			),
		myTournamentReviewCatalog: (
			_parent: unknown,
			args: MyTournamentReviewCatalogArgs,
			context: GraphQLContext
		): Promise<MyTournamentReviewCatalog> =>
			measureRequestStage(context.requestTiming, "myTournamentReviewCatalog", () =>
				reviewRepository.loadCatalog(context, args.scope ?? "ACCESSIBLE")
			),
		myTournamentGameweekReview: (
			_parent: unknown,
			args: MyTournamentGameweekReviewArgs,
			context: GraphQLContext
		): Promise<MyTournamentGameweekReview> =>
			measureRequestStage(context.requestTiming, "myTournamentGameweekReview", () =>
				reviewRepository.loadGameweekReview(context, args)
			),
		myTournamentSeasonReview: (
			_parent: unknown,
			args: MyTournamentSeasonReviewArgs,
			context: GraphQLContext
		): Promise<MyTournamentSeasonReview> =>
			measureRequestStage(context.requestTiming, "myTournamentSeasonReview", () =>
				reviewRepository.loadSeasonReview(context, args)
			),
		myTournamentReviewStatus: (
			_parent: unknown,
			args: MyTournamentReviewStatusArgs,
			context: GraphQLContext
		): Promise<MyTournamentReviewStatus> =>
			measureRequestStage(context.requestTiming, "myTournamentReviewStatus", () =>
				reviewRepository.loadStatus(context, args.tournamentId)
			),
	},
	MyFplSnapshotMeta: {
		completeness: (parent: MyFplSnapshotMeta, _args: unknown, context: GraphQLContext) =>
			buildDataCompleteness({
				contractKey: "my-fpl",
				scopeKey: `season:${context.currentSeason.seasonCode}:event:${parent.eventId}`,
				revision: parent.revision,
				sourceCheckedAt: parent.sourceCheckedAt,
				complete: parent.revision.length > 0 && parent.freshness !== "STALE",
			}),
	},
});

export const myFplResolvers = createMyFplResolvers(createMyFplRepository());
