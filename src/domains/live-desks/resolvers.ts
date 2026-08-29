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
import { metrics } from "../../infra/metrics";
import { env } from "../../infra/env";
import {
	calcLivePointsForEntriesInChunks,
	entryLiveBatchService,
} from "../entry-live/batch-service";
import { entryLiveRepository } from "../entry-live/repository";
import {
	isManagerScoreLiveHeartbeatFresh,
	loadManagerScores,
	managerScoreHeartbeatFreshnessDeadline,
	managerScoreHeartbeatRefreshDeadline,
	managerScoreBoardIsFinal,
	rankTournamentRowsByOfficialEventPoints,
	type ManagerScoreLoad,
} from "../entry-live/manager-score";
import { loadManagerScoresInChunks } from "../entry-live/manager-score-batches";
import { entriesService } from "../entries/service";
import { getPlayerAndTeamMaps, getTournamentSelectionIndexRows } from "../event-stats/repository";
import { LeagueType } from "../leagues/repository";
import { playersService } from "../players/service";
import { Position } from "../players/repository";
import { tournamentsService } from "../tournaments/service";
import {
	competitionBoardCacheKey,
	readCompetitionBoardCache,
	writeCompetitionBoardCache,
} from "./competition-board-cache";
import {
	buildEntryLiveCompetitionBoard,
	buildScheduledEntryLiveCompetitionBoard,
	entryLiveCompetitionBoardCacheKey,
	entryLiveCompetitionManagerStatusRevision,
	entryLiveCompetitionRosterRevision,
	enrichEntryLiveCompetitionBoardRow,
	getOrBuildEntryLiveCompetitionBoard,
	normalizeEntryLiveCompetitionBoardRequest,
	queryEntryLiveCompetitionBoard,
} from "./entry-live-competition-board";
import { buildFullFieldLiveBoardIndex } from "./full-field-live-board";
import {
	claimLivePublicationFailureLog,
	livePublicationFailureDetails,
} from "./publication-observability";
import {
	loadTournamentEventEligibility,
	selectTournamentDeskEntryWindow,
} from "./tournament-entry-window";
import { resolveLiveWindow, type LiveWindow } from "./window";

type LiveRef = { season: string; eventId: number; revision: string };

const selectionPositionName = (position: number): keyof typeof Position => {
	switch (position) {
		case Position.GOALKEEPER:
			return "GOALKEEPER";
		case Position.DEFENDER:
			return "DEFENDER";
		case Position.FORWARD:
			return "FORWARD";
		case Position.MIDFIELDER:
		default:
			return "MIDFIELDER";
	}
};

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

