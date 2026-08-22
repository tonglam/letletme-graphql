import type {
	CoreEventData,
	CoreFixtureData,
	DataSnapshotSource,
	LiveLifecycleState as ProducerLifecycleState,
	LiveSnapshotState,
} from "../../infra/data-snapshot";

export type LiveWindowState =
	| "PRESEASON"
	| "EVENT_SCHEDULED"
	| "LIVE_ACTIVE"
	| "DAY_SETTLING"
	| "BETWEEN_FIXTURES"
	| "GW_REVIEW"
	| "FINALIZED"
	| "BETWEEN_GAMEWEEKS"
	| "OFFSEASON";

export type LiveDataAvailability =
	"SCHEDULED" | "FRESH" | "LAST_GOOD" | "FINAL" | "PARTIAL" | "UNAVAILABLE";

export type LiveAnchorMode = "UPCOMING" | "CURRENT" | "PREVIOUS_FINAL" | "OFFSEASON";

export type LiveWindowInput = {
	events: readonly CoreEventData[];
	fixtures: readonly CoreFixtureData[];
	currentEventId: number | null;
	nextEventId: number | null;
	liveRevision: string | null;
	publicationId?: string | null;
	liveEventId?: number | null;
	publicationState?: LiveSnapshotState | null;
	sourceCheckedAt: string | null;
	publishedAt: string | null;
	source: DataSnapshotSource | null;
	lifecycleEventId?: number | null;
	lifecycleState?: ProducerLifecycleState | null;
	lifecycleObservedAt?: string | null;
	lifecycleNextRefreshAt?: string | null;
	lifecycleLiveRevision?: string | null;
	lifecyclePublicationId?: string | null;
	lifecycleSourceCheckedAt?: string | null;
	now?: Date;
};

export type LiveWindow = {
	anchorEventId: number | null;
	latestFinalizedEventId: number | null;
	currentEventId: number | null;
	nextEventId: number | null;
	windowState: LiveWindowState;
	producerState:
		| "PRE_DEADLINE"
		| "PICKS_WAIT"
		| "PICKS_PROBE"
		| "PICKS_SYNC"
		| "LIVE_ACTIVE"
		| "BETWEEN_FIXTURES"
		| "DAY_SETTLING"
		| "GW_REVIEW"
		| "FINALIZED";
	anchorMode: LiveAnchorMode;
	dataAvailability: LiveDataAvailability;
	liveRevision: string | null;
	sourceCheckedAt: string | null;
	publishedAt: string | null;
	source: DataSnapshotSource | null;
	stale: boolean;
	nextRefreshAt: string | null;
};

const hasStarted = (fixtures: readonly CoreFixtureData[]): boolean =>
	fixtures.some(
		(fixture) => fixture.started === true || fixture.finished || fixture.finishedProvisional
	);

const isFinished = (fixtures: readonly CoreFixtureData[]): boolean =>
	fixtures.length > 0 &&
	fixtures.every((fixture) => fixture.finished || fixture.finishedProvisional);

const hasActive = (fixtures: readonly CoreFixtureData[]): boolean =>
	fixtures.some(
		(fixture) => fixture.started === true && !fixture.finished && !fixture.finishedProvisional
	);

const hasFutureFixture = (fixtures: readonly CoreFixtureData[], nowMs: number): boolean =>
	fixtures.some(
		(fixture) =>
			!fixture.finished &&
			!fixture.finishedProvisional &&
			fixture.started !== true &&
			(fixture.kickoffTime ? Date.parse(fixture.kickoffTime) : Number.POSITIVE_INFINITY) > nowMs
	);

const lastObservedKickoff = (fixtures: readonly CoreFixtureData[]): number | null => {
	const values = fixtures
		.filter(
			(fixture) => fixture.started === true || fixture.finished || fixture.finishedProvisional
		)
		.map((fixture) => (fixture.kickoffTime ? Date.parse(fixture.kickoffTime) : Number.NaN))
		.filter(Number.isFinite);
	return values.length > 0 ? Math.max(...values) : null;
};

const refreshSeconds: Record<LiveWindowState, number> = {
	PRESEASON: 900,
	EVENT_SCHEDULED: 300,
	LIVE_ACTIVE: 30,
	DAY_SETTLING: 60,
	BETWEEN_FIXTURES: 300,
	GW_REVIEW: 600,
	FINALIZED: 900,
	BETWEEN_GAMEWEEKS: 900,
	OFFSEASON: 1800,
};

