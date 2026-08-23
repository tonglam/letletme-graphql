import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	getCoreDataSnapshot,
	getCoreLiveIdentitySnapshot,
	getLiveLifecycleStatus,
	getLiveDataPublicationManifestWithSource,
	getLiveDataSnapshot,
	type CoreEventSnapshot,
	type CoreFixtureSnapshot,
	type CoreLiveIdentitySnapshot,
	type LiveDataSnapshot,
} from "../../infra/data-snapshot";
import type { DataPublicationManifest } from "../../infra/data-publication";
import { entryLiveBatchService } from "../entry-live/batch-service";
import {
	loadManagerScores,
	managerScoreBoardIsFinal,
	rankTournamentRowsByOfficialEventPoints,
} from "../entry-live/manager-score";
import {
	getEventScopedPlayerAndTeamMaps,
	getTournamentSelectionIndexRows,
} from "../event-stats/repository";
import { LeagueType } from "../leagues/repository";
import { tournamentsService } from "../tournaments/service";
import {
	competitionBoardCacheKey,
	readCompetitionBoardCache,
	writeCompetitionBoardCache,
} from "./competition-board-cache";
import {
	buildEntryLiveCompetitionBoard,
	entryLiveCompetitionRosterRevision,
	entryLiveCompetitionBoardCacheKey,
	getOrBuildEntryLiveCompetitionBoard,
	normalizeEntryLiveCompetitionBoardRequest,
	queryEntryLiveCompetitionBoard,
} from "./entry-live-competition-board";
import {
	normalizeTournamentRosterEntryIds,
	selectTournamentComparisonEntryIds,
	selectTournamentDeskEntryWindow,
} from "./tournament-entry-window";
import { resolveLiveWindow, type LiveWindow } from "./window";

type LiveRef = { season: string; eventId: number; revision: string };

const manifestSourceCheckedAt = (
	manifest: DataPublicationManifest | null,
	fallback: string | null = null
): string | null => manifest?.lastSuccessfulFetchAt ?? manifest?.sourceCheckedAt ?? fallback;

const mergeLiveSnapshotFixtures = (
	fixtures: CoreFixtureSnapshot["fixtures"],
	snapshot: Pick<LiveDataSnapshot, "eventId" | "fixtures"> | null
): CoreFixtureSnapshot["fixtures"] => {
	if (!snapshot) return fixtures;
	return [
		...fixtures.filter((fixture) => fixture.eventId !== snapshot.eventId),
		...snapshot.fixtures,
	];
};

const compatibilityState = (
	window: LiveWindow
): "LIVE_ACTIVE" | "GW_REVIEW" | "FINALIZED" | "SCHEDULED" => {
	switch (window.windowState) {
		case "LIVE_ACTIVE":
		case "DAY_SETTLING":
		case "BETWEEN_FIXTURES":
			return "LIVE_ACTIVE";
		case "GW_REVIEW":
			return "GW_REVIEW";
		case "FINALIZED":
		case "BETWEEN_GAMEWEEKS":
		case "OFFSEASON":
			return "FINALIZED";
		default:
			return "SCHEDULED";
	}
};

const snapshotStateForWindow = (window: LiveWindow): "SCHEDULED" | "LIVE" | "SETTLED" => {
	if (window.windowState === "PRESEASON" || window.windowState === "EVENT_SCHEDULED")
		return "SCHEDULED";
	if (
		window.windowState === "FINALIZED" ||
		window.windowState === "BETWEEN_GAMEWEEKS" ||
		window.windowState === "OFFSEASON"
	)
		return "SETTLED";
	return "LIVE";
};

const livePublicationState = (
	manifest: DataPublicationManifest | null
): "scheduled" | "live" | "settled" | null =>
	manifest && manifest.state !== "active" ? manifest.state : null;

