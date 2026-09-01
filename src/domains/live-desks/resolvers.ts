import { GraphQLError } from "graphql";

import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	getCoreLiveIdentitySnapshot,
	type CoreEventSnapshot,
	type CoreFixtureSnapshot,
	type CoreLiveIdentitySnapshot,
} from "../../infra/data-snapshot";
import { metrics } from "../../infra/metrics";
import { getPlayerAndTeamMaps, getTournamentSelectionIndexRows } from "../event-stats/repository";
import { Position } from "../players/repository";
import { tournamentsService } from "../tournaments/service";
import {
	calcLivePointsForEntriesV2,
	readLivePublicationByRefV2,
	getLivePointsFreshnessV2,
	readLivePublicationV2,
	type LivePublicationReadV2,
} from "../entry-live/v2-service";
import {
	normalizeEntryLiveCompetitionBoardRequestV2,
	queryEntryLiveCompetitionBoardV2,
	readEntryLiveCompetitionBoardWithPreviousV2,
	type EntryLiveCompetitionBoardRequest,
} from "./v2-board";
import {
	leagueLiveDeliveryV2,
	leagueLiveTimesV2,
	readLeagueLiveHeadV2,
	readLeagueLivePublicationMembershipV2,
	readLeagueLivePublicationPointerV2,
	type LeagueLiveHeadReadV2,
	type LeagueLiveManifestV2,
} from "./league-v2";
import { assertLiveTournamentAccessV2 } from "./access-v2";
import {
	h2hLeagueDeliveryV2,
	h2hLeagueTimesV2,
	readH2HLeagueHeadV2,
	readH2HLeagueMembershipV2,
	type H2HLeagueHeadReadV2,
} from "./h2h-v2";

type LiveRef = { season: string; eventId: number; scoreCoreRevision: string };

const selectionPositionName = (position: number): keyof typeof Position => {
	switch (position) {
		case Position.GOALKEEPER:
			return "GOALKEEPER";
		case Position.DEFENDER:
			return "DEFENDER";
		case Position.FORWARD:
			return "FORWARD";
		default:
			return "MIDFIELDER";
	}
};

const lifecycleForPublication = (
	publication: LivePublicationReadV2["publication"] | null
): string => {
	return publication?.state ?? "PICKS_WAIT";
};

