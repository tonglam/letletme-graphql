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
		!isCount(parsed.fixtureCount, true) ||
		!isCount(parsed.fixtureTeamCount, true) ||
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

	const loading = (async (): Promise<LiveSnapshotMeta | null> => {
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
	memo.set(memoKey, loading);
	return loading;
};

/**
 * A producer publication is atomic, but a GraphQL operation may issue several
 * Redis reads. Compare the revision around those reads and retry once if the
 * producer committed between them, preventing mixed-minute calculations.
 */
export const withLiveSnapshotConsistency = async <T>(
	context: GraphQLContext,
	eventId: number,
	run: () => Promise<T>
): Promise<T> => {
	const before = await loadLiveSnapshotMeta(context, eventId, { fresh: true });
	const first = await run();
	const after = await loadLiveSnapshotMeta(context, eventId, { fresh: true });
	if (!after || before?.revision === after.revision) return first;

	context.logger.info(
		{ eventId, beforeRevision: before?.revision ?? null, afterRevision: after.revision },
		"Live snapshot advanced during request; retrying once"
	);
	const retried = await run();
	const finalMeta = await loadLiveSnapshotMeta(context, eventId, { fresh: true });
	if (finalMeta && finalMeta.revision !== after.revision) {
		context.logger.warn(
			{ eventId, retryRevision: after.revision, finalRevision: finalMeta.revision },
			"Live snapshot advanced again during retry; returning newest completed calculation"
		);
	}
	return retried;
};
