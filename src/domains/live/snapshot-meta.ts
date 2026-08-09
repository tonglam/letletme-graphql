import type { GraphQLContext } from "../../graphql/context";
import { getCurrentSeason } from "../../infra/season";

export type LiveSnapshotState = "scheduled" | "live" | "settled";

export type LiveSnapshotMeta = {
	schemaVersion: 1;
	season: string;
	eventId: number;
	revision: string;
	state: LiveSnapshotState;
	publishedAt: string;
	checkedAt: string;
	eventLiveCount: number;
	fixtureCount: number;
	fixtureTeamCount: number;
	bonusTeamCount: number;
};

const snapshotMemo = new WeakMap<GraphQLContext, Map<string, Promise<LiveSnapshotMeta | null>>>();

type LiveSnapshotOperationState = {
	activeReaders: number;
	candidateRevision: string | null | undefined;
	databaseFallback: boolean;
	finalMeta: LiveSnapshotMeta | null | undefined;
	finalMetaLoading: Promise<LiveSnapshotMeta | null> | null;
	waiters: Set<() => void>;
};

const operationStates = new WeakMap<GraphQLContext, Map<number, LiveSnapshotOperationState>>();

type LiveSnapshotRootState = {
	activeResolvers: number;
	pendingFirstPasses: number;
	barrierWaiters: Set<() => void>;
	completionWaiters: Set<() => void>;
};

const rootStates = new WeakMap<GraphQLContext, LiveSnapshotRootState>();

const getRootState = (context: GraphQLContext): LiveSnapshotRootState => {
	let state = rootStates.get(context);
	if (!state) {
		state = {
			activeResolvers: 0,
			pendingFirstPasses: 0,
			barrierWaiters: new Set(),
			completionWaiters: new Set(),
		};
		rootStates.set(context, state);
	}
	return state;
};

const completeRootFirstPass = (state: LiveSnapshotRootState): void => {
	if (state.pendingFirstPasses <= 0) return;
	state.pendingFirstPasses -= 1;
	if (state.pendingFirstPasses === 0) {
		for (const resolve of state.barrierWaiters) resolve();
		state.barrierWaiters.clear();
	}
};

const waitForSiblingRootFirstPasses = async (context: GraphQLContext): Promise<void> => {
	// GraphQL invokes every sibling root before promise continuations run. Yield
	// once so even a cache-hot first reader observes the complete root set.
	await Promise.resolve();
	const state = getRootState(context);
	if (state.pendingFirstPasses <= 0) return;
	completeRootFirstPass(state);
	if (state.pendingFirstPasses > 0) {
		await new Promise<void>((resolve) => state.barrierWaiters.add(resolve));
	}
};

const getOperationState = (
	context: GraphQLContext,
	eventId: number
): LiveSnapshotOperationState => {
	let byEvent = operationStates.get(context);
	if (!byEvent) {
		byEvent = new Map();
		operationStates.set(context, byEvent);
	}
	let state = byEvent.get(eventId);
	if (!state) {
		state = {
			activeReaders: 0,
			candidateRevision: undefined,
			databaseFallback: false,
			finalMeta: undefined,
			finalMetaLoading: null,
			waiters: new Set(),
		};
		byEvent.set(eventId, state);
	}
	return state;
};

export class LiveSnapshotCoherenceError extends Error {
	readonly eventId: number;
	readonly view: string;

	constructor(eventId: number, view: string, message: string) {
		super(message);
		this.name = "LiveSnapshotCoherenceError";
		this.eventId = eventId;
		this.view = view;
	}
}

export const isLiveSnapshotConsistencyActive = (
	context: GraphQLContext,
	eventId: number
): boolean => getOperationState(context, eventId).activeReaders > 0;

export const isLiveSnapshotDatabaseFallback = (context: GraphQLContext, eventId: number): boolean =>
	getOperationState(context, eventId).databaseFallback;

/**
 * Register a live root field before it performs asynchronous current-event
 * discovery. This closes the small window where the sibling liveSnapshot
 * field could otherwise resolve metadata before the calculation registers its
 * event-specific consistency reader.
 */
