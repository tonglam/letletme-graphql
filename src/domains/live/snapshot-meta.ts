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
	schemaVersion: 3;
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

const metaMemo = new WeakMap<GraphQLContext, Map<number, LiveSnapshotMeta>>();
const sourceMemo = new WeakMap<GraphQLContext, Map<number, "redis" | "postgres">>();

const rememberSource = (
	context: GraphQLContext,
	eventId: number,
	source: "redis" | "postgres"
): void => {
	let sources = sourceMemo.get(context);
	if (!sources) {
		sources = new Map();
		sourceMemo.set(context, sources);
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
		schemaVersion: 3,
		season: manifest.seasonCode,
		eventId: manifest.eventId!,
		revision: String(manifest.revision),
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
	eventId: number
): void => {
	if (!meta) return;
	let values = metaMemo.get(context);
	if (!values) {
		values = new Map();
		metaMemo.set(context, values);
	}
	values.set(eventId, meta);
};

export const loadLiveSnapshotMeta = async (
	context: GraphQLContext,
	eventId: number,
	options: { season?: string; fresh?: boolean } = {}
): Promise<LiveSnapshotMeta | null> => {
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
	if (options.season && options.season !== context.currentSeason.seasonCode) return null;
	const memoized = metaMemo.get(context)?.get(eventId);
	if (memoized) return memoized;
	const snapshot = await getLiveDataSnapshot(context, eventId);
	const meta: LiveSnapshotMeta = {
		schemaVersion: 3,
		season: snapshot.seasonCode,
		eventId,
		revision: snapshot.revision,
		state: snapshot.state,
		publishedAt: snapshot.publishedAt,
		checkedAt: snapshot.sourceCheckedAt,
		eventLiveCount: snapshot.eventLives.length,
		fixtureCount: snapshot.fixtures.length,
		fixtureTeamCount: Object.keys(snapshot.liveFixtures).length,
		bonusTeamCount: Object.keys(snapshot.liveBonus).length,
	};
	rememberLiveSnapshotMeta(context, meta, snapshot.seasonCode, eventId);
	rememberSource(context, eventId, snapshot.source);
	return meta;
};

export const loadOperationLiveSnapshotMeta = (
	context: GraphQLContext,
	eventId: number
): Promise<LiveSnapshotMeta | null> => loadLiveSnapshotMeta(context, eventId);

export const isLiveSnapshotDatabaseFallback = (context: GraphQLContext, eventId: number): boolean =>
	sourceMemo.get(context)?.get(eventId) === "postgres";

export const isLiveSnapshotConsistencyActive = (
	context: GraphQLContext,
	eventId: number
): boolean => sourceMemo.get(context)?.get(eventId) === "redis";

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
