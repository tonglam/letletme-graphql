import type { GraphQLContext } from "../../graphql/context";
import {
	activeDataPublicationKey,
	parseDataPublicationManifest,
} from "../../infra/data-publication";
import {
	getLiveDataSnapshot,
	LIVE_PUBLICATION_ITEMS,
	type LiveSnapshotState,
} from "../../infra/data-snapshot";

export type { LiveSnapshotState };

export type LiveSnapshotMeta = {
	season: string;
	eventId: number;
	revision: string;
	publicationId: string | null;
	state: LiveSnapshotState;
	publishedAt: string;
	checkedAt: string;
	eventLiveCount: number;
	fixtureCount: number;
	fixtureTeamCount: number;
	bonusTeamCount: number;
};

const metaMemo = new WeakMap<object, Map<number, Promise<LiveSnapshotMeta | null>>>();
const sourceMemo = new WeakMap<object, Map<number, "redis" | "postgres">>();
const publicationMetaMemo = new WeakMap<object, Map<number, Promise<LiveSnapshotMeta | null>>>();

const memoIdentity = (context: GraphQLContext): object => context.requestScope ?? context;

const rememberSource = (
	context: GraphQLContext,
	eventId: number,
	source: "redis" | "postgres"
): void => {
	const identity = memoIdentity(context);
	let sources = sourceMemo.get(identity);
	if (!sources) {
		sources = new Map();
		sourceMemo.set(identity, sources);
	}
	sources.set(eventId, source);
};

export class LiveSnapshotCoherenceError extends Error {
	constructor(
		readonly eventId: number,
		readonly source: string,
		message: string
	) {
		super(message);
		this.name = "LiveSnapshotCoherenceError";
	}
}

export const liveSnapshotMetaKey = (season: string, eventId: number): string =>
	activeDataPublicationKey({ dataset: "fpl:live", seasonCode: season, eventId });

const itemCount = (
	items: readonly { name: string; count: number }[],
	name: string
): number | null => items.find((item) => item.name === name)?.count ?? null;

export const parseLiveSnapshotMeta = (
	raw: string | null,
	expected: { season?: string; eventId?: number } = {}
): LiveSnapshotMeta | null => {
	const scope =
		expected.season && expected.eventId
			? {
					dataset: "fpl:live" as const,
					seasonCode: expected.season,
					eventId: expected.eventId,
				}
			: undefined;
	const manifest = parseDataPublicationManifest(raw, scope);
	if (!manifest || manifest.dataset !== "fpl:live") return null;
	if (
		manifest.items.length !== LIVE_PUBLICATION_ITEMS.length ||
		!LIVE_PUBLICATION_ITEMS.every((name) => manifest.items.some((item) => item.name === name)) ||
		(manifest.state !== "scheduled" && manifest.state !== "live" && manifest.state !== "settled")
	) {
		return null;
	}
	const eventLiveCount = itemCount(manifest.items, "eventLives");
	const fixtureCount = itemCount(manifest.items, "fixtures");
	const fixtureTeamCount = itemCount(manifest.items, "liveFixtures");
	const bonusTeamCount = itemCount(manifest.items, "liveBonus");
	if (
		eventLiveCount === null ||
		fixtureCount === null ||
		fixtureTeamCount === null ||
		bonusTeamCount === null
	) {
		return null;
	}
	return {
		season: manifest.seasonCode,
		eventId: manifest.eventId!,
		revision: String(manifest.revision),
		publicationId: manifest.publicationId,
		state: manifest.state,
		publishedAt: manifest.publishedAt,
		checkedAt: manifest.sourceCheckedAt,
		eventLiveCount,
		fixtureCount,
		fixtureTeamCount,
		bonusTeamCount,
	};
};

export const rememberLiveSnapshotMeta = (
	context: GraphQLContext,
	meta: LiveSnapshotMeta | null,
	_season: string,
	eventId: number,
	source?: "redis" | "postgres"
): void => {
	if (!meta) return;
	const identity = memoIdentity(context);
	let values = metaMemo.get(identity);
	if (!values) {
		values = new Map();
		metaMemo.set(identity, values);
	}
	values.set(eventId, Promise.resolve(meta));
	if (source) rememberSource(context, eventId, source);
};