const readLiveWindow = async (context: GraphQLContext) => {
	const [eventCore, fixtureCore] = await Promise.all([
		getCoreEventSnapshot(context),
		getCoreFixtureSnapshot(context),
	]);
	const currentEventId = eventCore.currentEventId;
	const [currentPublication, currentLifecycle, currentSnapshot] = currentEventId
		? await Promise.all([
				getLiveDataPublicationManifestWithSource(context, currentEventId).catch(() => null),
				getLiveLifecycleStatus(context, currentEventId),
				getLiveDataSnapshot(context, currentEventId).catch(() => null),
			])
		: [null, null, null];
	const currentManifest = currentPublication?.manifest ?? null;
	const currentFixtures = mergeLiveSnapshotFixtures(fixtureCore.fixtures, currentSnapshot);
	const initialWindow = resolveLiveWindow({
		events: eventCore.events,
		fixtures: currentFixtures,
		currentEventId,
		nextEventId: eventCore.events.find((event) => event.isNext)?.id ?? null,
		liveRevision:
			currentSnapshot?.revision ?? (currentManifest ? String(currentManifest.revision) : null),
		publicationId: currentSnapshot?.publicationId ?? currentManifest?.publicationId ?? null,
		liveEventId: currentSnapshot?.eventId ?? (currentManifest ? currentEventId : null),
		publicationState: currentSnapshot?.state ?? livePublicationState(currentManifest),
		sourceCheckedAt:
			currentSnapshot?.lastSuccessfulFetchAt ??
			manifestSourceCheckedAt(currentManifest, fixtureCore.sourceCheckedAt),
		publishedAt:
			currentSnapshot?.publishedAt ?? currentManifest?.publishedAt ?? fixtureCore.sourceCheckedAt,
		source: currentPublication?.source ?? fixtureCore.source,
		lifecycleEventId: currentLifecycle?.eventId ?? null,
		lifecycleState: currentLifecycle?.state ?? null,
		lifecycleObservedAt: currentLifecycle?.observedAt ?? null,
		lifecycleNextRefreshAt: currentLifecycle?.nextRefreshAt ?? null,
		lifecycleLiveRevision: currentLifecycle?.liveRevision ?? null,
		lifecyclePublicationId: currentLifecycle?.publicationId ?? null,
		lifecycleSourceCheckedAt: currentLifecycle?.sourceCheckedAt ?? null,
	});
	const anchorLifecycle =
		initialWindow.anchorEventId === currentEventId
			? currentLifecycle
			: initialWindow.anchorEventId
				? await getLiveLifecycleStatus(context, initialWindow.anchorEventId)
				: null;
	const anchorPublication =
		initialWindow.anchorEventId && initialWindow.anchorEventId !== currentEventId
			? await getLiveDataPublicationManifestWithSource(context, initialWindow.anchorEventId).catch(
					() => null
				)
			: currentPublication;
	const anchorManifest = anchorPublication?.manifest ?? null;
	const anchorSnapshot =
		currentSnapshot?.eventId === initialWindow.anchorEventId ? currentSnapshot : null;
	const window = anchorManifest
		? resolveLiveWindow({
				events: eventCore.events,
				fixtures: mergeLiveSnapshotFixtures(fixtureCore.fixtures, anchorSnapshot),
				currentEventId,
				nextEventId: initialWindow.nextEventId,
				liveRevision: anchorSnapshot?.revision ?? String(anchorManifest.revision),
				publicationId: anchorSnapshot?.publicationId ?? anchorManifest.publicationId,
				liveEventId: anchorSnapshot?.eventId ?? initialWindow.anchorEventId,
				publicationState: anchorSnapshot?.state ?? livePublicationState(anchorManifest),
				sourceCheckedAt:
					anchorSnapshot?.lastSuccessfulFetchAt ??
					manifestSourceCheckedAt(anchorManifest, fixtureCore.sourceCheckedAt),
				publishedAt: anchorSnapshot?.publishedAt ?? anchorManifest.publishedAt,
				source: anchorPublication?.source ?? fixtureCore.source,
				lifecycleEventId: anchorLifecycle?.eventId ?? null,
				lifecycleState: anchorLifecycle?.state ?? null,
				lifecycleObservedAt: anchorLifecycle?.observedAt ?? null,
				lifecycleNextRefreshAt: anchorLifecycle?.nextRefreshAt ?? null,
				lifecycleLiveRevision: anchorLifecycle?.liveRevision ?? null,
				lifecyclePublicationId: anchorLifecycle?.publicationId ?? null,
				lifecycleSourceCheckedAt: anchorLifecycle?.sourceCheckedAt ?? null,
			})
		: initialWindow;
	return {
		eventCore,
		fixtureCore,
		window,
		manifest: anchorManifest,
		publicationSource: anchorPublication?.source ?? null,
		lifecycleStatus: anchorLifecycle,
	};
};

const resolveSnapshot = async (
	context: GraphQLContext,
	ref?: LiveRef | null
): Promise<{ snapshot: LiveDataSnapshot; core: CoreLiveIdentitySnapshot }> => {
	if (ref && ref.season !== context.currentSeason.seasonCode) {
		throw new GraphQLError("Live revision belongs to another season", {
			extensions: { code: "LIVE_REVISION_GONE" },
		});
	}
	const snapshot = await getLiveDataSnapshot(
		context,
		ref?.eventId ?? (await getCoreEventSnapshot(context)).currentEventId ?? 0
	).catch((error) => {
		throw new GraphQLError("Live publication is unavailable", {
			extensions: { code: "LIVE_PUBLICATION_UNAVAILABLE", cause: error },
		});
	});
	if (ref && snapshot.revision !== ref.revision) {
		throw new GraphQLError("Requested live revision has expired", {
			extensions: { code: "LIVE_REVISION_GONE" },
		});
	}
	const core = await getCoreLiveIdentitySnapshot(context);
	return { snapshot, core };
};