const publicationDeliveryState = (publication: LivePublicationReadV2 | null): string => {
	if (!publication) return "UNAVAILABLE";
	if (publication.publication.state === "FINALIZED") return "FINAL";
	if (publication.servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	return getLivePointsFreshnessV2(publication.publication).isFresh ? "FRESH" : "STALE";
};

const publicationSource = (publication: LivePublicationReadV2 | null): string => {
	if (!publication) return "UNAVAILABLE";
	if (publication.publication.state === "FINALIZED") return "FINAL_RESULT";
	return publication.servedFrom;
};

const windowStateForPublication = (
	publication: LivePublicationReadV2["publication"] | null
): string => {
	switch (publication?.state) {
		case "LIVE_ACTIVE":
			return "LIVE_ACTIVE";
		case "BETWEEN_FIXTURES":
			return "BETWEEN_FIXTURES";
		case "DAY_SETTLING":
			return "DAY_SETTLING";
		case "GW_REVIEW":
			return "GW_REVIEW";
		case "FINALIZED":
			return "FINALIZED";
		default:
			return "PRE_DEADLINE";
	}
};

const publicationAvailability = (publication: LivePublicationReadV2 | null): string =>
	publicationDeliveryState(publication);

const publicationDelivery = (publication: LivePublicationReadV2 | null) => {
	const state = publicationDeliveryState(publication);
	const freshness = publication ? getLivePointsFreshnessV2(publication.publication) : null;
	return {
		state,
		servedFrom: publicationSource(publication),
		reasonCodes:
			state === "UNAVAILABLE"
				? ["PUBLICATION_UNAVAILABLE"]
				: state === "DEGRADED"
					? ["FALLBACK_SERVED"]
					: state === "STALE" && freshness
						? [freshness.reasonCode]
						: [],
	};
};

const publicationRevisionVector = (publication: LivePublicationReadV2 | null) => {
	const unavailable = "unavailable";
	if (!publication) {
		return {
			publicationId: unavailable,
			generation: 0,
			lifecycle: unavailable,
			fixtureIdentity: unavailable,
			scoreCore: unavailable,
			displayStats: unavailable,
			explain: unavailable,
			picksBase: null,
			officialAdjustment: null,
			previousTotals: null,
			finalResult: null,
			rules: unavailable,
			algorithm: "live-points-v2-algorithm-1",
			input: unavailable,
		};
	}
	const value = publication.publication;
	return {
		publicationId: value.publicationId,
		generation: value.generation,
		lifecycle: value.revisions.lifecycle.revision,
		fixtureIdentity: value.revisions.fixtureIdentity.revision,
		scoreCore: value.revisions.scoreCore.revision,
		displayStats: value.revisions.displayStats.revision,
		explain: value.revisions.explain.revision,
		picksBase: null,
		officialAdjustment: null,
		previousTotals: null,
		finalResult: null,
		rules: value.revisions.rules.revision,
		algorithm: "live-points-v2-algorithm-1",
		input: unavailable,
	};
};

const publicationTimes = (publication: LivePublicationReadV2 | null) => {
	const now = new Date().toISOString();
	if (!publication) {
		return {
			sourceCheckedAt: now,
			contentUpdatedAt: now,
			publishedAt: now,
			checkpointedAt: null,
			servedAt: now,
			staleAt: now,
			nextRefreshAt: null,
		};
	}
	const value = publication.publication;
	return {
		sourceCheckedAt: value.sourceCheckedAt,
		contentUpdatedAt: value.revisions.scoreCore.contentUpdatedAt,
		publishedAt: value.publishedAt,
		checkpointedAt: value.checkpointedAt,
		servedAt: now,
		staleAt: getLivePointsFreshnessV2(value).staleAt,
		nextRefreshAt: value.expectedNextCheckAt,
	};
};

type LiveWindowV2 = {
	eventCore: CoreEventSnapshot;
	fixtureCore: CoreFixtureSnapshot;
	core: CoreLiveIdentitySnapshot;
	publication: LivePublicationReadV2 | null;
	eventId: number;
};

const readLiveWindowV2 = async (
	context: GraphQLContext,
	eventId?: number
): Promise<LiveWindowV2> => {
	const [eventCore, fixtureCore, core] = await Promise.all([
		getCoreEventSnapshot(context),
		getCoreFixtureSnapshot(context),
		getCoreLiveIdentitySnapshot(context),
	]);
	const selectedEventId =
		eventId ??
		eventCore.currentEventId ??
		eventCore.events.find((event) => event.isPrevious)?.id ??
		0;
	const publication =
		selectedEventId > 0
			? await readLivePublicationV2(context, selectedEventId).catch((error) => {
					context.logger.warn(
						{ err: error, eventId: selectedEventId },
						"Live Points V2 publication unavailable for desk"
					);
					return null;
				})
			: null;
	return { eventCore, fixtureCore, core, publication, eventId: selectedEventId };
};

const assertRef = (
	context: GraphQLContext,
	ref: LiveRef | null | undefined,
	publication: LivePublicationReadV2 | null
): void => {
	if (!ref) return;
	if (!publication) {
		metrics.livePublicationEventsTotal.labels("publication_unavailable").inc();
		throw new GraphQLError("Live Points V2 publication is unavailable", {
			extensions: { code: "LIVE_POINTS_UNAVAILABLE" },
		});
	}
	if (
		ref.season !== context.currentSeason.seasonCode ||
		ref.eventId !== publication.publication.eventId ||
		ref.scoreCoreRevision !== publication.publication.revisions.scoreCore.revision
	) {
		metrics.livePublicationEventsTotal.labels("revision_gone").inc();
		throw new GraphQLError("Requested live score revision is not the current V2 publication", {
			extensions: { code: "LIVE_SCORE_REVISION_GONE" },
		});
	}
};

const assertMember = async (context: GraphQLContext, tournamentId: number, entryId: number) => {
	const tournament = await tournamentsService.getTournamentForMember(
		context,
		tournamentId,
		entryId
	);
	if (!tournament)
		throw new GraphQLError("Tournament access denied", { extensions: { code: "FORBIDDEN" } });
	return tournament;
};

const leagueRevisionVector = (publication: LeagueLiveManifestV2) => ({
	publicationId: publication.publicationId,
	generation: publication.generation,
	roster: publication.revisions.roster,
	scoreCore: publication.revisions.scoreCore,
	fixtureIdentity: publication.revisions.fixtureIdentity,
	entryInputSet: publication.revisions.entryInputSet,
	identity: publication.revisions.identity,
	officialRank: publication.revisions.officialRank,
	rules: publication.revisions.rules,
	algorithm: publication.revisions.algorithm,
	content: publication.revisions.content,
});

const unavailableLeagueHead = (context: GraphQLContext, eventId: number, tournamentId: number) => {
	return {
		season: context.currentSeason.seasonCode,
		eventId,
		tournamentId,
		mode: "CLASSIC",
		availability: "MISSING",
		contentRevision: null,
		publication: null,
		delivery: { state: "UNAVAILABLE", servedFrom: "UNAVAILABLE", reasonCodes: ["NO_PUBLICATION"] },
		nextRefreshAt: null,
	};
};

const leagueHead = (
	context: GraphQLContext,
	read: LeagueLiveHeadReadV2 | null,
	eventId: number,
	tournamentId: number,
	availability: "READY" | "PENDING" | "MISSING" | "ERROR" = read ? "READY" : "MISSING"
) => {
	if (!read) return unavailableLeagueHead(context, eventId, tournamentId);
	const publication = read.publication;
	return {
		season: context.currentSeason.seasonCode,
		eventId: publication.eventId,
		tournamentId: publication.tournamentId,
		mode: "CLASSIC",
		availability,
		contentRevision: publication.revisions.content,
		publication: {
			revisions: leagueRevisionVector(publication),
			times: leagueLiveTimesV2(publication),
		},
		delivery: leagueLiveDeliveryV2(read),
		nextRefreshAt: publication.times.expectedNextCheckAt,
	};
};

const unavailableH2HHead = (context: GraphQLContext, eventId: number, tournamentId: number) => ({
	season: context.currentSeason.seasonCode,
	eventId,
	tournamentId,
	mode: "H2H",
	availability: "MISSING",
	contentRevision: null,
	publication: null,
	delivery: {
		state: "UNAVAILABLE",
		servedFrom: "UNAVAILABLE",
		reasonCodes: ["NO_PUBLICATION"],
	},
	nextRefreshAt: null,
});

const h2hHead = (
	context: GraphQLContext,
	read: H2HLeagueHeadReadV2 | null,
	eventId: number,
	tournamentId: number,
	availability: "READY" | "PENDING" | "MISSING" | "ERROR" = read ? "READY" : "MISSING"
) => {
	if (!read) return unavailableH2HHead(context, eventId, tournamentId);
	const publication = read.publication;
	return {
		season: context.currentSeason.seasonCode,
		eventId: publication.eventId,
		tournamentId: publication.tournamentId,
		mode: "H2H",
		availability,
		contentRevision: publication.revisions.content,
		publication: {
			revisions: {
				publicationId: publication.publicationId,
				generation: publication.generation,
				roster: publication.revisions.roster,
				scoreCore: publication.revisions.scoreCore,
				fixtureIdentity: publication.revisions.fixtureIdentity,
				entryInputSet: publication.revisions.entryInputSet,
				identity: publication.revisions.identity,
				officialRank: publication.revisions.officialRank,
				rules: publication.revisions.rules,
				algorithm: publication.revisions.algorithm,
				content: publication.revisions.content,
			},
			times: h2hLeagueTimesV2(publication),
		},
		delivery: h2hLeagueDeliveryV2(read),
		nextRefreshAt: publication.times.expectedNextCheckAt,
	};
};

const unavailableBoardResponse = (head: ReturnType<typeof leagueHead>) => ({
	head,
	totalEntries: 0,
	filteredEntries: 0,
	pageInfo: { hasNextPage: false, endCursor: null },
	highestEventPoints: null,
	averageEventPoints: null,
	rows: [],
	viewerRow: null,
});

const boardResponse = async (
	context: GraphQLContext,
	request: EntryLiveCompetitionBoardRequest
) => {
	const scope = {
		season: context.currentSeason.seasonCode,
		eventId: request.eventId,
		tournamentId: request.tournamentId,
		mode: "CLASSIC",
	} as const;
	// Check membership from the immutable roster before loading or projecting
	// the full board.  Unauthorized requests must not be able to trigger the
	// expensive all-entry projection path.
	const membership = await readLeagueLivePublicationMembershipV2(context, scope, request.entryId);
	await assertLiveTournamentAccessV2(context, request.tournamentId, request.entryId, membership);
	const headRead = await readLeagueLiveHeadV2(context, scope);
	const global = headRead
		? await readLivePublicationByRefV2(
				context,
				request.eventId,
				headRead.publication.globalRef
			).catch(() => null)
		: await readLivePublicationV2(context, request.eventId).catch(() => null);
	const fallbackGlobal =
		!global && headRead?.servedFrom === "REDIS_CURRENT"
			? await readLeagueLivePublicationPointerV2(
					context,
					{
						season: context.currentSeason.seasonCode,
						eventId: request.eventId,
						tournamentId: request.tournamentId,
						mode: "CLASSIC",
					},
					"previous"
				)
					.then((previous) =>
						previous
							? readLivePublicationByRefV2(
									context,
									request.eventId,
									previous.publication.globalRef
								).catch(() => null)
							: null
					)
					.catch(() => null)
			: null;
	const servingGlobal = global ?? fallbackGlobal;
	if (!servingGlobal) {
		return unavailableBoardResponse(
			leagueHead(context, headRead, request.eventId, request.tournamentId, "ERROR")
		);
	}
	const board = await readEntryLiveCompetitionBoardWithPreviousV2(
		context,
		{
			season: context.currentSeason.seasonCode,
			eventId: request.eventId,
			tournamentId: request.tournamentId,
			mode: "CLASSIC",
		},
		servingGlobal
	);
	if (!board) {
		return unavailableBoardResponse(
			leagueHead(
				context,
				headRead,
				request.eventId,
				request.tournamentId,
				headRead ? "ERROR" : "MISSING"
			)
		);
	}
	const page = queryEntryLiveCompetitionBoardV2(board, request);
	const read = { publication: board.publication, servedFrom: board.servedFrom };
	return {
		head: leagueHead(context, read, request.eventId, request.tournamentId),
		totalEntries: board.totalEntries,
		filteredEntries: page.filteredEntries,
		pageInfo: page.pageInfo,
		highestEventPoints: board.highestEventPoints,
		averageEventPoints: board.averageEventPoints,
		rows: page.rows,
		viewerRow: page.viewerRow,
	};
};

export const liveDesksResolvers = {
	Query: {
		liveContext: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
			const window = await readLiveWindowV2(context);
			const publication = window.publication;
			return {
				season: context.currentSeason.seasonCode,
				coreRevision: window.eventCore.revision,
				currentEventId: window.eventCore.currentEventId,
				nextEventId: window.eventCore.events.find((event) => event.isNext)?.id ?? null,
				anchorEventId: publication?.publication.eventId ?? window.eventCore.currentEventId,
				latestFinalizedEventId:
					window.eventCore.events
						.filter((event) => event.finished && event.dataChecked)
						.sort((a, b) => b.id - a.id)[0]?.id ?? null,
				scoreCoreRevision: publication?.publication.revisions.scoreCore.revision ?? null,
				state: lifecycleForPublication(publication?.publication ?? null),
				windowState: windowStateForPublication(publication?.publication ?? null),
				producerState: lifecycleForPublication(publication?.publication ?? null),
				anchorMode: publication
					? window.eventCore.currentEventId === publication.publication.eventId
						? "CURRENT"
						: "PREVIOUS_FINAL"
					: window.eventCore.currentEventId === null
						? "OFFSEASON"
						: "UPCOMING",
				dataAvailability: publicationAvailability(publication),
				sourceCheckedAt:
					publication?.publication.sourceCheckedAt ?? window.fixtureCore.sourceCheckedAt,
				publishedAt: publication?.publication.publishedAt ?? window.fixtureCore.sourceCheckedAt,
				source: publicationSource(publication),
				stale:
					publicationDeliveryState(publication) === "STALE" ||
					publicationDeliveryState(publication) === "DEGRADED" ||
					publicationDeliveryState(publication) === "UNAVAILABLE",
				nextRefreshAt: publication?.publication.expectedNextCheckAt ?? null,
				revisions: publicationRevisionVector(publication),
				times: publicationTimes(publication),
				delivery: publicationDelivery(publication),
			};
		},
		leagueLiveHead: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; eventId: number; mode: "CLASSIC" | "H2H" },
			context: GraphQLContext
		) => {
			if (args.mode === "H2H") {
				const read = await readH2HLeagueHeadV2(context, args.tournamentId, args.eventId);
				const membership = await readH2HLeagueMembershipV2(
					context,
					args.tournamentId,
					args.eventId,
					args.entryId
				);
				await assertLiveTournamentAccessV2(context, args.tournamentId, args.entryId, membership);
				return h2hHead(context, read, args.eventId, args.tournamentId);
			}
			const membership = await readLeagueLivePublicationMembershipV2(
				context,
				{
					season: context.currentSeason.seasonCode,
					eventId: args.eventId,
					tournamentId: args.tournamentId,
					mode: "CLASSIC",
				},
				args.entryId
			);
			await assertLiveTournamentAccessV2(context, args.tournamentId, args.entryId, membership);
			const read = await readLeagueLiveHeadV2(context, {
				season: context.currentSeason.seasonCode,
				eventId: args.eventId,
				tournamentId: args.tournamentId,
				mode: "CLASSIC",
			});
			return leagueHead(context, read, args.eventId, args.tournamentId);
		},
		entryLiveCompetitionBoard: async (
			_parent: unknown,
			args: Record<string, unknown>,
			context: GraphQLContext
		) => {
			const request = normalizeEntryLiveCompetitionBoardRequestV2(args);
			return boardResponse(context, request);
		},
		tournamentSelectionIndex: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; ref: LiveRef },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			const publication = await readLivePublicationV2(context, args.ref.eventId).catch(() => null);
			assertRef(context, args.ref, publication);
			if (!publication)
				throw new GraphQLError("Live Points V2 publication is unavailable", {
					extensions: { code: "LIVE_POINTS_UNAVAILABLE" },
				});
			const rows = await getTournamentSelectionIndexRows(
				context,
				args.tournamentId,
				args.ref.eventId
			);
			const eventMaps = await getPlayerAndTeamMaps(
				context,
				rows.map((row) => row.playerId),
				args.ref.eventId,
				context.currentSeason.seasonCode
			);
			if (!eventMaps.eventTeamResolutionComplete)
				throw new Error("Historical player team metadata unavailable for selection index");
			return {
				tournamentId: args.tournamentId,
				eventId: args.ref.eventId,
				scoreCoreRevision: publication.publication.revisions.scoreCore.revision,
				rows: rows.map((row) => {
					const player = eventMaps.playerMap.get(row.playerId);
					const team = player ? eventMaps.teamMap.get(player.team_id) : undefined;
					if (!player || !team)
						throw new Error(`Historical selection metadata unavailable for player ${row.playerId}`);
					return {
						...row,
						playerName: player.web_name,
						teamId: player.team_id,
						teamName: team.name,
						teamShortName: team.short_name,
						position: selectionPositionName(player.type),
					};
				}),
			};
		},
		tournamentEntrySquads: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; comparedEntryIds: number[]; ref: LiveRef },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			const publication = await readLivePublicationV2(context, args.ref.eventId).catch(() => null);
			assertRef(context, args.ref, publication);
			if (!publication)
				throw new GraphQLError("Live Points V2 publication is unavailable", {
					extensions: { code: "LIVE_POINTS_UNAVAILABLE" },
				});
			const ids = [...new Set([args.entryId, ...args.comparedEntryIds])].slice(0, 2);
			const result = await calcLivePointsForEntriesV2(context, args.ref.eventId, ids);
			return {
				tournamentId: args.tournamentId,
				eventId: args.ref.eventId,
				scoreCoreRevision: publication.publication.revisions.scoreCore.revision,
				state: publication.publication.state,
				entries: [...result.results.values()],
			};
		},
		tournamentLiveParticipants: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			return tournamentsService.getTournamentParticipants(context, args.tournamentId);
		},
	},
};