const lifecycleStateForWindow = (
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

export const selectManagerScoresForBoard = (
	initial: ManagerScoreLoad,
	expanded: ManagerScoreLoad | null,
	fullFieldDataReady: boolean
): ManagerScoreLoad => (fullFieldDataReady && expanded ? expanded : initial);

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
		metrics.livePublicationEventsTotal.labels("revision_gone").inc();
		throw new GraphQLError("Live revision belongs to another season", {
			extensions: { code: "LIVE_REVISION_GONE" },
		});
	}
	const eventId = ref?.eventId ?? (await getCoreEventSnapshot(context)).currentEventId ?? 0;
	const snapshot = await getLiveDataSnapshot(context, eventId).catch((error) => {
		const failure = livePublicationFailureDetails(error, context.currentSeason.seasonCode, eventId);
		metrics.livePublicationEventsTotal
			.labels(failure.reason === "LIVE_PUBLICATION_UNAVAILABLE" ? "unavailable" : "load_failed")
			.inc();
		if (
			claimLivePublicationFailureLog(context.requestScope ?? context, eventId, failure.revision)
		) {
			context.logger.warn(
				{
					season: context.currentSeason.seasonCode,
					eventId,
					revision: failure.revision,
					reason: failure.reason,
				},
				"Live publication snapshot is unavailable"
			);
		}
		throw new GraphQLError("Live publication is unavailable", {
			extensions: { code: "LIVE_PUBLICATION_UNAVAILABLE" },
		});
	});
	if (ref && snapshot.revision !== ref.revision) {
		metrics.livePublicationEventsTotal.labels("revision_gone").inc();
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

const assertMemberOrManager = async (
	context: GraphQLContext,
	tournamentId: number,
	entryId: number
) => {
	const member = await tournamentsService.getTournamentForMember(context, tournamentId, entryId);
	if (member) return member;
	const verifiedManagerEntryId =
		typeof context.principal?.fplEntryId === "number" &&
		context.principal.fplEntryId > 0 &&
		Boolean(context.principal.fplEntryVerifiedAt)
			? context.principal.fplEntryId
			: null;
	const managed =
		verifiedManagerEntryId === null
			? null
			: await tournamentsService.getManagedTournament(
					context,
					tournamentId,
					verifiedManagerEntryId
				);
	if (managed) return managed;
	throw new GraphQLError("Tournament access denied", { extensions: { code: "FORBIDDEN" } });
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
	options: { requireNet?: boolean; totalEntries?: number } = {}
) => {
	const isOfficialSource = (source?: string): boolean =>
		source === "FPL_EVENT_LIVE" || source === "FPL_FINAL_RESULT";
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

export const managerScoresAlignedWithLiveSnapshot = (
	managerScores: ManagerScoreLoad,
	event: { finished: boolean; dataChecked: boolean },
	snapshot: LiveDataSnapshot | null
): boolean => {
	// LAST_GOOD is useful for a bounded retained result, but it cannot define
	// the global order of a full-field board while the player-live publication
	// may already have advanced. Final-result rows are independently durable,
	// so a complete load made only of those rows remains valid after settlement.
	if (event.finished && event.dataChecked) {
		return (
			(managerScores.dataAvailability === "FRESH" ||
				managerScores.dataAvailability === "LAST_GOOD") &&
			managerScores.rows.size > 0 &&
			Array.from(managerScores.rows.values()).every((row) => row.source === "FPL_FINAL_RESULT")
		);
	}
	if (
		(managerScores.dataAvailability !== "FRESH" &&
			managerScores.dataAvailability !== "LAST_GOOD") ||
		managerScores.errorCode !== null ||
		managerScores.missingEntryIds.length > 0
	)
		return false;
	if (!snapshot) return false;
	if (typeof snapshot.publicationId !== "string" || snapshot.publicationId.trim() === "")
		return false;
	return Array.from(managerScores.rows.values()).every((row) => {
		const managerCheckedAt = Date.parse(row.checkedAt);
		const provenance = row.provenance;
		return (
			row.source === "FPL_EVENT_LIVE" &&
			Number.isFinite(managerCheckedAt) &&
			provenance?.scoreSource === "FPL_EVENT_LIVE" &&
			provenance.calculationMode === "PROJECTED_AUTOSUBS" &&
			provenance.livePublicationId === snapshot.publicationId &&
			provenance.liveRevision === snapshot.revision
		);
	});
};

/**
 * A complete durable manager load is safe to use as a last-good board source
 * even when its projected rows belong to an older live publication. This is
 * deliberately separate from `managerScoresAlignedWithLiveSnapshot`: the
 * latter remains the gate for advertising current FRESH scores.
 */
export const managerScoreLoadHasCompleteRows = (
	managerScores: ManagerScoreLoad,
	entryIds: readonly number[]
): boolean => {
	const expected = new Set(entryIds);
	return (
		managerScores.errorCode === null &&
		managerScores.missingEntryIds.length === 0 &&
		managerScores.rows.size === expected.size &&
		Array.from(expected).every((entryId) => managerScores.rows.has(entryId))
	);
};

export const managerScoreLoadHasCoherentLastGoodRevision = (
	managerScores: ManagerScoreLoad,
	entryIds: readonly number[],
	coverageFence?: Readonly<{ rosterRevision: string; expectedEntries: number }>
): boolean => {
	if (!managerScoreLoadHasCompleteRows(managerScores, entryIds)) return false;
	const rawLiveReferences = Array.from(managerScores.rows.values()).map((row) => {
		const publicationId = row.provenance?.livePublicationId;
		const revision = row.provenance?.liveRevision;
		return publicationId && revision ? `${publicationId}:${revision}` : null;
	});
	if (rawLiveReferences.some((reference) => reference === null)) return false;
	const liveReferences = new Set(rawLiveReferences as string[]);
	if (liveReferences.size === 1) return true;
	// A multi-chunk read may legitimately contain heads from different
	// publications while Data's durable coverage checkpoint still proves one
	// complete, internally consistent crawl. The initial board read is often a
	// 500-row window into a larger tournament, so the checkpoint may cover a
	// superset of this request. The caller separately fences that checkpoint to
	// the tournament roster before attempting full-field expansion.
	const coverage = managerScores.tournamentCoverage;
	const requestedEntries = new Set(entryIds).size;
	const coverageMatchesFencedRoster =
		coverageFence !== undefined &&
		coverage?.rosterRevision === coverageFence.rosterRevision &&
		coverage?.expectedEntries === coverageFence.expectedEntries &&
		(coverage?.expectedEntries ?? 0) >= requestedEntries;
	return (
		liveReferences.size > 1 &&
		coverage?.state === "COMPLETE" &&
		typeof coverage.rosterRevision === "string" &&
		coverage.rosterRevision.trim().length > 0 &&
		(coverage.expectedEntries === requestedEntries || coverageMatchesFencedRoster) &&
		coverage.resolvedEntries === coverage.expectedEntries &&
		typeof coverage.managerRevision === "string" &&
		coverage.managerRevision.trim().length > 0
	);
};

export const managerScoreLoadCanUseLastGood = (
	managerScores: ManagerScoreLoad,
	entryIds: readonly number[],
	allowLastGood: boolean,
	coverageFence?: Readonly<{ rosterRevision: string; expectedEntries: number }>
): boolean =>
	allowLastGood &&
	managerScoreLoadHasCoherentLastGoodRevision(managerScores, entryIds, coverageFence) &&
	(managerScores.dataAvailability === "FRESH" || managerScores.dataAvailability === "LAST_GOOD");

type ComparableManagerRankRow = {
	eventPoints: number | null;
	netEventPoints: number | null;
	eventPointSemantics: string;
	overallRank: number | null;
	provenance?: { rankCheckedAt?: string | null } | null;
};

export const hasComparableManagerRankMetric = (
	row: ComparableManagerRankRow | undefined,
	useNet: boolean
): boolean =>
	Boolean(
		row &&
		(useNet
			? typeof row.netEventPoints === "number" && row.eventPointSemantics !== "UNKNOWN"
			: typeof row.eventPoints === "number" &&
				(row.eventPointSemantics === "GROSS" || row.eventPointSemantics === "ZERO_COST_EQUIVALENT"))
	);

export const hasComparableFullFieldManagerMetric = (
	row: ComparableManagerRankRow | undefined,
	options: {
		requireNet: boolean;
		requestedNet: boolean;
		requireOverallRank?: boolean;
	}
): boolean => {
	const requiresNet = options.requireNet || options.requestedNet;
	const requiresGross = !options.requestedNet || !options.requireNet;
	return (
		(!requiresNet || hasComparableManagerRankMetric(row, true)) &&
		(!requiresGross || hasComparableManagerRankMetric(row, false)) &&
		(!options.requireOverallRank || (typeof row?.overallRank === "number" && row.overallRank > 0))
	);
};

/**
 * Tournament coverage is an advisory crawl checkpoint. A matching PARTIAL
 * checkpoint may be behind the immutable manager heads, so it can authorize a
 * bounded full-field verification; a mismatched roster or UNAVAILABLE fence
 * must still fail closed.
 */
export const managerCoverageFenceMatches = (
	coverage: ManagerScoreLoad["tournamentCoverage"],
	rosterRevision: string,
	expectedEntries: number
): boolean =>
	coverage === null ||
	coverage === undefined ||
	(coverage.state !== "UNAVAILABLE" &&
		coverage.rosterRevision === rosterRevision &&
		coverage.expectedEntries === expectedEntries);

export const isScheduledTournamentEvent = (input: {
	eventId: number;
	currentEventId: number | null;
	anchorEventId: number | null;
	dataAvailability: string;
	finished: boolean;
	dataChecked: boolean;
}): boolean => {
	const isFinishedEvent = input.finished;
	return (
		!isFinishedEvent &&
		(input.eventId > (input.currentEventId ?? 0) ||
			(input.eventId === input.anchorEventId && input.dataAvailability === "SCHEDULED"))
	);
};

export const classifyEntryLiveCompetitionDataAvailability = (input: {
	eventId: number;
	anchorEventId: number | null;
	anchorDataAvailability: string;
	currentEventId: number | null;
	finished: boolean;
	dataChecked: boolean;
	snapshotAvailable: boolean;
}): string => {
	if (input.eventId === input.anchorEventId) return input.anchorDataAvailability;
	if (input.finished && input.dataChecked) return "FINAL";
	if (input.snapshotAvailable) return "LAST_GOOD";
	if (!input.finished && input.eventId > (input.currentEventId ?? 0)) return "SCHEDULED";
	return "UNAVAILABLE";
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
				state: lifecycleStateForWindow(window),
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
				metrics.livePublicationEventsTotal.labels("revision_gone").inc();
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
				metrics.livePublicationEventsTotal.labels("revision_gone").inc();
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
				metrics.livePublicationEventsTotal.labels("revision_gone").inc();
				throw new GraphQLError("Live revision belongs to another season", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}
			if (ref && ref.eventId !== request.eventId) {
				metrics.livePublicationEventsTotal.labels("revision_gone").inc();
				throw new GraphQLError("Live revision belongs to another event", {
					extensions: { code: "LIVE_REVISION_GONE" },
				});
			}

			const boardAccess = await assertMemberOrManager(
				context,
				request.tournamentId,
				request.entryId
			);
			const memberTournament = boardAccess;
			const [liveWindow, tournamentEntryIds] = await Promise.all([
				readLiveWindow(context),
				tournamentsService.getTournamentEntryIdsUncached(context, request.tournamentId),
			]);
			const rosterEntryIds = Array.from(
				new Set(
					tournamentEntryIds.filter(
						(entryId): entryId is number =>
							typeof entryId === "number" && Number.isSafeInteger(entryId) && entryId > 0
					)
				)
			).sort((left, right) => left - right);
			const { eventCore, window } = liveWindow;
			const event = eventCore.events.find((candidate) => candidate.id === request.eventId);
			if (!event) {
				throw new GraphQLError("Event does not belong to the active season", {
					extensions: { code: "LIVE_EVENT_NOT_FOUND" },
				});
			}
			const corePlayerRevision = `core-${eventCore.revision}`;
			const isScheduledEvent = isScheduledTournamentEvent({
				eventId: event.id,
				currentEventId: eventCore.currentEventId,
				anchorEventId: window.anchorEventId,
				dataAvailability: window.dataAvailability,
				finished: event.finished,
				dataChecked: event.dataChecked,
			});
			if (isScheduledEvent) {
				if (ref) {
					throw new GraphQLError("Requested live revision has expired", {
						extensions: { code: "LIVE_BOARD_REVISION_GONE" },
					});
				}
				const scheduledRosterRevision = entryLiveCompetitionRosterRevision(rosterEntryIds);
				const scheduledBoard = buildScheduledEntryLiveCompetitionBoard({
					season: context.currentSeason.seasonCode,
					eventId: request.eventId,
					tournamentId: request.tournamentId,
					coreRevision: eventCore.revision,
					playerRevision: corePlayerRevision,
					rosterRevision: scheduledRosterRevision,
					windowRevision: scheduledRosterRevision,
					totalEntries: rosterEntryIds.length,
				});
				const scheduledPage = queryEntryLiveCompetitionBoard(scheduledBoard, request);
				return {
					season: context.currentSeason.seasonCode,
					eventId: request.eventId,
					tournamentId: request.tournamentId,
					boardRevision: scheduledBoard.boardRevision,
					playerRevision: scheduledBoard.playerRevision,
					managerRevision: null,
					dataAvailability: "SCHEDULED",
					managerDataAvailability: "SCHEDULED",
					managerServedFrom: "NONE",
					managerRefreshQueued: false,
					managerCheckedAt: null,
					managerNextRefreshAt: null,
					coverageState: "UNAVAILABLE",
					rankScope: "AVAILABLE_ROWS",
					computedEntries: 0,
					deferredEntryCount: 0,
					failedEntryCount: 0,
					unavailableEntryCount: 0,
					officialCoverage: 0,
					unavailableEntryIds: [],
					failedEntryIds: [],
					partial: false,
					totalEntries: rosterEntryIds.length,
					filteredEntries: scheduledPage.filteredEntries,
					page: request.page,
					pageSize: request.pageSize,
					hasMore: scheduledPage.hasMore,
					highestEventPoints: null,
					averageEventPoints: null,
					rows: scheduledPage.rows,
					viewerRow: scheduledPage.viewerRow,
				};
			}
			const eligibility = await loadTournamentEventEligibility(
				rosterEntryIds,
				request.eventId,
				(entryIds) => entriesService.getEntriesByIds(context, entryIds)
			);
			const allEntryIds = eligibility.entryIds;
			const rosterEntries = eligibility.entriesById;
			const { entryIds, deferredEntryIds } = selectTournamentDeskEntryWindow(
				allEntryIds,
				request.entryId
			);
			// Data's coverage revision describes the current tournament roster, while
			// expected/resolved counts describe the event-eligible subset. Keep that
			// durable membership identity separate from the historical calculation
			// window so a manager who joined in GW2 cannot invalidate a complete GW1
			// board.
			const rosterRevision = entryLiveCompetitionRosterRevision(rosterEntryIds);
			const windowRevision = entryLiveCompetitionRosterRevision(entryIds);

			const snapshot = await getLiveDataSnapshot(context, request.eventId).catch(() => null);
			// A caller-supplied ref is an immutable read contract. Normal board pages
			// intentionally omit the moving publication fence so Data can return the
			// newest durable head (LAST_GOOD when the active publication has advanced)
			// instead of making every page chase a revision that may disappear before
			// the next chunk is read.
			if (ref && (!snapshot || snapshot.revision !== ref.revision || !snapshot.publicationId)) {
				throw new GraphQLError("Requested live revision has expired", {
					extensions: { code: "LIVE_BOARD_REVISION_GONE" },
				});
			}
			const managerLiveRef =
				ref && snapshot?.publicationId
					? { publicationId: snapshot.publicationId, revision: ref.revision }
					: undefined;
			const initialManagerScores = await loadManagerScores(
				context,
				request.eventId,
				entryIds,
				request.tournamentId,
				{
					includeEffectiveLineup: true,
					readMode: "CACHE_ONLY",
					...(managerLiveRef ? { liveRef: managerLiveRef } : {}),
				}
			);

			const requireNet = memberTournament.leagueType === LeagueType.H2H;
			const requestedNet = request.sort === "NET_EVENT_POINTS";
			const requireOverallRank = request.sort === "OVERALL_RANK";
			const fullFieldEnabled = env.FULL_FIELD_LIVE_BOARD_ENABLED;
			const initialCoverage = initialManagerScores.tournamentCoverage;
			const initialCoverageFenceMatches = managerCoverageFenceMatches(
				initialCoverage,
				rosterRevision,
				allEntryIds.length
			);
			const initialRowsAreComplete = managerScoreLoadHasCompleteRows(
				initialManagerScores,
				entryIds
			);
			const initialRowsAlignedWithCurrentSnapshot = managerScoresAlignedWithLiveSnapshot(
				initialManagerScores,
				event,
				snapshot
			);
			const initialRowsCanUseLastGood = managerScoreLoadCanUseLastGood(
				initialManagerScores,
				entryIds,
				!ref && !(event.finished && event.dataChecked),
				{ rosterRevision, expectedEntries: allEntryIds.length }
			);
			const fullFieldManagerFreshnessReady =
				(event.finished && event.dataChecked) ||
				(window.dataAvailability === "FRESH" &&
					isManagerScoreLiveHeartbeatFresh(snapshot?.lastSuccessfulFetchAt));
			const initialWindowRowsAreUsable =
				initialRowsAreComplete &&
				((fullFieldManagerFreshnessReady && initialRowsAlignedWithCurrentSnapshot) ||
					initialRowsCanUseLastGood);
			const initialHasComparableOverallTotals = allEntryIds.every((entryId) => {
				const row = initialManagerScores.rows.get(entryId);
				return row?.totalScope === "OVERALL" && typeof row.totalPoints === "number";
			});
			const canAttemptFullField =
				fullFieldEnabled &&
				request.sort !== "PLAYED" &&
				(request.sort !== "TOTAL_POINTS" ||
					(allEntryIds.length <= entryIds.length && initialHasComparableOverallTotals)) &&
				request.captainPlayerIds.length === 0 &&
				(request.ownership?.captainMode ?? "ANY") === "ANY" &&
				initialCoverageFenceMatches &&
				initialWindowRowsAreUsable;
			let expandedManagerScores: ManagerScoreLoad | null = null;
			let fullFieldDataReady = false;
			if (canAttemptFullField && allEntryIds.length > entryIds.length) {
				try {
					const completeManagerScores = await loadManagerScoresInChunks(
						allEntryIds,
						(chunk) =>
							loadManagerScores(context, request.eventId, chunk, request.tournamentId, {
								includeEffectiveLineup: true,
								readMode: "CACHE_ONLY",
								...(managerLiveRef ? { liveRef: managerLiveRef } : {}),
							}),
						2
					);
					expandedManagerScores = completeManagerScores;
					const coverage = completeManagerScores.tournamentCoverage;
					const coverageFenceMatches = managerCoverageFenceMatches(
						coverage,
						rosterRevision,
						allEntryIds.length
					);
					const hasAllRankMetrics = allEntryIds.every((entryId) => {
						return hasComparableFullFieldManagerMetric(completeManagerScores.rows.get(entryId), {
							requireNet,
							requestedNet,
							requireOverallRank,
						});
					});
					const completeRowsAlignedWithCurrentSnapshot = managerScoresAlignedWithLiveSnapshot(
						completeManagerScores,
						event,
						snapshot
					);
					const completeRowsCanUseLastGood = managerScoreLoadCanUseLastGood(
						completeManagerScores,
						allEntryIds,
						!ref && !(event.finished && event.dataChecked)
					);
					fullFieldDataReady =
						coverageFenceMatches &&
						managerScoreLoadHasCompleteRows(completeManagerScores, allEntryIds) &&
						hasAllRankMetrics &&
						((fullFieldManagerFreshnessReady && completeRowsAlignedWithCurrentSnapshot) ||
							completeRowsCanUseLastGood);
				} catch (error) {
					context.logger.warn(
						{ err: error, eventId: request.eventId, tournamentId: request.tournamentId },
						"Full-field manager expansion unavailable; retaining bounded manager load"
					);
				}
			} else {
				const managerScores = initialManagerScores;
				const hasAllRankMetrics = allEntryIds.every((entryId) => {
					return hasComparableFullFieldManagerMetric(managerScores.rows.get(entryId), {
						requireNet,
						requestedNet,
						requireOverallRank,
					});
				});
				fullFieldDataReady =
					canAttemptFullField &&
					managerScoreLoadHasCompleteRows(managerScores, allEntryIds) &&
					hasAllRankMetrics &&
					((fullFieldManagerFreshnessReady &&
						managerScoresAlignedWithLiveSnapshot(managerScores, event, snapshot)) ||
						managerScoreLoadCanUseLastGood(
							managerScores,
							allEntryIds,
							!ref && !(event.finished && event.dataChecked)
						));
			}
			const selectedManagerScores = selectManagerScoresForBoard(
				initialManagerScores,
				expandedManagerScores,
				fullFieldDataReady
			);
			const managerRowsAlignedWithCurrentSnapshot = managerScoresAlignedWithLiveSnapshot(
				selectedManagerScores,
				event,
				snapshot
			);
			const managerRowsAreCurrent =
				fullFieldManagerFreshnessReady && managerRowsAlignedWithCurrentSnapshot;
			const managerRowsAreMisaligned = !managerRowsAlignedWithCurrentSnapshot;
			const managerRowsExpectedEntryIds = fullFieldDataReady ? allEntryIds : entryIds;
			const managerUsingLastGood = managerScoreLoadCanUseLastGood(
				selectedManagerScores,
				managerRowsExpectedEntryIds,
				!ref && !(event.finished && event.dataChecked) && !managerRowsAreCurrent
			);
			const managerNeedsLastGoodDetailFence = managerUsingLastGood && managerRowsAreMisaligned;
			// Data can legitimately report FRESH based on the head's own checkedAt
			// even when that head belongs to an older live publication. Normalize
			// that response before it reaches score builders and page calculators so
			// consumers see LAST_GOOD/STALE rather than a false current heartbeat.
			const managerScores =
				managerUsingLastGood && selectedManagerScores.dataAvailability === "FRESH"
					? { ...selectedManagerScores, dataAvailability: "LAST_GOOD" as const }
					: selectedManagerScores;
			// Keep the public marker tied to the player publication. The web client
			// uses this field to decide when to poll the live snapshot; replacing it
			// with a manager-head hash would make every last-good response look like
			// a new publication and create a refresh loop.
			const playerRevision = snapshot?.revision ?? corePlayerRevision;
			const managerFreshnessCheckedAt =
				!(event.finished && event.dataChecked) &&
				window.dataAvailability === "FRESH" &&
				typeof snapshot?.publicationId === "string" &&
				managerRowsAreCurrent
					? (snapshot?.lastSuccessfulFetchAt ?? null)
					: null;
			const managerRevision = managerLoadRevision(managerScores);
			const managerHeartbeatDeadline =
				managerFreshnessCheckedAt !== null
					? managerScoreHeartbeatFreshnessDeadline(managerFreshnessCheckedAt)
					: null;
			const managerStatusRevision = entryLiveCompetitionManagerStatusRevision(
				managerScores,
				Date.now(),
				managerFreshnessCheckedAt !== null
			);
			const cacheIdentity = {
				season: context.currentSeason.seasonCode,
				eventId: request.eventId,
				tournamentId: request.tournamentId,
				coreRevision: eventCore.revision,
				playerRevision,
				managerRevision,
				rosterRevision,
			};
			const makeCacheKey = (
				boardWindowRevision: string,
				projectionMode: "BOUNDED" | "FULL_FIELD"
			): string =>
				entryLiveCompetitionBoardCacheKey(context, {
					...cacheIdentity,
					windowRevision: boardWindowRevision,
					projectionMode,
					managerStatusRevision,
					managerHeartbeatDeadline,
					requireTeamValue: request.sort === "TEAM_VALUE",
					requireEventTeamIds: request.teamCountRules.length > 0,
				});
			let fullFieldBoard = false;
			let board;
			if (fullFieldDataReady) {
				try {
					board = await getOrBuildEntryLiveCompetitionBoard(
						context,
						makeCacheKey(rosterRevision, "FULL_FIELD"),
						async () => {
							const [entries, picks, eventResults] = await Promise.all([
								Promise.resolve(rosterEntries),
								entryLiveRepository.getEntryEventPicksByIds(context, allEntryIds, request.eventId),
								event.finished && event.dataChecked
									? entriesService.getEntryEventResultsByEntryIds(
											context,
											allEntryIds,
											request.eventId
										)
									: Promise.resolve(undefined),
							]);
							const playerIds = Array.from(
								new Set(
									Array.from(picks.values()).flatMap((pick) =>
										pick.picks.map((selected) => selected.element)
									)
								)
							);
							const [players, eventPlayers] = await Promise.all([
								playersService.getPlayersByIdsForEvent(context, playerIds, request.eventId),
								getPlayerAndTeamMaps(
									context,
									playerIds,
									request.eventId,
									context.currentSeason.seasonCode
								),
							]);
							if (request.teamCountRules.length > 0 && !eventPlayers.eventTeamResolutionComplete) {
								throw new Error("Event-scoped team metadata unavailable for full-field filters");
							}
							return buildFullFieldLiveBoardIndex({
								...cacheIdentity,
								managerRows: managerScores.rows,
								freshnessCheckedAt: managerFreshnessCheckedAt,
								allEntryIds,
								entries,
								eventResults,
								picks,
								players,
								playerTeamIds: eventPlayers.eventTeamResolutionComplete
									? new Map(
											Array.from(eventPlayers.playerMap.entries()).map(([id, player]) => [
												id,
												player.team_id,
											])
										)
									: undefined,
								managerRevision,
								rosterRevision,
								requireNet,
								allowFinalNoCaptainBoost: event.finished && event.dataChecked,
								requireEventTeamValue: event.finished && event.dataChecked,
								requireTeamValue: request.sort === "TEAM_VALUE",
							});
						}
					);
					fullFieldBoard = true;
				} catch (error) {
					context.logger.warn(
						{ err: error, eventId: request.eventId, tournamentId: request.tournamentId },
						"Full-field live board index unavailable; falling back to bounded window"
					);
				}
			}
			if (!board) {
				board = await getOrBuildEntryLiveCompetitionBoard(
					context,
					makeCacheKey(windowRevision, "BOUNDED"),
					async () => {
						const result = await entryLiveBatchService.calcLivePointsForEntries(
							context,
							request.eventId,
							entryIds,
							{
								entriesById: rosterEntries,
								tournamentId: request.tournamentId,
								managerScores,
								managerReadMode: "CACHE_ONLY",
								...(managerLiveRef ? { liveRef: managerLiveRef } : {}),
								allowLastGoodManagerScores: managerNeedsLastGoodDetailFence,
							}
						);
						const rankedRows = rankTournamentRowsByOfficialEventPoints(
							Array.from(result.results.values()),
							{ useNet: requireNet }
						);
						const eventResults =
							event.finished && event.dataChecked
								? await entriesService.getEntryEventResultsByEntryIds(
										context,
										entryIds,
										request.eventId
									)
								: undefined;
						const playerIds = Array.from(
							new Set(rankedRows.flatMap((row) => row.pickList.map((pick) => pick.element)))
						);
						let eventTeamIds: ReadonlyMap<number, number> | undefined;
						if (playerIds.length > 0) {
							const eventPlayers = await getPlayerAndTeamMaps(
								context,
								playerIds,
								request.eventId,
								context.currentSeason.seasonCode
							);
							if (request.teamCountRules.length > 0 && !eventPlayers.eventTeamResolutionComplete) {
								throw new Error("Event-scoped team metadata unavailable for board filters");
							}
							eventTeamIds = eventPlayers.eventTeamResolutionComplete
								? new Map(
										Array.from(eventPlayers.playerMap.entries()).map(([id, player]) => [
											id,
											player.team_id,
										])
									)
								: undefined;
						}
						return buildEntryLiveCompetitionBoard({
							...cacheIdentity,
							windowRevision,
							eventTeamIds,
							eventResults,
							rows: rankedRows,
							totalEntries: allEntryIds.length,
							failedEntryIds: result.errors.map((error) => error.entryId),
							unavailableEntryIds: deferredEntryIds,
							requireNet,
						});
					}
				);
			}

			let page = queryEntryLiveCompetitionBoard(board, request);
			let calculatedFailedEntryIds = board.failedEntryIds;
			// A last-good full-field index already contains the authoritative durable
			// headline and filter data. Do not issue a second per-page calculation
			// against the moving live snapshot: that would reintroduce source skew,
			// turn rows into unavailable, and enqueue needless refresh work.
			if (fullFieldBoard && !managerNeedsLastGoodDetailFence) {
				const pageEntryIds = Array.from(
					new Set([
						...page.rows.map((row) => row.entry),
						...(page.viewerRow ? [page.viewerRow.entry] : []),
					])
				);
				try {
					const calculated = await entryLiveBatchService.calcLivePointsForEntries(
						context,
						request.eventId,
						pageEntryIds,
						{
							entriesById: rosterEntries,
							tournamentId: request.tournamentId,
							managerScores,
							managerReadMode: "CACHE_ONLY",
							...(managerLiveRef ? { liveRef: managerLiveRef } : {}),
							allowLastGoodManagerScores: managerNeedsLastGoodDetailFence,
						}
					);
					const calculatedFailed = calculated.errors.map((error) => error.entryId);
					const calculatedIds = new Set(calculated.results.keys());
					calculatedFailedEntryIds = Array.from(
						new Set([
							...calculatedFailed,
							...pageEntryIds.filter((entryId) => !calculatedIds.has(entryId)),
						])
					).sort((left, right) => left - right);
					const enrich = (row: (typeof page.rows)[number]) => {
						const calculatedRow = calculated.results.get(row.entry);
						if (!calculatedRow) return row;
						return enrichEntryLiveCompetitionBoardRow(row, calculatedRow);
					};
					page = {
						...page,
						rows: page.rows.map(enrich),
						viewerRow: page.viewerRow ? enrich(page.viewerRow) : null,
					};
				} catch (error) {
					calculatedFailedEntryIds = pageEntryIds;
					context.logger.warn(
						{ err: error, eventId: request.eventId, tournamentId: request.tournamentId },
						"Full-field live page calculation failed"
					);
				}
			}
			const managerCoverageState = managerScores.tournamentCoverage?.state;
			const effectiveDeferredEntryIds = fullFieldBoard ? [] : deferredEntryIds;
			const derivedCoverageState =
				managerCoverageState ??
				(board.rows.length === board.totalEntries &&
				board.failedEntryIds.length === 0 &&
				effectiveDeferredEntryIds.length === 0
					? "COMPLETE"
					: board.rows.length > 0
						? "PARTIAL"
						: "UNAVAILABLE");
			const coverageState =
				fullFieldBoard &&
				managerScoreLoadHasCompleteRows(managerScores, allEntryIds) &&
				board.rows.length === board.totalEntries &&
				board.officialCoverage === 1 &&
				board.unavailableEntryIds.length === 0 &&
				((event.finished && event.dataChecked) ||
					managerFreshnessCheckedAt !== null ||
					managerUsingLastGood)
					? "COMPLETE"
					: derivedCoverageState === "WARMING" ||
						  derivedCoverageState === "COMPLETE" ||
						  derivedCoverageState === "PARTIAL"
						? derivedCoverageState
						: "UNAVAILABLE";
			const fullFieldReady =
				fullFieldBoard &&
				coverageState === "COMPLETE" &&
				managerScoreLoadHasCompleteRows(managerScores, allEntryIds) &&
				board.rows.length === board.totalEntries &&
				board.officialCoverage === 1 &&
				board.unavailableEntryIds.length === 0 &&
				((event.finished && event.dataChecked) || managerRowsAreCurrent || managerUsingLastGood);
			const deferredIds = new Set(effectiveDeferredEntryIds);
			const failedIds = new Set(calculatedFailedEntryIds);
			const unavailableEntryCount = board.unavailableEntryIds.filter(
				(entryId) => !deferredIds.has(entryId) && !failedIds.has(entryId)
			).length;
			const dataAvailability = classifyEntryLiveCompetitionDataAvailability({
				eventId: request.eventId,
				anchorEventId: window.anchorEventId,
				anchorDataAvailability: window.dataAvailability,
				currentEventId: eventCore.currentEventId,
				finished: event.finished,
				dataChecked: event.dataChecked,
				snapshotAvailable: Boolean(snapshot),
			});
			return {
				season: context.currentSeason.seasonCode,
				eventId: request.eventId,
				tournamentId: request.tournamentId,
				boardRevision: board.boardRevision,
				playerRevision: board.playerRevision,
				managerRevision: board.managerRevision,
				dataAvailability,
				managerDataAvailability:
					managerFreshnessCheckedAt !== null
						? "FRESH"
						: managerUsingLastGood
							? "LAST_GOOD"
							: managerScores.dataAvailability,
				managerServedFrom: managerScores.servedFrom,
				managerRefreshQueued: managerScores.refreshQueued,
				managerCheckedAt: managerFreshnessCheckedAt ?? managerScores.checkedAt,
				managerNextRefreshAt:
					managerFreshnessCheckedAt !== null
						? managerScoreHeartbeatRefreshDeadline(managerFreshnessCheckedAt, window.nextRefreshAt)
						: managerScores.nextRefreshAt,
				coverageState,
				rankScope: fullFieldReady ? "FULL_FIELD" : "AVAILABLE_ROWS",
				computedEntries: board.rows.length,
				deferredEntryCount: effectiveDeferredEntryIds.length,
				failedEntryCount: calculatedFailedEntryIds.length,
				unavailableEntryCount,
				officialCoverage: board.officialCoverage,
				unavailableEntryIds: board.unavailableEntryIds,
				failedEntryIds: calculatedFailedEntryIds,
				partial:
					board.partial ||
					calculatedFailedEntryIds.length > 0 ||
					effectiveDeferredEntryIds.length > 0 ||
					board.unavailableEntryIds.length > 0,
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
				metrics.livePublicationEventsTotal.labels("revision_gone").inc();
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
				metrics.livePublicationEventsTotal.labels("revision_gone").inc();
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
			const rosterEntryIds = await tournamentsService.getTournamentEntryIds(context, selected);
			const eligibility = await loadTournamentEventEligibility(
				rosterEntryIds,
				eventId,
				(entryIds) => entriesService.getEntriesByIds(context, entryIds)
			);
			const allEntryIds = eligibility.entryIds;
			const rosterEntries = eligibility.entriesById;
			const { entryIds: boundedEntryIds, deferredEntryIds: boundedDeferredEntryIds } =
				selectTournamentDeskEntryWindow(allEntryIds, args.entryId);
			// The legacy desk is still the initial load path for tournament detail
			// pages. It must not silently stop at the 500-entry preview used by the
			// paged board API. Normal requests calculate the complete eligible cohort
			// in bounded chunks; an explicit immutable ref remains bounded so the
			// caller's historical contract cannot turn into an unbounded read.
			const calculationEntryIds = args.ref ? boundedEntryIds : allEntryIds;
			const deferredEntryIds = args.ref ? boundedDeferredEntryIds : [];
			// Manager scores have an independent revision from the player-live
			// publication. Do not serve a provisional board cache keyed only by the
			// player revision, and never accept a finalized cache whose row count no
			// longer covers the current eligible tournament cohort.
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
			const eligibleEntryIdSet = new Set(allEntryIds);
			const cachedRowsMatchEligibility =
				cachedRows !== undefined &&
				cachedRows.length === eligibleEntryIdSet.size &&
				new Set(cachedRows.map((row) => row.entry)).size === eligibleEntryIdSet.size &&
				cachedRows.every((row) => eligibleEntryIdSet.has(row.entry));
			const cachedBoard =
				cachedCandidate &&
				cachedRows &&
				cachedRowsMatchEligibility &&
				cachedCandidate.totalEntries === cachedRows.length &&
				cachedCandidate.totalEntries === allEntryIds.length &&
				managerScoreBoardIsFinal(cachedRows)
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
			const result = await calcLivePointsForEntriesInChunks(context, eventId, calculationEntryIds, {
				entriesById: rosterEntries,
				tournamentId: selected,
				managerReadMode: "CACHE_ONLY",
				...(args.ref && snapshot?.publicationId
					? {
							liveRef: {
								publicationId: snapshot.publicationId,
								revision: snapshot.revision,
							},
						}
					: {}),
			});
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
				partial:
					result.errors.length > 0 || deferredEntryIds.length > 0 || unavailableEntryIds.length > 0,
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
			const eventMaps = await getPlayerAndTeamMaps(
				context,
				rows.map((row) => row.playerId),
				snapshot.eventId,
				context.currentSeason.seasonCode
			);
			if (!eventMaps.eventTeamResolutionComplete) {
				throw new Error("Historical player team metadata unavailable for selection index");
			}
			return {
				tournamentId: args.tournamentId,
				eventId: snapshot.eventId,
				revision: snapshot.revision,
				rows: rows.map((row) => {
					const player = eventMaps.playerMap.get(row.playerId);
					const eventTeam = player ? eventMaps.teamMap.get(player.team_id) : undefined;
					if (!player || !eventTeam) {
						throw new Error(`Historical selection metadata unavailable for player ${row.playerId}`);
					}
					return {
						...row,
						playerName: player.web_name,
						teamId: player.team_id,
						teamName: eventTeam.name,
						teamShortName: eventTeam.short_name,
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
			const { snapshot } = await resolveSnapshot(context, args.ref);
			const ids = Array.from(new Set([args.entryId, ...args.comparedEntryIds])).slice(0, 2);
			const result = await entryLiveBatchService.calcLivePointsForEntries(
				context,
				snapshot.eventId,
				ids,
				{
					tournamentId: args.tournamentId,
					managerReadMode: "CACHE_ONLY",
					...(snapshot.publicationId
						? {
								liveRef: {
									publicationId: snapshot.publicationId,
									revision: snapshot.revision,
								},
							}
						: {}),
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