export const withLiveSnapshotRoot = async <T>(
	context: GraphQLContext,
	run: () => Promise<T>
): Promise<T> => {
	const state = getRootState(context);
	state.activeResolvers += 1;
	state.pendingFirstPasses += 1;
	try {
		return await run();
	} finally {
		// A root that returns or throws before entering snapshot consistency must
		// still release siblings waiting at the first-pass barrier.
		completeRootFirstPass(state);
		state.activeResolvers -= 1;
		if (state.activeResolvers === 0) {
			for (const resolve of state.completionWaiters) resolve();
			state.completionWaiters.clear();
		}
	}
};

const forceDatabaseFallback = (
	context: GraphQLContext,
	eventId: number,
	error: LiveSnapshotCoherenceError
): void => {
	const state = getOperationState(context, eventId);
	if (!state.databaseFallback) {
		context.logger.warn(
			{ eventId, view: error.view, err: error },
			"Coordinated live view unavailable; retrying the operation from database fallbacks"
		);
	}
	state.databaseFallback = true;
	state.finalMeta = null;
};

const reconcileCandidateRevision = (
	context: GraphQLContext,
	eventId: number,
	meta: LiveSnapshotMeta | null
): void => {
	const state = getOperationState(context, eventId);
	const revision = meta?.revision ?? null;
	if (state.candidateRevision === undefined) {
		state.candidateRevision = revision;
		return;
	}
	if (state.candidateRevision !== revision) {
		forceDatabaseFallback(
			context,
			eventId,
			new LiveSnapshotCoherenceError(
				eventId,
				"LiveSnapshotMeta",
				`Sibling roots completed different revisions: ${state.candidateRevision ?? "none"} and ${revision ?? "none"}`
			)
		);
	}
};