const staleAfterMsForWindow = (state: LiveWindowState): number => {
	switch (state) {
		case "LIVE_ACTIVE":
			return 90_000;
		case "DAY_SETTLING":
			return 180_000;
		case "BETWEEN_FIXTURES":
			// The producer intentionally polls this quiet interval every five
			// minutes. Add a bounded queue/clock margin without hiding a stalled
			// active-match producer behind the same threshold.
			return 6 * 60_000;
		default:
			return 60_000;
	}
};
const lifecycleStatusGraceMs = 2 * 60_000;

const lifecycleWindowState = (
	state: ProducerLifecycleState,
	current: LiveWindowState
): LiveWindowState => {
	switch (state) {
		case "LIVE_ACTIVE":
			return "LIVE_ACTIVE";
		case "DAY_SETTLING":
			return "DAY_SETTLING";
		case "BETWEEN_FIXTURES":
			return "BETWEEN_FIXTURES";
		case "GW_REVIEW":
			return "GW_REVIEW";
		case "FINALIZED":
			return current === "BETWEEN_GAMEWEEKS" || current === "OFFSEASON" ? current : "FINALIZED";
		case "PRE_DEADLINE":
			return "PRESEASON";
		case "PICKS_WAIT":
		case "PICKS_PROBE":
		case "PICKS_SYNC":
			return current === "PRESEASON" ? "EVENT_SCHEDULED" : current;
	}
};