const teamName = (core: Pick<CoreLiveIdentitySnapshot, "teams">, id: number): string =>
	core.teams.find((team) => team.id === id)?.name ?? "";

const teamShortName = (core: Pick<CoreLiveIdentitySnapshot, "teams">, id: number): string =>
	core.teams.find((team) => team.id === id)?.shortName ?? "";

const nextEventAfter = (eventCore: CoreEventSnapshot, eventId: number): number | null =>
	eventCore.events
		.filter((event) => event.id > eventId)
		.sort((left, right) => left.id - right.id)[0]?.id ?? null;

const matchRows = (
	eventId: number,
	fixtures: LiveDataSnapshot["fixtures"],
	core: Pick<CoreLiveIdentitySnapshot, "teams">
) =>
	fixtures.map((fixture) => ({
		fixtureId: fixture.id,
		eventId,
		homeTeamId: fixture.teamHId,
		homeTeamName: teamName(core, fixture.teamHId),
		homeTeamShortName: teamShortName(core, fixture.teamHId),
		awayTeamId: fixture.teamAId,
		awayTeamName: teamName(core, fixture.teamAId),
		awayTeamShortName: teamShortName(core, fixture.teamAId),
		homeScore: fixture.teamHScore,
		awayScore: fixture.teamAScore,
		kickoffTime: fixture.kickoffTime,
		minutes: fixture.minutes,
		started: fixture.started === true,
		// `finishedProvisional` is an upstream staging signal, not the
		// authoritative FPL `finished` flag exposed by this contract.
		finished: fixture.finished,
		finishedProvisional: fixture.finishedProvisional,
	}));

const scheduledMatchdayDesk = (
	eventCore: CoreEventSnapshot,
	fixtureCore: CoreFixtureSnapshot,
	eventId: number,
	manifest: DataPublicationManifest | null,
	publicationSource: "redis" | "postgres" | null,
	window: LiveWindow
) => {
	const nextEventId = nextEventAfter(eventCore, eventId);
	return {
		season: fixtureCore.seasonCode,
		eventId,
		revision: manifest ? String(manifest.revision) : `scheduled-core-${fixtureCore.revision}`,
		state: snapshotStateForWindow(window),
		windowState: window.windowState,
		dataAvailability: window.dataAvailability,
		liveRevision: window.liveRevision,
		sourceCheckedAt: window.sourceCheckedAt ?? fixtureCore.sourceCheckedAt,
		// Keep the non-null GraphQL contract without pretending that core data is
		// a live publication. This timestamp is only used for freshness display.
		publishedAt: manifest?.publishedAt ?? fixtureCore.sourceCheckedAt,
		source: manifest ? publicationSource?.toUpperCase() : "CORE",
		stale: window.stale,
		nextRefreshAt: window.nextRefreshAt,
		matches: matchRows(
			eventId,
			fixtureCore.fixtures.filter((fixture) => fixture.eventId === eventId),
			fixtureCore
		),
		nextFixtures: nextEventId
			? matchRows(
					nextEventId,
					fixtureCore.fixtures.filter((fixture) => fixture.eventId === nextEventId),
					fixtureCore
				)
			: [],
		highlights: [],
	};
};

const assertMember = async (context: GraphQLContext, tournamentId: number, entryId: number) => {
	const tournament = await tournamentsService.getTournamentForMember(
		context,
		tournamentId,
		entryId
	);
	if (!tournament) {
		throw new GraphQLError("Tournament access denied", { extensions: { code: "FORBIDDEN" } });
	}
	return tournament;
};

const usesPlatformAdminTournamentBypass = (context: GraphQLContext, entryId: number): boolean =>
	context.principal?.source === "website" &&
	context.principal.platformAdmin === true &&
	context.principal.fplEntryId === entryId &&
	Boolean(context.principal.fplEntryVerifiedAt);

