import type { GraphQLContext } from "../../graphql/context";
import { measureRequestStage } from "../../http/request-timing";
import {
	createMyFplRepository,
	myFplRepository,
	type MyFplRepository,
	type MyFplCompetitionSetupStatus,
	type MyFplManagerGameweek,
	type MyFplManagerReview,
	type MyFplSnapshotMeta,
} from "./repository";
import { buildDataCompleteness } from "../../graphql/data-completeness";
import {
	myTournamentReviewRepository,
	type MyTournamentGameweekReview,
	type MyTournamentReviewCatalog,
	type MyTournamentReviewCatalogConnection,
	type MyTournamentReviewRepository,
	type MyTournamentReviewSeasonSection,
	type MyTournamentReviewScope,
	type MyTournamentReviewStatus,
	type MyTournamentSeasonSection,
	type MyTournamentSeasonReview,
} from "./tournament-review-v2.repository";

type ManagerReviewArgs = { snapshotRevision?: string | null };
type ManagerGameweekArgs = { eventId: number; snapshotRevision?: string | null };
type CompetitionSetupStatusArgs = { tournamentId: number };
type MyTournamentReviewCatalogArgs = {
	scope?: MyTournamentReviewScope | null;
	first?: number | null;
	after?: string | null;
	search?: string | null;
};
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
type MyTournamentSeasonReviewSectionArgs = {
	tournamentId: number;
	throughEventId: number;
	phaseId: string;
	section: MyTournamentReviewSeasonSection;
	first?: number | null;
	after?: string | null;
	revision: string;
	semanticSha256: string;
};
type MyTournamentReviewStatusArgs = { tournamentId: number };

type ReviewScopePublic = {
	tournamentId: number;
	eventId: number;
	revision: string;
	format: string;
	state: string;
	settledAt: string;
	publishedAt: string;
	correctedAt: string | null;
	semanticSha256: string;
	rowCount: number;
	expectedSubjectCount: number;
	readySubjectCount: number;
	notApplicableSubjectCount: number;
};

function publicScope(scope: MyTournamentGameweekReview["scope"]): ReviewScopePublic | null {
	if (!scope) return null;
	const freshness = scope.freshness;
	if (!freshness || !scope.contentSha256) return null;
	return {
		tournamentId: scope.tournamentId,
		eventId: scope.eventId,
		revision: scope.revision,
		format: scope.format,
		state: scope.state,
		settledAt: freshness.eventDataCheckedAt,
		publishedAt: freshness.publishedAt,
		correctedAt: scope.correctedAt ?? null,
		semanticSha256: scope.contentSha256,
		rowCount: scope.rowCount,
		expectedSubjectCount: scope.expectedSubjectCount,
		readySubjectCount: scope.readySubjectCount,
		notApplicableSubjectCount: scope.notApplicableSubjectCount,
	};
}

function publicPayload(review: MyTournamentGameweekReview): Record<string, unknown> | null {
	if (review.state !== "READY" || !review.scope) return null;
	if (review.scope.format === "POINTS" && review.points) {
		return { format: "POINTS", points: review.points };
	}
	if (review.scope.format === "H2H" && review.h2h) {
		return { format: "H2H", h2h: review.h2h };
	}
	if (review.scope.format === "KNOCKOUT" && review.knockout) {
		return { format: "KNOCKOUT", knockout: review.knockout };
	}
	return null;
}

function publicCatalog(
	catalog: MyTournamentReviewCatalogConnection | MyTournamentReviewCatalog
): MyTournamentReviewCatalogConnection {
	const connection = "edges" in catalog ? catalog : null;
	const tournaments = catalog.tournaments ?? connection?.edges.map((edge) => edge.node) ?? [];
	const edges =
		connection?.edges && connection.edges.length > 0
			? connection.edges.map((edge) => ({ ...edge, node: publicCatalogNode(edge.node) }))
			: tournaments.map((node) => ({
					cursor: Buffer.from(String(node.tournamentId), "utf8").toString("base64url"),
					node: publicCatalogNode(node),
				}));
	return {
		state: catalog.state,
		asOf: catalog.asOf,
		viewerEntryId: catalog.viewerEntryId,
		adminReadAll: catalog.adminReadAll,
		edges,
		pageInfo: connection?.pageInfo ?? {
			hasNextPage: false,
			endCursor: edges.at(-1)?.cursor ?? null,
		},
		tournaments,
	};
}

function publicCatalogNode(node: MyTournamentReviewCatalogConnection["edges"][number]["node"]) {
	return {
		...node,
		setupStatus: node.setupStatus ?? "unknown",
		previousReadyEventId: node.previousReadyEventId ?? null,
		latestFinalizedScope: node.latestFinalizedScope ?? null,
		phaseSummaries: node.phaseSummaries ?? [],
	};
}

