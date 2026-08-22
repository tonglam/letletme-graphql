import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
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
	managerScoreBoardIsFinal,
	rankTournamentRowsByOfficialEventPoints,
} from "../entry-live/manager-score";
import { getTournamentSelectionIndexRows } from "../event-stats/repository";
import { LeagueType } from "../leagues/repository";
import { tournamentsService } from "../tournaments/service";
import {
	competitionBoardCacheKey,
	readCompetitionBoardCache,
	writeCompetitionBoardCache,
} from "./competition-board-cache";
import { resolveLiveWindow, type LiveWindow } from "./window";

type LiveRef = { season: string; eventId: number; revision: string };

const LIVE_STALE_AFTER_MS = 60_000;

const isStale = (sourceCheckedAt: string | null | undefined): boolean => {
	if (!sourceCheckedAt) return true;
	const checkedAt = Date.parse(sourceCheckedAt);
	return !Number.isFinite(checkedAt) || Date.now() - checkedAt > LIVE_STALE_AFTER_MS;
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
	const [eventCore, fixtureCore, core] = await Promise.all([
		getCoreEventSnapshot(context),
		getCoreFixtureSnapshot(context),
		getCoreLiveIdentitySnapshot(context),
	]);
	const currentEventId = eventCore.currentEventId;
	const currentPublication = currentEventId
		? await getLiveDataPublicationManifestWithSource(context, currentEventId).catch(() => null)
		: null;
	const currentLifecycle = currentEventId
		? await getLiveLifecycleStatus(context, currentEventId)
		: null;
	const currentManifest = currentPublication?.manifest ?? null;
	const initialWindow = resolveLiveWindow({
		events: eventCore.events,
		fixtures: fixtureCore.fixtures,
		currentEventId,
		nextEventId: eventCore.events.find((event) => event.isNext)?.id ?? null,
		liveRevision: currentManifest ? String(currentManifest.revision) : null,
		liveEventId: currentManifest ? currentEventId : null,
		publicationState: livePublicationState(currentManifest),
		sourceCheckedAt: currentManifest?.sourceCheckedAt ?? fixtureCore.sourceCheckedAt,
		publishedAt: currentManifest?.publishedAt ?? fixtureCore.sourceCheckedAt,
		source: currentPublication?.source ?? fixtureCore.source,
		lifecycleEventId: currentLifecycle?.eventId ?? null,
		lifecycleState: currentLifecycle?.state ?? null,
		lifecycleNextRefreshAt: currentLifecycle?.nextRefreshAt ?? null,
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
	const window = anchorManifest
		? resolveLiveWindow({
				events: eventCore.events,
				fixtures: fixtureCore.fixtures,
				currentEventId,
				nextEventId: initialWindow.nextEventId,
				liveRevision: String(anchorManifest.revision),
				liveEventId: initialWindow.anchorEventId,
				publicationState: livePublicationState(anchorManifest),
				sourceCheckedAt: anchorManifest.sourceCheckedAt,
				publishedAt: anchorManifest.publishedAt,
				source: anchorPublication?.source ?? fixtureCore.source,
				lifecycleEventId: anchorLifecycle?.eventId ?? null,
				lifecycleState: anchorLifecycle?.state ?? null,
				lifecycleNextRefreshAt: anchorLifecycle?.nextRefreshAt ?? null,
			})
		: initialWindow;
	return {
		eventCore,
		fixtureCore,
		core,
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
		sourceCheckedAt: manifest?.sourceCheckedAt ?? fixtureCore.sourceCheckedAt,
		// Keep the non-null GraphQL contract without pretending that core data is
		// a live publication. This timestamp is only used for freshness display.
		publishedAt: manifest?.publishedAt ?? fixtureCore.sourceCheckedAt,
		source: manifest ? publicationSource?.toUpperCase() : "CORE",
		stale: isStale(manifest?.sourceCheckedAt ?? fixtureCore.sourceCheckedAt),
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
	options: { requireNet?: boolean } = {}
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
		officialCoverage: board.length === 0 ? 0 : officialRows.length / board.length,
		unavailableEntryIds,
	};
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
			const { eventCore, fixtureCore, core, window, manifest, publicationSource, lifecycleStatus } =
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
				fixtures: fixtureCore.fixtures,
				currentEventId: eventCore.currentEventId,
				nextEventId: window.nextEventId,
				liveRevision: snapshot.revision,
				liveEventId: snapshot.eventId,
				publicationState: snapshot.state,
				sourceCheckedAt: snapshot.sourceCheckedAt,
				publishedAt: snapshot.publishedAt,
				source: snapshot.source,
				lifecycleEventId: eventLifecycle?.eventId ?? null,
				lifecycleState: eventLifecycle?.state ?? null,
				lifecycleNextRefreshAt: eventLifecycle?.nextRefreshAt ?? null,
			});
			return {
				season: snapshot.seasonCode,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				state: snapshot.state.toUpperCase(),
				windowState: snapshotWindow.windowState,
				dataAvailability: snapshotWindow.dataAvailability,
				liveRevision: snapshot.revision,
				sourceCheckedAt: snapshot.sourceCheckedAt,
				publishedAt: snapshot.publishedAt,
				source: snapshot.source === "postgres" ? "POSTGRES" : "REDIS",
				stale: isStale(snapshot.sourceCheckedAt),
				nextRefreshAt: snapshotWindow.nextRefreshAt,
				matches: matchRows(snapshot.eventId, snapshot.fixtures, core),
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
			const [tournaments, eventCore, fixtureCore] = await Promise.all([
				tournamentsService.getEntryTournaments(context, args.entryId),
				getCoreEventSnapshot(context),
				getCoreFixtureSnapshot(context),
			]);
			const currentLifecycle = eventCore.currentEventId
				? await getLiveLifecycleStatus(context, eventCore.currentEventId)
				: null;
			const window = resolveLiveWindow({
				events: eventCore.events,
				fixtures: fixtureCore.fixtures,
				currentEventId: eventCore.currentEventId,
				nextEventId: eventCore.events.find((event) => event.isNext)?.id ?? null,
				liveRevision: null,
				sourceCheckedAt: fixtureCore.sourceCheckedAt,
				publishedAt: fixtureCore.sourceCheckedAt,
				source: fixtureCore.source,
				lifecycleEventId: currentLifecycle?.eventId ?? null,
				lifecycleState: currentLifecycle?.state ?? null,
				lifecycleNextRefreshAt: currentLifecycle?.nextRefreshAt ?? null,
			});
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
				? await getLiveLifecycleStatus(context, snapshot.eventId)
				: currentLifecycle;
			const deskWindow = snapshot
				? resolveLiveWindow({
						events: eventCore.events,
						fixtures: fixtureCore.fixtures,
						currentEventId: eventCore.currentEventId,
						nextEventId: window.nextEventId,
						liveRevision: snapshot.revision,
						liveEventId: snapshot.eventId,
						publicationState: snapshot.state,
						sourceCheckedAt: snapshot.sourceCheckedAt,
						publishedAt: snapshot.publishedAt,
						source: snapshot.source,
						lifecycleEventId: deskLifecycle?.eventId ?? null,
						lifecycleState: deskLifecycle?.state ?? null,
						lifecycleNextRefreshAt: deskLifecycle?.nextRefreshAt ?? null,
					})
				: window;
			const provisional = !(event?.finished && event.dataChecked);
			const deskRevision = snapshot?.revision ?? null;
			const deskState = snapshot?.state.toUpperCase() ?? snapshotStateForWindow(window);
			// A stale/deep-linked tournament id must not trigger an authorization
			// probe for an arbitrary tournament. Fall back to the first membership
			// returned for this entry and keep the desk single-request.
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
			const entryIds = await tournamentsService.getTournamentEntryIds(context, selected);
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
			const boardMeta = managerBoardMeta(board, { requireNet });
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
				board,
				partial: result.errors.length > 0,
				failedEntryIds: result.errors.map((error) => error.entryId),
				totalEntries: result.meta.totalEntries,
			};
			if (result.errors.length === 0 && managerScoreBoardIsFinal(board) && boardCacheKey) {
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
			return {
				tournamentId: args.tournamentId,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				rows,
			};
		},
		tournamentEntrySquads: async (
			_parent: unknown,
			args: { entryId: number; tournamentId: number; comparedEntryIds: number[]; ref: LiveRef },
			context: GraphQLContext
		) => {
			const memberTournament = await assertMember(context, args.tournamentId, args.entryId);
			const { snapshot } = await resolveSnapshot(context, args.ref);
			const ids = Array.from(new Set([args.entryId, ...args.comparedEntryIds])).slice(0, 2);
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