export const resolveLiveWindow = (input: LiveWindowInput): LiveWindow => {
	const now = input.now ?? new Date();
	const nowMs = now.getTime();
	const events = [...input.events].sort((a, b) => a.id - b.id);
	const byEvent = new Map<number, CoreFixtureData[]>();
	for (const fixture of input.fixtures) {
		if (fixture.eventId === null) continue;
		const rows = byEvent.get(fixture.eventId) ?? [];
		rows.push(fixture);
		byEvent.set(fixture.eventId, rows);
	}
	const finalized = events.filter(
		(event) => event.finished && event.dataChecked && isFinished(byEvent.get(event.id) ?? [])
	);
	const latestFinalized = finalized.at(-1)?.id ?? null;
	const startedEvents = events.filter((event) => hasStarted(byEvent.get(event.id) ?? []));
	const activeEvent = startedEvents.find((event) => hasActive(byEvent.get(event.id) ?? [])) ?? null;
	const currentEvent = input.currentEventId
		? (events.find((event) => event.id === input.currentEventId) ?? null)
		: null;
	const currentFixtures = currentEvent ? (byEvent.get(currentEvent.id) ?? []) : [];
	const currentHasStarted = hasStarted(currentFixtures);
	const currentIsSettled = isFinished(currentFixtures);
	const currentHasFuture = hasFutureFixture(currentFixtures, nowMs);
	const seasonFinalized =
		events.length > 0 &&
		events.every(
			(event) => event.finished && event.dataChecked && isFinished(byEvent.get(event.id) ?? [])
		);
	const currentDeadlineMs = currentEvent?.deadlineTime
		? Date.parse(currentEvent.deadlineTime)
		: Number.NaN;
	const publicationEvent = input.liveEventId
		? (events.find((event) => event.id === input.liveEventId) ?? null)
		: null;
	const previousPublicationDuringGap = Boolean(
		publicationEvent &&
		input.currentEventId !== null &&
		publicationEvent.id !== input.currentEventId &&
		currentEvent &&
		!currentHasStarted &&
		!currentIsSettled
	);

	let anchorEventId: number | null = null;
	let anchorMode: LiveAnchorMode = "OFFSEASON";
	let windowState: LiveWindowState = "OFFSEASON";

	if (previousPublicationDuringGap && publicationEvent) {
		// A still-readable previous publication must not make the next scheduled
		// gameweek appear active before its first fixture has actually started.
		// Keep the previous event as the cross-gameweek anchor until core observes
		// a real start in the next event.
		anchorEventId = publicationEvent.id;
		anchorMode = "PREVIOUS_FINAL";
		windowState =
			input.publicationState === "settled" &&
			publicationEvent.finished &&
			publicationEvent.dataChecked
				? "BETWEEN_GAMEWEEKS"
				: "GW_REVIEW";
	} else if (publicationEvent && input.publicationState === "live") {
		anchorEventId = publicationEvent.id;
		anchorMode = publicationEvent.id === input.currentEventId ? "CURRENT" : "PREVIOUS_FINAL";
		windowState = "LIVE_ACTIVE";
	} else if (publicationEvent && input.publicationState === "settled") {
		anchorEventId = publicationEvent.id;
		anchorMode = publicationEvent.id === input.currentEventId ? "CURRENT" : "PREVIOUS_FINAL";
		windowState =
			publicationEvent.finished && publicationEvent.dataChecked ? "FINALIZED" : "GW_REVIEW";
	} else if (activeEvent) {
		anchorEventId = activeEvent.id;
		anchorMode = "CURRENT";
		windowState = "LIVE_ACTIVE";
	} else if (currentEvent && currentHasStarted && !currentIsSettled) {
		anchorEventId = currentEvent.id;
		anchorMode = "CURRENT";
		const lastKickoff = lastObservedKickoff(currentFixtures);
		windowState =
			lastKickoff !== null && nowMs - lastKickoff < 10 * 60_000
				? "DAY_SETTLING"
				: currentHasFuture
					? "BETWEEN_FIXTURES"
					: "GW_REVIEW";
	} else if (
		currentEvent &&
		currentHasStarted &&
		currentIsSettled &&
		!(currentEvent.finished && currentEvent.dataChecked)
	) {
		anchorEventId = currentEvent.id;
		anchorMode = "CURRENT";
		windowState = "GW_REVIEW";
	} else if (
		currentEvent &&
		!currentHasStarted &&
		latestFinalized === null &&
		!currentEvent.finished
	) {
		// GW1 (or a newly loaded season) may have a deadline-derived current
		// event before the first fixture lifecycle flag is observed. It is still
		// the scheduled event; do not jump to the next event or manufacture a
		// live revision from the deadline alone.
		anchorEventId = currentEvent.id;
		anchorMode = "UPCOMING";
		windowState =
			Number.isFinite(currentDeadlineMs) && nowMs < currentDeadlineMs
				? "PRESEASON"
				: "EVENT_SCHEDULED";
	} else if (seasonFinalized && latestFinalized !== null) {
		// After the last finalized event there is no next gameweek to anchor.
		// Keep the final event available for historical desks, but expose the
		// season boundary explicitly so clients stop polling as if a GW were live.
		anchorEventId = latestFinalized;
		anchorMode = "OFFSEASON";
		windowState = "OFFSEASON";
	} else if (latestFinalized !== null) {
		anchorEventId = latestFinalized;
		anchorMode = "PREVIOUS_FINAL";
		windowState = "BETWEEN_GAMEWEEKS";
	} else if (input.nextEventId !== null || currentEvent) {
		anchorEventId = input.nextEventId ?? currentEvent?.id ?? null;
		anchorMode = anchorEventId === null ? "OFFSEASON" : "UPCOMING";
		windowState = anchorEventId === null ? "OFFSEASON" : "PRESEASON";
	}

	const anchorEvent = anchorEventId
		? (events.find((event) => event.id === anchorEventId) ?? null)
		: null;
	const anchorFixtures = anchorEventId ? (byEvent.get(anchorEventId) ?? []) : [];
	if (
		windowState === "BETWEEN_GAMEWEEKS" &&
		anchorEvent &&
		!(anchorEvent.finished && anchorEvent.dataChecked)
	) {
		windowState = "GW_REVIEW";
	}
	if (windowState === "BETWEEN_GAMEWEEKS" && anchorFixtures.length === 0) {
		windowState = "OFFSEASON";
		anchorMode = "OFFSEASON";
	}
	const lifecycleState = input.lifecycleState;
	const lifecycleObservedAtMs = input.lifecycleObservedAt
		? Date.parse(input.lifecycleObservedAt)
		: Number.NaN;
	const lifecycleNextRefreshAtMs = input.lifecycleNextRefreshAt
		? Date.parse(input.lifecycleNextRefreshAt)
		: Number.NaN;
	const lifecycleIsFresh =
		Number.isFinite(lifecycleObservedAtMs) &&
		lifecycleObservedAtMs <= nowMs + 30_000 &&
		(Number.isFinite(lifecycleNextRefreshAtMs)
			? nowMs <= lifecycleNextRefreshAtMs + lifecycleStatusGraceMs
			: nowMs - lifecycleObservedAtMs <= lifecycleStatusGraceMs);
	const sourceCheckedAt = input.sourceCheckedAt;
	const checkedAtMs = sourceCheckedAt ? Date.parse(sourceCheckedAt) : Number.NaN;
	const lifecycleSourceCheckedAtMs = input.lifecycleSourceCheckedAt
		? Date.parse(input.lifecycleSourceCheckedAt)
		: Number.NaN;
	const lifecycleMatchesPublication = (() => {
		if (input.liveRevision === null && !input.publicationId) return true;
		if (input.publicationId && input.lifecyclePublicationId) {
			return input.publicationId === input.lifecyclePublicationId;
		}
		if (input.liveRevision !== null && input.lifecycleLiveRevision) {
			return input.liveRevision === input.lifecycleLiveRevision;
		}
		return (
			Number.isFinite(checkedAtMs) &&
			Number.isFinite(lifecycleSourceCheckedAtMs) &&
			lifecycleSourceCheckedAtMs >= checkedAtMs
		);
	})();
	const liveSnapshotIsFresh =
		input.publicationState === "live" &&
		Number.isFinite(checkedAtMs) &&
		nowMs - checkedAtMs <= staleAfterMsForWindow("LIVE_ACTIVE");
	const liveSnapshotHasActiveFixture =
		liveSnapshotIsFresh && input.liveEventId === anchorEventId && hasActive(anchorFixtures);
	const lifecycleApplies =
		input.lifecycleEventId === anchorEventId &&
		lifecycleState !== null &&
		lifecycleState !== undefined &&
		lifecycleIsFresh &&
		lifecycleMatchesPublication &&
		!liveSnapshotHasActiveFixture;
	if (lifecycleApplies) {
		windowState = lifecycleWindowState(lifecycleState!, windowState);
	}

	const resolvedWindowState = ((value: string): LiveWindowState => value as LiveWindowState)(
		windowState
	);
	const producerState: LiveWindow["producerState"] = (() => {
		if (lifecycleApplies) return lifecycleState!;
		switch (resolvedWindowState) {
			case "PRESEASON":
				return "PRE_DEADLINE";
			case "EVENT_SCHEDULED":
				return "PICKS_PROBE";
			case "BETWEEN_GAMEWEEKS":
			case "FINALIZED":
			case "OFFSEASON":
				return "FINALIZED";
			default:
				return resolvedWindowState;
		}
	})();
	const staleAfterMs = staleAfterMsForWindow(resolvedWindowState);
	const sourceIsFresh = Number.isFinite(checkedAtMs) && nowMs - checkedAtMs <= staleAfterMs;
	const dataAvailability: LiveDataAvailability = (() => {
		switch (resolvedWindowState) {
			case "PRESEASON":
			case "EVENT_SCHEDULED":
				return "SCHEDULED";
			case "FINALIZED":
			case "BETWEEN_GAMEWEEKS":
			case "OFFSEASON":
				return "FINAL";
			default:
				return input.liveRevision ? (sourceIsFresh ? "FRESH" : "LAST_GOOD") : "UNAVAILABLE";
		}
	})();
	const stale = !sourceIsFresh;
	const persistedRefreshAtMs = input.lifecycleNextRefreshAt
		? Date.parse(input.lifecycleNextRefreshAt)
		: Number.NaN;
	// A worker restart or a delayed lifecycle tick can leave the persisted
	// checkpoint behind the current clock. Never hand clients an overdue timer:
	// that would make every visible page refetch immediately in a tight loop.
	const refreshAt =
		lifecycleApplies && Number.isFinite(persistedRefreshAtMs) && persistedRefreshAtMs > nowMs
			? new Date(persistedRefreshAtMs).toISOString()
			: anchorEventId === null
				? null
				: new Date(nowMs + refreshSeconds[windowState] * 1000).toISOString();

	return {
		anchorEventId,
		latestFinalizedEventId: latestFinalized,
		currentEventId: input.currentEventId,
		nextEventId: input.nextEventId,
		windowState,
		producerState,
		anchorMode,
		dataAvailability,
		liveRevision: input.liveRevision,
		sourceCheckedAt,
		publishedAt: input.publishedAt,
		source: input.source,
		stale,
		nextRefreshAt: refreshAt,
	};
};