export const loadLiveSnapshotMeta = async (
	context: GraphQLContext,
	eventId: number,
	options: { season?: string; fresh?: boolean } = {}
): Promise<LiveSnapshotMeta | null> => {
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
	if (options.season && options.season !== context.currentSeason.seasonCode) return null;
	const identity = memoIdentity(context);
	let eventMeta = metaMemo.get(identity);
	if (!eventMeta) {
		eventMeta = new Map();
		metaMemo.set(identity, eventMeta);
	}
	const memoized = eventMeta.get(eventId);
	if (memoized) return memoized;
	const load = (async (): Promise<LiveSnapshotMeta> => {
		const snapshot = await getLiveDataSnapshot(context, eventId);
		const meta: LiveSnapshotMeta = {
			season: snapshot.seasonCode,
			eventId,
			revision: snapshot.revision,
			publicationId: snapshot.publicationId,
			state: snapshot.state,
			publishedAt: snapshot.publishedAt,
			checkedAt: snapshot.sourceCheckedAt,
			eventLiveCount: snapshot.eventLives.length,
			fixtureCount: snapshot.fixtures.length,
			fixtureTeamCount: Object.keys(snapshot.liveFixtures).length,
			bonusTeamCount: Object.keys(snapshot.liveBonus).length,
		};
		rememberSource(context, eventId, snapshot.source);
		return meta;
	})();
	eventMeta.set(eventId, load);
	return load;
};

/**
 * Read only the active publication manifest for paths that fetch a bounded
 * player set from PostgreSQL. Invalid or unavailable manifests retain the
 * existing coherent full-snapshot fallback.
 */
export const loadLivePublicationMeta = (
	context: GraphQLContext,
	eventId: number
): Promise<LiveSnapshotMeta | null> => {
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return Promise.resolve(null);
	const identity = memoIdentity(context);
	const pinned = metaMemo.get(identity)?.get(eventId);
	if (pinned) return pinned;
	let eventMeta = publicationMetaMemo.get(identity);
	if (!eventMeta) {
		eventMeta = new Map();
		publicationMetaMemo.set(identity, eventMeta);
	}
	const existing = eventMeta.get(eventId);
	if (existing) return existing;

	const load = (async (): Promise<LiveSnapshotMeta | null> => {
		const raw = await context.redis
			.get(liveSnapshotMetaKey(context.currentSeason.seasonCode, eventId))
			.catch(() => null);
		const published = parseLiveSnapshotMeta(raw, {
			season: context.currentSeason.seasonCode,
			eventId,
		});
		if (published) {
			rememberLiveSnapshotMeta(context, published, published.season, eventId);
			rememberSource(context, eventId, "redis");
			return published;
		}
		return loadLiveSnapshotMeta(context, eventId);
	})();
	eventMeta.set(eventId, load);
	return load;
};

export const loadOperationLiveSnapshotMeta = (
	context: GraphQLContext,
	eventId: number
): Promise<LiveSnapshotMeta | null> => loadLiveSnapshotMeta(context, eventId);

export const isLiveSnapshotDatabaseFallback = (context: GraphQLContext, eventId: number): boolean =>
	sourceMemo.get(memoIdentity(context))?.get(eventId) === "postgres";

export const isLiveSnapshotConsistencyActive = (
	context: GraphQLContext,
	eventId: number
): boolean => sourceMemo.get(memoIdentity(context))?.get(eventId) === "redis";

export const withLiveSnapshotConsistency = async <T>(
	context: GraphQLContext,
	eventId: number,
	operation: () => Promise<T>,
	_options: { participateInRootBarrier?: boolean } = {}
): Promise<T> => {
	await loadLiveSnapshotMeta(context, eventId);
	return operation();
};

export const withLiveSnapshotRoot = <T>(
	_context: GraphQLContext,
	operation: () => Promise<T>
): Promise<T> => operation();