const rememberOperationMeta = (
	state: LiveSnapshotOperationState,
	meta: LiveSnapshotMeta | null
): void => {
	if (state.databaseFallback) {
		state.finalMeta = null;
		return;
	}
	if (!meta) {
		if (state.finalMeta === undefined) state.finalMeta = null;
		return;
	}
	const currentCheckedAt = state.finalMeta ? Date.parse(state.finalMeta.checkedAt) : -1;
	const nextCheckedAt = Date.parse(meta.checkedAt);
	const currentPublishedAt = state.finalMeta ? Date.parse(state.finalMeta.publishedAt) : -1;
	const nextPublishedAt = Date.parse(meta.publishedAt);
	if (
		!state.finalMeta ||
		nextCheckedAt > currentCheckedAt ||
		(nextCheckedAt === currentCheckedAt && nextPublishedAt >= currentPublishedAt)
	) {
		state.finalMeta = meta;
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown, positive = false): value is number =>
	typeof value === "number" && Number.isInteger(value) && (positive ? value > 0 : value >= 0);

const isIsoTimestamp = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

export const parseLiveSnapshotMeta = (
	value: string | null,
	expected?: { season?: string; eventId?: number }
): LiveSnapshotMeta | null => {
	if (!value) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;

	const state = parsed.state;
	if (
		parsed.schemaVersion !== 1 ||
		typeof parsed.season !== "string" ||
		!/^[0-9]{4}$/.test(parsed.season) ||
		!isCount(parsed.eventId, true) ||
		typeof parsed.revision !== "string" ||
		!/^[a-f0-9]{24}$/.test(parsed.revision) ||
		(state !== "scheduled" && state !== "live" && state !== "settled") ||
		!isIsoTimestamp(parsed.publishedAt) ||
		!isIsoTimestamp(parsed.checkedAt) ||
		!isCount(parsed.eventLiveCount, true) ||
		!isCount(parsed.fixtureCount) ||
		!isCount(parsed.fixtureTeamCount) ||
		!isCount(parsed.bonusTeamCount)
	) {
		return null;
	}
	if (expected?.season !== undefined && parsed.season !== expected.season) return null;
	if (expected?.eventId !== undefined && parsed.eventId !== expected.eventId) return null;

	return parsed as LiveSnapshotMeta;
};

export const liveSnapshotMetaKey = (season: string, eventId: number): string =>
	`LiveSnapshotMeta:${season}:${eventId}`;

export const rememberLiveSnapshotMeta = (
	context: GraphQLContext,
	meta: LiveSnapshotMeta | null,
	season: string,
	eventId: number
): void => {
	let memo = snapshotMemo.get(context);
	if (!memo) {
		memo = new Map();
		snapshotMemo.set(context, memo);
	}
	memo.set(`${season}:${eventId}`, Promise.resolve(meta));
};

export const loadLiveSnapshotMeta = async (
	context: GraphQLContext,
	eventId: number,
	options: { season?: string; fresh?: boolean } = {}
): Promise<LiveSnapshotMeta | null> => {
	if (!Number.isInteger(eventId) || eventId <= 0) return null;
	const season = options.season ?? (await getCurrentSeason(context));
	const memoKey = `${season}:${eventId}`;
	let memo = snapshotMemo.get(context);
	if (!memo) {
		memo = new Map();
		snapshotMemo.set(context, memo);
	}
	if (!options.fresh) {
		const cached = memo.get(memoKey);
		if (cached) return cached;
	}
	const load = (async (): Promise<LiveSnapshotMeta | null> => {
		const key = liveSnapshotMetaKey(season, eventId);
		try {
			const raw = await context.redis.get(key);
			const parsed = parseLiveSnapshotMeta(raw, { season, eventId });
			if (raw !== null && parsed === null) {
				context.logger.warn({ key }, "Ignoring malformed live snapshot metadata");
			}
			return parsed;
		} catch (error) {
			context.logger.warn(
				{ err: error, key },
				"Live snapshot metadata unavailable; using bounded legacy fallback"
			);
			return null;
		}
	})();
	// A fresh read is a causal boundary around one calculation. Sharing its
	// in-flight GET with a sibling that starts later can let that sibling reuse
	// metadata captured before its own view reads and accept mixed revisions.
	// Ordinary reads remain request-memoized; every fresh boundary reads Redis.
	memo.set(memoKey, load);
	return load;
};

/**
 * Resolve metadata after every consistency-wrapped sibling root field for the
 * event has settled. GraphQL invokes sibling root resolvers concurrently, so a
 * one-microtask registration window lets this field join their shared
 * operation decision instead of racing an independent metadata read.
 */
export const loadOperationLiveSnapshotMeta = async (
	context: GraphQLContext,
	eventId: number
): Promise<LiveSnapshotMeta | null> => {
	if (!Number.isInteger(eventId) || eventId <= 0) return null;
	await Promise.resolve();
	const rootState = getRootState(context);
	if (rootState.activeResolvers > 0) {
		await new Promise<void>((resolve) => rootState.completionWaiters.add(resolve));
	}
	const state = getOperationState(context, eventId);
	if (state.activeReaders > 0) {
		await new Promise<void>((resolve) => state.waiters.add(resolve));
	}
	if (state.databaseFallback) return null;
	if (state.finalMeta !== undefined) return state.finalMeta;
	if (!state.finalMetaLoading) {
		state.finalMetaLoading = (async (): Promise<LiveSnapshotMeta | null> => {
			const meta = await loadLiveSnapshotMeta(context, eventId, { fresh: true });
			if (state.databaseFallback) {
				state.finalMeta = null;
				return null;
			}
			rememberOperationMeta(state, meta);
			return state.finalMeta ?? null;
		})();
	}
	return state.finalMetaLoading;
};

/**
 * A producer publication is atomic, but a GraphQL operation may issue several
 * Redis reads. Compare the revision around those reads and retry once if the
 * producer committed between them, preventing mixed-minute calculations.
 */
export const withLiveSnapshotConsistency = async <T>(
	context: GraphQLContext,
	eventId: number,
	run: () => Promise<T>,
	options: { participateInRootBarrier?: boolean } = {}
): Promise<T> => {
	const state = getOperationState(context, eventId);
	state.activeReaders += 1;
	let operationMeta: LiveSnapshotMeta | null = null;

	type RunResult = { value: T; databaseFallback: boolean };
	const runWithCoherentFallback = async (): Promise<RunResult> => {
		const startedInFallback = state.databaseFallback;
		try {
			const value = await run();
			// A concurrent sibling may have found a broken coordinated view while
			// this run was reading Redis. Discard that result and join its DB mode.
			if (!startedInFallback && state.databaseFallback) {
				return { value: await run(), databaseFallback: true };
			}
			return { value, databaseFallback: startedInFallback };
		} catch (error) {
			if (!(error instanceof LiveSnapshotCoherenceError) || error.eventId !== eventId) {
				throw error;
			}
			forceDatabaseFallback(context, eventId, error);
			return { value: await run(), databaseFallback: true };
		}
	};

	const finalize = async (result: RunResult, meta: LiveSnapshotMeta | null): Promise<T> => {
		operationMeta = state.databaseFallback ? null : meta;
		if (!state.databaseFallback) {
			reconcileCandidateRevision(context, eventId, meta);
			if (state.databaseFallback) operationMeta = null;
		}

		// No root may expose its candidate until every sibling live root has
		// reached the same point. The last arrival reconciles revisions/fallback,
		// then every earlier candidate can be discarded before GraphQL sees it.
		if (options.participateInRootBarrier !== false) {
			await waitForSiblingRootFirstPasses(context);
		}
		if (state.databaseFallback && !result.databaseFallback) {
			operationMeta = null;
			return run();
		}
		return result.value;
	};

	try {
		const before = state.databaseFallback
			? null
			: await loadLiveSnapshotMeta(context, eventId, { fresh: true });
		operationMeta = before;
		const first = await runWithCoherentFallback();
		if (state.databaseFallback) {
			return finalize(first, null);
		}

		const after = await loadLiveSnapshotMeta(context, eventId, { fresh: true });
		if (state.databaseFallback) {
			return finalize(first, null);
		}
		if (before && !after) {
			forceDatabaseFallback(
				context,
				eventId,
				new LiveSnapshotCoherenceError(
					eventId,
					"LiveSnapshotMeta",
					`Snapshot metadata for revision ${before.revision} disappeared during the read`
				)
			);
			return finalize(first, null);
		}
		operationMeta = after ?? operationMeta;
		if (!after || before?.revision === after.revision) {
			return finalize(first, operationMeta);
		}

		context.logger.info(
			{ eventId, beforeRevision: before?.revision ?? null, afterRevision: after.revision },
			"Live snapshot advanced during request; retrying once"
		);
		const retried = await runWithCoherentFallback();
		if (state.databaseFallback) {
			return finalize(retried, null);
		}
		const finalMeta = await loadLiveSnapshotMeta(context, eventId, { fresh: true });
		if (state.databaseFallback) {
			return finalize(retried, null);
		}
		if (!finalMeta) {
			forceDatabaseFallback(
				context,
				eventId,
				new LiveSnapshotCoherenceError(
					eventId,
					"LiveSnapshotMeta",
					`Snapshot metadata for revision ${after.revision} disappeared during retry`
				)
			);
			return finalize(retried, null);
		}
		operationMeta = finalMeta;
		if (finalMeta.revision !== after.revision) {
			forceDatabaseFallback(
				context,
				eventId,
				new LiveSnapshotCoherenceError(
					eventId,
					"LiveSnapshotMeta",
					`Snapshot advanced from ${after.revision} to ${finalMeta.revision} during retry`
				)
			);
			return finalize(retried, null);
		}
		return finalize(retried, finalMeta);
	} finally {
		rememberOperationMeta(state, operationMeta);
		state.activeReaders -= 1;
		if (state.activeReaders === 0) {
			for (const resolve of state.waiters) resolve();
			state.waiters.clear();
		}
	}
};