function publicSeason(review: MyTournamentSeasonReview) {
	const finalized = review.finalizedEventIds ?? [];
	const latest = review.latestEventId ?? finalized.at(-1) ?? null;
	const phases = review.phases?.length
		? review.phases
		: review.format
			? [
					{
						phaseId: review.format.toLowerCase(),
						format: review.format,
						startEventId: finalized[0] ?? latest ?? 1,
						endEventId: finalized.at(-1) ?? latest ?? 1,
						state: review.state,
						settledAt: review.freshness?.eventDataCheckedAt ?? null,
						publishedAt: review.freshness?.publishedAt ?? null,
						correctedAt: null,
						revision: review.latestRevision,
						semanticSha256: review.semanticSha256 ?? null,
					},
				]
			: [];
	return {
		state: review.state,
		tournamentId: review.tournamentId,
		throughEventId: review.throughEventId,
		latestFinalizedEventId: latest,
		phases,
	};
}

export const createMyFplResolvers = (
	repository: MyFplRepository = myFplRepository,
	reviewRepository: MyTournamentReviewRepository = myTournamentReviewRepository
) => ({
	Query: {
		myFplManagerReview: (
			_parent: unknown,
			args: ManagerReviewArgs,
			context: GraphQLContext
		): Promise<MyFplManagerReview> =>
			measureRequestStage(context.requestTiming, "myFplManagerReview", () =>
				repository.loadManagerReview(context, args.snapshotRevision)
			),
		myFplManagerGameweek: (
			_parent: unknown,
			args: ManagerGameweekArgs,
			context: GraphQLContext
		): Promise<MyFplManagerGameweek> =>
			measureRequestStage(context.requestTiming, "myFplManagerGameweek", () =>
				repository.loadManagerGameweek(context, args.eventId, args.snapshotRevision)
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
		): Promise<MyTournamentReviewCatalogConnection> =>
			measureRequestStage(context.requestTiming, "myTournamentReviewCatalog", () =>
				reviewRepository.loadCatalog(context, args.scope ?? "ACCESSIBLE", args).then(publicCatalog)
			),
		myTournamentGameweekReview: (
			_parent: unknown,
			args: MyTournamentGameweekReviewArgs,
			context: GraphQLContext
		): Promise<Record<string, unknown>> =>
			measureRequestStage(context.requestTiming, "myTournamentGameweekReview", () =>
				reviewRepository.loadGameweekReview(context, args).then((review) => ({
					state: review.state,
					scope: publicScope(review.scope),
					payload: publicPayload(review),
				}))
			),
		myTournamentSeasonReview: (
			_parent: unknown,
			args: MyTournamentSeasonReviewArgs,
			context: GraphQLContext
		): Promise<Record<string, unknown>> =>
			measureRequestStage(context.requestTiming, "myTournamentSeasonReview", () =>
				reviewRepository.loadSeasonReview(context, args).then(publicSeason)
			),
		myTournamentSeasonReviewSection: (
			_parent: unknown,
			args: MyTournamentSeasonReviewSectionArgs,
			context: GraphQLContext
		): Promise<MyTournamentSeasonSection> =>
			measureRequestStage(context.requestTiming, "myTournamentSeasonReviewSection", () => {
				if (!reviewRepository.loadSeasonReviewSection) {
					throw new Error("Review section reader is unavailable");
				}
				return reviewRepository.loadSeasonReviewSection(context, args);
			}),
		myTournamentReviewStatus: (
			_parent: unknown,
			args: MyTournamentReviewStatusArgs,
			context: GraphQLContext
		): Promise<MyTournamentReviewStatus> =>
			measureRequestStage(context.requestTiming, "myTournamentReviewStatus", () =>
				reviewRepository.loadStatus(context, args.tournamentId)
			),
	},
	MyTournamentGameweekReview: {
		scope: (parent: Record<string, unknown>) => parent.scope ?? null,
		payload: (parent: Record<string, unknown>) => parent.payload ?? null,
	},
	MyTournamentReviewPayload: {
		__resolveType: (value: Record<string, unknown>) => {
			if (value.format === "POINTS") return "MyTournamentReviewPointsPayload";
			if (value.format === "H2H") return "MyTournamentReviewH2HPayload";
			if (value.format === "KNOCKOUT") return "MyTournamentReviewKnockoutPayload";
			return null;
		},
	},
	MyTournamentReviewPointsPayload: {
		format: () => "POINTS",
	},
	MyTournamentReviewH2HPayload: {
		format: () => "H2H",
	},
	MyTournamentReviewKnockoutPayload: {
		format: () => "KNOCKOUT",
	},
	MyFplSnapshotMeta: {
		completeness: (parent: MyFplSnapshotMeta, _args: unknown, context: GraphQLContext) =>
			buildDataCompleteness({
				contractKey: "my-fpl",
				scopeKey: `season:${context.currentSeason.seasonCode}:event:${parent.eventId}`,
				revision: parent.revision,
				sourceCheckedAt: parent.sourceCheckedAt,
				expectedCount: parent.expectedEntryCount,
				observedCount: parent.observedEntryCount,
				complete: parent.revision.length > 0 && parent.coverageState === "COMPLETE",
			}),
	},
});

export const myFplResolvers = createMyFplResolvers(createMyFplRepository());