const managerBoardMeta = (
	board: Array<{
		entry: number;
		score?: {
			eventPoints?: number | null;
			netEventPoints?: number | null;
			eventPointSemantics?: string;
			source?: string;
			revision?: string | null;
		};
	}>,
	options: { requireNet?: boolean; totalEntries?: number } = {}
) => {
	const isOfficialSource = (source?: string): boolean =>
		source === "FPL_ENTRY_SUMMARY" ||
		source === "FPL_CLASSIC_STANDINGS" ||
		source === "FPL_FINAL_RESULT";
	const hasOfficialMetric = (score?: (typeof board)[number]["score"]): boolean =>
		isOfficialSource(score?.source) &&
		(options.requireNet
			? typeof score?.netEventPoints === "number" && score.eventPointSemantics !== "UNKNOWN"
			: typeof score?.eventPoints === "number");
	const unavailableEntryIds = board
		.filter((row) => row.score?.source === "UNAVAILABLE" || !hasOfficialMetric(row.score))
		.map((row) => row.entry);
	const officialRows = board.filter((row) => hasOfficialMetric(row.score));
	const revisions = board
		.map((row) => (row.score?.revision ? `${row.entry}:${row.score.revision}` : null))
		.filter((revision): revision is string => Boolean(revision))
		.sort();
	const managerRevision =
		revisions.length > 0
			? createHash("sha256").update(revisions.join("|"), "utf8").digest("hex").slice(0, 16)
			: null;
	return {
		managerRevision,
		officialCoverage:
			(options.totalEntries ?? board.length) === 0
				? 0
				: officialRows.length / (options.totalEntries ?? board.length),
		unavailableEntryIds,
	};
};

const managerLoadRevision = (input: {
	managerRevision: string | null;
	rows: ReadonlyMap<number, { revision: string }>;
	missingEntryIds: readonly number[];
}): string | null => {
	if (input.managerRevision) return input.managerRevision;
	if (input.rows.size === 0 && input.missingEntryIds.length === 0) return null;
	return createHash("sha256")
		.update(
			JSON.stringify({
				rows: Array.from(input.rows, ([entryId, row]) => [entryId, row.revision]).sort(
					(left, right) => Number(left[0]) - Number(right[0])
				),
				missingEntryIds: [...input.missingEntryIds].sort((left, right) => left - right),
			})
		)
		.digest("hex")
		.slice(0, 20);
};

export const liveDesksResolvers = {
	Query: {
		liveContext: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
			const { eventCore, window, manifest, publicationSource } = await readLiveWindow(context);
			return {
				season: context.currentSeason.seasonCode,
				coreRevision: eventCore.revision,
				currentEventId: window.currentEventId,
				nextEventId: window.nextEventId,
				anchorEventId: window.anchorEventId,
				latestFinalizedEventId: window.latestFinalizedEventId,
				liveRevision: window.liveRevision,
				state: compatibilityState(window),
				windowState: window.windowState,
				producerState: window.producerState,
				anchorMode: window.anchorMode,
				dataAvailability: window.dataAvailability,
				sourceCheckedAt: window.sourceCheckedAt,
				publishedAt: window.publishedAt,
				source: manifest
					? (publicationSource?.toUpperCase() ?? null)
					: window.anchorEventId
						? "CORE"
						: null,
				stale: window.stale,
				nextRefreshAt: window.nextRefreshAt,
			};
		},
		liveMatchdayDesk: async (
			_parent: unknown,
			args: { ref?: LiveRef | null },
			context: GraphQLContext
		) => {
			if (args.ref && args.ref.season !== context.currentSeason.seasonCode) {
				throw new GraphQLError("Live revision belongs to another season", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			const { eventCore, fixtureCore, window, manifest, publicationSource, lifecycleStatus } =
				await readLiveWindow(context);
			const eventId = args.ref?.eventId ?? window.anchorEventId ?? eventCore.currentEventId ?? 0;
			const eventLifecycle =
				eventId === window.anchorEventId
					? lifecycleStatus
					: await getLiveLifecycleStatus(context, eventId);
			const eventPublication =
				eventId !== window.anchorEventId
					? await getLiveDataPublicationManifestWithSource(context, eventId).catch(() => null)
					: manifest
						? { manifest, source: publicationSource }
						: null;
			const eventManifest = eventPublication?.manifest ?? null;
			const coreDesk = (
				usableManifest = eventManifest,
				usableSource = eventPublication?.source ?? null
			) =>
				scheduledMatchdayDesk(
					eventCore,
					fixtureCore,
					eventId,
					usableManifest,
					usableSource,
					window
				);
			let snapshot: LiveDataSnapshot | null = null;
			if (eventId > 0) {
				snapshot = await getLiveDataSnapshot(context, eventId).catch(() => null);
			}
			if (args.ref && (!snapshot || snapshot.revision !== args.ref.revision)) {
				throw new GraphQLError("Requested live revision has expired", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			// A manifest without all immutable items is not a usable live revision.
			// Keep the core schedule visible, but do not expose the broken revision as
			// if it were a valid live overlay.
			if (!snapshot) return coreDesk(null);
			const snapshotWindow = resolveLiveWindow({
				events: eventCore.events,
				fixtures: mergeLiveSnapshotFixtures(fixtureCore.fixtures, snapshot),
				currentEventId: eventCore.currentEventId,
				nextEventId: window.nextEventId,
				liveRevision: snapshot.revision,
				publicationId: snapshot.publicationId,
				liveEventId: snapshot.eventId,
				publicationState: snapshot.state,
				sourceCheckedAt: snapshot.lastSuccessfulFetchAt,
				publishedAt: snapshot.publishedAt,
				source: snapshot.source,
				lifecycleEventId: eventLifecycle?.eventId ?? null,
				lifecycleState: eventLifecycle?.state ?? null,
				lifecycleObservedAt: eventLifecycle?.observedAt ?? null,
				lifecycleNextRefreshAt: eventLifecycle?.nextRefreshAt ?? null,
				lifecycleLiveRevision: eventLifecycle?.liveRevision ?? null,
				lifecyclePublicationId: eventLifecycle?.publicationId ?? null,
				lifecycleSourceCheckedAt: eventLifecycle?.sourceCheckedAt ?? null,
			});
			return {
				season: snapshot.seasonCode,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				state: snapshot.state.toUpperCase(),
				windowState: snapshotWindow.windowState,
				dataAvailability: snapshotWindow.dataAvailability,
				liveRevision: snapshot.revision,
				sourceCheckedAt: snapshot.lastSuccessfulFetchAt,
				publishedAt: snapshot.publishedAt,
				source: snapshot.source === "postgres" ? "POSTGRES" : "REDIS",
				stale: snapshotWindow.stale,
				nextRefreshAt: snapshotWindow.nextRefreshAt,
				matches: matchRows(snapshot.eventId, snapshot.fixtures, fixtureCore),
				nextFixtures: nextEventAfter(eventCore, snapshot.eventId)
					? matchRows(
							nextEventAfter(eventCore, snapshot.eventId)!,
							fixtureCore.fixtures.filter(
								(fixture) => fixture.eventId === nextEventAfter(eventCore, snapshot.eventId)
							),
							fixtureCore
						)
					: [],
				highlights: [...snapshot.eventLives]
					.sort((a, b) => b.totalPoints - a.totalPoints)
					.slice(0, 10),
			};
		},
		liveFixturePlayers: async (
			_parent: unknown,
			args: { ref: LiveRef; fixtureId: number },
			context: GraphQLContext
		) => {
			const { snapshot, core } = await resolveSnapshot(context, args.ref);
			const fixture = snapshot.fixtures.find((row) => row.id === args.fixtureId);
			if (!fixture)
				throw new GraphQLError("Fixture is not in this live revision", {
					extensions: { code: "NOT_FOUND" },
				});
			const ids = new Set([fixture.teamHId, fixture.teamAId]);
			const playerIds = new Set(
				core.players.filter((player) => ids.has(player.teamId)).map((player) => player.id)
			);
			return {
				season: snapshot.seasonCode,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				fixtureId: args.fixtureId,
				players: snapshot.eventLives.filter((row) => playerIds.has(row.playerId)),
			};
		},
		entryLiveCompetitionBoard: async (
			_parent: unknown,
			args: Record<string, unknown>,
			context: GraphQLContext
		) => {
			const request = normalizeEntryLiveCompetitionBoardRequest(args);
			const ref = (args.ref as LiveRef | null | undefined) ?? null;
			if (ref && ref.season !== context.currentSeason.seasonCode) {
				throw new GraphQLError("Live revision belongs to another season", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			if (ref && ref.eventId !== request.eventId) {
				throw new GraphQLError("Live revision belongs to another event", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			const memberTournament = await assertMember(context, request.tournamentId, request.entryId);
			const [liveWindow, tournamentEntryIds] = await Promise.all([
				readLiveWindow(context),
				tournamentsService.getTournamentEntryIdsUncached(context, request.tournamentId),
			]);
			const allEntryIds = normalizeTournamentRosterEntryIds(
				tournamentEntryIds,
				request.entryId,
				!usesPlatformAdminTournamentBypass(context, request.entryId)
			);
			const { entryIds, deferredEntryIds } = selectTournamentDeskEntryWindow(
				allEntryIds,
				request.entryId
			);
			const { eventCore, window } = liveWindow;
			const event = eventCore.events.find((candidate) => candidate.id === request.eventId);
			if (!event) {
				throw new GraphQLError("Event does not belong to the active season", {
					extensions: { code: "LIVE_EVENT_NOT_FOUND" },
				});
			}
			const [snapshot, managerScores] = await Promise.all([
				getLiveDataSnapshot(context, request.eventId).catch(() => null),
				loadManagerScores(context, request.eventId, entryIds, request.tournamentId),
			]);
			if (ref && (!snapshot || snapshot.revision !== ref.revision)) {
				throw new GraphQLError("Requested live revision has expired", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			const playerRevision = snapshot?.revision ?? `core-${eventCore.revision}`;
			const managerRevision = managerLoadRevision(managerScores);
			const rosterRevision = entryLiveCompetitionRosterRevision(allEntryIds);
			const windowRevision = entryLiveCompetitionRosterRevision(entryIds);
			const cacheIdentity = {
				season: context.currentSeason.seasonCode,
				eventId: request.eventId,
				tournamentId: request.tournamentId,
				coreRevision: eventCore.revision,
				playerRevision,
				managerRevision,
				rosterRevision,
				windowRevision,
			};
			const cacheKey = entryLiveCompetitionBoardCacheKey(context, cacheIdentity);
			const requireNet = memberTournament.leagueType === LeagueType.H2H;
			const board = await getOrBuildEntryLiveCompetitionBoard(context, cacheKey, async () => {
				const result = await entryLiveBatchService.calcLivePointsForEntries(
					context,
					request.eventId,
					entryIds,
					true,
					{
						tournamentId: request.tournamentId,
						legacyH2H: requireNet,
						managerScores,
					}
				);
				const rankedRows = rankTournamentRowsByOfficialEventPoints(
					Array.from(result.results.values()),
					{ useNet: requireNet }
				);
				const { playerMap } = await getEventScopedPlayerAndTeamMaps(
					context,
					Array.from(
						new Set(rankedRows.flatMap((row) => row.pickList.map((pick) => pick.element)))
					),
					request.eventId,
					context.currentSeason.seasonCode,
					{
						requireExactEventIdentity:
							request.eventId >= (eventCore.currentEventId ?? request.eventId),
					}
				);
				const eventTeamIds = new Map(
					Array.from(playerMap, ([playerId, player]) => [playerId, player.team_id])
				);
				return buildEntryLiveCompetitionBoard({
					...cacheIdentity,
					eventTeamIds,
					rows: rankedRows,
					totalEntries: allEntryIds.length,
					failedEntryIds: result.errors.map((error) => error.entryId),
					unavailableEntryIds: deferredEntryIds,
					requireNet,
				});
			});
			const page = queryEntryLiveCompetitionBoard(board, request);
			const dataAvailability =
				request.eventId === window.anchorEventId
					? window.dataAvailability
					: event?.finished && event.dataChecked
						? "FINAL"
						: snapshot
							? "LAST_GOOD"
							: event && event.id > (eventCore.currentEventId ?? 0)
								? "SCHEDULED"
								: "UNAVAILABLE";
			return {
				season: context.currentSeason.seasonCode,
				eventId: request.eventId,
				tournamentId: request.tournamentId,
				boardRevision: board.boardRevision,
				playerRevision: board.playerRevision,
				managerRevision: board.managerRevision,
				dataAvailability,
				managerDataAvailability: managerScores.dataAvailability,
				managerServedFrom: managerScores.servedFrom,
				managerRefreshQueued: managerScores.refreshQueued,
				managerCheckedAt: managerScores.checkedAt,
				managerNextRefreshAt: managerScores.nextRefreshAt,
				officialCoverage: board.officialCoverage,
				unavailableEntryIds: board.unavailableEntryIds,
				failedEntryIds: board.failedEntryIds,
				partial: board.partial,
				totalEntries: board.totalEntries,
				filteredEntries: page.filteredEntries,
				page: request.page,
				pageSize: request.pageSize,
				hasMore: page.hasMore,
				highestEventPoints: board.highestEventPoints,
				averageEventPoints: board.averageEventPoints,
				rows: page.rows,
				viewerRow: page.viewerRow,
			};
		},
		entryLiveCompetitionsDesk: async (
			_parent: unknown,
			args: { entryId: number; selectedTournamentId?: number | null; ref?: LiveRef | null },
			context: GraphQLContext
		) => {
			if (args.ref && args.ref.season !== context.currentSeason.seasonCode) {
				throw new GraphQLError("Live revision belongs to another season", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			const [tournaments, liveWindow] = await Promise.all([
				tournamentsService.getEntryTournaments(context, args.entryId),
				readLiveWindow(context),
			]);
			const { eventCore, fixtureCore, window, lifecycleStatus } = liveWindow;
			const eventId = args.ref?.eventId ?? window.anchorEventId ?? eventCore.currentEventId ?? 0;
			const snapshot =
				eventId > 0 ? await getLiveDataSnapshot(context, eventId).catch(() => null) : null;
			if (args.ref && (!snapshot || snapshot.revision !== args.ref.revision)) {
				throw new GraphQLError("Requested live revision has expired", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			const event = eventCore.events.find((candidate) => candidate.id === eventId);
			const deskLifecycle = snapshot
				? snapshot.eventId === window.anchorEventId
					? lifecycleStatus
					: await getLiveLifecycleStatus(context, snapshot.eventId)
				: lifecycleStatus;
			const deskWindow = snapshot
				? resolveLiveWindow({
						events: eventCore.events,
						fixtures: mergeLiveSnapshotFixtures(fixtureCore.fixtures, snapshot),
						currentEventId: eventCore.currentEventId,
						nextEventId: window.nextEventId,
						liveRevision: snapshot.revision,
						publicationId: snapshot.publicationId,
						liveEventId: snapshot.eventId,
						publicationState: snapshot.state,
						sourceCheckedAt: snapshot.lastSuccessfulFetchAt,
						publishedAt: snapshot.publishedAt,
						source: snapshot.source,
						lifecycleEventId: deskLifecycle?.eventId ?? null,
						lifecycleState: deskLifecycle?.state ?? null,
						lifecycleObservedAt: deskLifecycle?.observedAt ?? null,
						lifecycleNextRefreshAt: deskLifecycle?.nextRefreshAt ?? null,
						lifecycleLiveRevision: deskLifecycle?.liveRevision ?? null,
						lifecyclePublicationId: deskLifecycle?.publicationId ?? null,
						lifecycleSourceCheckedAt: deskLifecycle?.sourceCheckedAt ?? null,
					})
				: window;
			const provisional = !(event?.finished && event.dataChecked);
			const deskRevision = snapshot?.revision ?? null;
			const deskState = snapshot?.state.toUpperCase() ?? snapshotStateForWindow(window);
			// A stale/deep-linked tournament id must not trigger an authorization
			// probe for an arbitrary tournament. Fall back to the first authorized
			// roster or tracked official-league tournament returned for this entry.
			const selected =
				(args.selectedTournamentId &&
				tournaments.some((item) => item.id === args.selectedTournamentId)
					? args.selectedTournamentId
					: null) ??
				tournaments[0]?.id ??
				null;
			if (!selected)
				return {
					season: context.currentSeason.seasonCode,
					eventId,
					revision: deskRevision,
					state: deskState,
					windowState: deskWindow.windowState,
					dataAvailability: deskWindow.dataAvailability,
					nextRefreshAt: deskWindow.nextRefreshAt,
					tournaments,
					selectedTournamentId: null,
					board: [],
					managerRevision: null,
					officialCoverage: 0,
					unavailableEntryIds: [],
					partial: false,
					failedEntryIds: [],
					totalEntries: 0,
				};
			await assertMember(context, selected, args.entryId);
			const selectedTournament = tournaments.find((tournament) => tournament.id === selected);
			const requireNet = selectedTournament?.leagueType === LeagueType.H2H;
			const boardCacheKey = snapshot ? competitionBoardCacheKey(context, snapshot, selected) : null;
			// Manager scores have an independent revision from the player-live
			// publication. Do not serve a provisional board cache keyed only by the
			// player revision; the Data service's bounded Redis read is the source
			// of truth for this request.
			const cachedCandidate =
				provisional || !boardCacheKey
					? null
					: await readCompetitionBoardCache(context, boardCacheKey);
			const cachedRows = cachedCandidate?.board as
				| Array<{
						entry: number;
						score?: { source?: string; state?: string };
				  }>
				| undefined;
			const cachedBoard =
				cachedCandidate && cachedRows && managerScoreBoardIsFinal(cachedRows)
					? cachedCandidate
					: null;
			if (cachedBoard) {
				const boardMeta = managerBoardMeta(
					cachedBoard.board as Array<{
						entry: number;
						score?: {
							eventPoints?: number | null;
							netEventPoints?: number | null;
							eventPointSemantics?: string;
							source?: string;
							revision?: string | null;
						};
					}>,
					{ requireNet }
				);
				return {
					season: context.currentSeason.seasonCode,
					eventId,
					revision: deskRevision,
					state: deskState,
					windowState: deskWindow.windowState,
					dataAvailability: deskWindow.dataAvailability,
					nextRefreshAt: deskWindow.nextRefreshAt,
					tournaments,
					selectedTournamentId: selected,
					...boardMeta,
					...cachedBoard,
				};
			}
			const allEntryIds = await tournamentsService.getTournamentEntryIds(context, selected);
			const { entryIds, deferredEntryIds } = selectTournamentDeskEntryWindow(
				allEntryIds,
				args.entryId
			);
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				context,
				eventId,
				entryIds,
				true,
				{ tournamentId: selected, legacyH2H: selectedTournament?.leagueType === LeagueType.H2H }
			);
			const board = rankTournamentRowsByOfficialEventPoints(Array.from(result.results.values()), {
				useNet: requireNet,
			});
			const boardMeta = managerBoardMeta(board, {
				requireNet,
				totalEntries: allEntryIds.length,
			});
			const unavailableEntryIds = Array.from(
				new Set([...boardMeta.unavailableEntryIds, ...deferredEntryIds])
			);
			// `revision` remains the player-live publication ref so existing
			// LiveRevisionRefInput callers can round-trip it. `managerRevision` is
			// the stable composite of all manager-score rows and is the independent
			// freshness signal consumed by the clients.
			const response = {
				season: context.currentSeason.seasonCode,
				eventId,
				revision: deskRevision,
				state: deskState,
				windowState: deskWindow.windowState,
				dataAvailability: deskWindow.dataAvailability,
				nextRefreshAt: deskWindow.nextRefreshAt,
				tournaments,
				selectedTournamentId: selected,
				...boardMeta,
				unavailableEntryIds,
				board,
				partial: result.errors.length > 0 || deferredEntryIds.length > 0,
				failedEntryIds: result.errors.map((error) => error.entryId),
				totalEntries: allEntryIds.length,
			};
			if (
				result.errors.length === 0 &&
				deferredEntryIds.length === 0 &&
				managerScoreBoardIsFinal(board) &&
				boardCacheKey
			) {
				await writeCompetitionBoardCache(
					context,
					boardCacheKey!,
					{
						board,
						partial: false,
						failedEntryIds: [],
						totalEntries: result.meta.totalEntries,
					},
					provisional ? 6 * 60 * 60 : 24 * 60 * 60
				);
			}
			return response;
		},
		tournamentSelectionIndex: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; ref: LiveRef },
			context: GraphQLContext
		) => {
			await assertMember(context, args.tournamentId, args.entryId);
			const { snapshot } = await resolveSnapshot(context, args.ref);
			const rows = await getTournamentSelectionIndexRows(
				context,
				args.tournamentId,
				snapshot.eventId
			);
			const [{ playerMap: players, teamMap: eventTeams }, core] = await Promise.all([
				getEventScopedPlayerAndTeamMaps(
					context,
					rows.map((row) => row.playerId),
					snapshot.eventId,
					args.ref.season
				),
				getCoreDataSnapshot(context),
			]);
			const teams = new Map(core.teams.map((team) => [team.id, team]));
			const enrichedRows = rows.map((row) => {
				const player = players.get(row.playerId);
				const team = player ? teams.get(player.team_id) : null;
				const eventTeam = player ? eventTeams.get(player.team_id) : null;
				return {
					...row,
					playerName: player?.web_name ?? `Player ${row.playerId}`,
					teamId: team?.id ?? player?.team_id ?? 0,
					teamName: team?.name ?? "Unknown",
					teamShortName: eventTeam?.short_name ?? team?.shortName ?? "—",
					position:
						player?.type === 1
							? "GKP"
							: player?.type === 2
								? "DEF"
								: player?.type === 3
									? "MID"
									: player?.type === 4
										? "FWD"
										: "UNKNOWN",
				};
			});
			return {
				tournamentId: args.tournamentId,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				rows: enrichedRows,
			};
		},
		tournamentEntrySquads: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; comparedEntryIds: number[]; ref: LiveRef },
			context: GraphQLContext
		) => {
			const memberTournament = await assertMember(context, args.tournamentId, args.entryId);
			const { snapshot } = await resolveSnapshot(context, args.ref);
			const requestedIds = Array.from(new Set(args.comparedEntryIds));
			if (
				requestedIds.length > 2 ||
				requestedIds.some((entryId) => !Number.isSafeInteger(entryId) || entryId <= 0)
			) {
				throw new GraphQLError("Comparison requires one or two valid tournament entries", {
					extensions: { code: "BAD_USER_INPUT" },
				});
			}
			const tournamentEntryIds = new Set(
				normalizeTournamentRosterEntryIds(
					await tournamentsService.getTournamentEntryIdsUncached(context, args.tournamentId),
					args.entryId,
					!usesPlatformAdminTournamentBypass(context, args.entryId)
				)
			);
			// Preserve the legacy member + opponent contract, but do not prepend a
			// platform administrator whose entry is not actually in this roster.
			const ids = selectTournamentComparisonEntryIds(
				requestedIds,
				args.entryId,
				tournamentEntryIds.has(args.entryId)
			);
			if (
				ids.length === 0 ||
				ids.length > 2 ||
				ids.some((entryId) => !Number.isSafeInteger(entryId) || entryId <= 0)
			) {
				throw new GraphQLError("Comparison requires one or two valid tournament entries", {
					extensions: { code: "BAD_USER_INPUT" },
				});
			}
			if (ids.some((entryId) => !tournamentEntryIds.has(entryId))) {
				throw new GraphQLError("Comparison entry is not a tournament member", {
					extensions: { code: "FORBIDDEN" },
				});
			}
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				context,
				snapshot.eventId,
				ids,
				true,
				{
					tournamentId: args.tournamentId,
					legacyH2H: memberTournament.leagueType === LeagueType.H2H,
				}
			);
			return {
				tournamentId: args.tournamentId,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				state: snapshot.state.toUpperCase(),
				entries: Array.from(result.results.values()),
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
