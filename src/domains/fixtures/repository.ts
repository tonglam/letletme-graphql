import type { GraphQLContext } from "../../graphql/context";
import {
	getCoreEventSnapshot,
	getCoreFixtureSnapshot,
	type CoreFixtureData,
} from "../../infra/data-snapshot";
import { getCurrentEventId } from "../../infra/event";
import { metrics } from "../../infra/metrics";

export type Fixture = {
	id: number;
	code: number;
	eventId: number | null;
	finished: boolean;
	finishedProvisional: boolean;
	kickoffTime: string | null;
	minutes: number;
	started: boolean | null;
	teamHId: number;
	teamAId: number;
	teamHScore: number | null;
	teamAScore: number | null;
	teamHDifficulty: number | null;
	teamADifficulty: number | null;
};

export type FixturesFilter = {
	id?: number;
	eventId?: number;
	teamId?: number;
	finished?: boolean;
};

const mapFixture = (fixture: CoreFixtureData): Fixture => ({ ...fixture });

const mapCoreScheduleFixture = (fixture: CoreFixtureData, currentEvent: boolean): Fixture => {
	if (!currentEvent || fixture.finished || fixture.finishedProvisional) return mapFixture(fixture);
	// Core is the schedule publication. An unfinished current fixture's score
	// belongs exclusively to the live publication and must fail closed here.
	return {
		...mapFixture(fixture),
		teamHScore: null,
		teamAScore: null,
	};
};

const normalizeFilter = (filter?: FixturesFilter | null): FixturesFilter | undefined =>
	filter
		? {
				id: filter.id ?? undefined,
				eventId: filter.eventId ?? undefined,
				teamId: filter.teamId ?? undefined,
				finished: filter.finished ?? undefined,
			}
		: undefined;

const clampLimit = (limit: number): number =>
	Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);

const kickoffOrder = (left: Fixture, right: Fixture): number => {
	if (!left.kickoffTime && !right.kickoffTime) return left.id - right.id;
	if (!left.kickoffTime) return 1;
	if (!right.kickoffTime) return -1;
	return left.kickoffTime.localeCompare(right.kickoffTime);
};

const matchesFilter = (fixture: Fixture, filter?: FixturesFilter): boolean => {
	if (!filter) return true;
	if (filter.id !== undefined && fixture.id !== filter.id) return false;
	if (filter.eventId !== undefined && fixture.eventId !== filter.eventId) return false;
	if (filter.finished !== undefined && fixture.finished !== filter.finished) return false;
	if (
		filter.teamId !== undefined &&
		fixture.teamHId !== filter.teamId &&
		fixture.teamAId !== filter.teamId
	) {
		return false;
	}
	return true;
};

interface FixturesRepository {
	listFixtures(
		context: GraphQLContext,
		filter: FixturesFilter | null | undefined,
		limit: number,
		offset: number
	): Promise<Fixture[]>;
	getEventFixtures(context: GraphQLContext, eventId: number): Promise<Fixture[]>;
	getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]>;
}

export const fixturesRepository: FixturesRepository = {
	async listFixtures(context, filter, limit, offset) {
		const snapshot = await getCoreFixtureSnapshot(context);
		const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);
		return snapshot.fixtures
			.map(mapFixture)
			.filter((fixture) => matchesFilter(fixture, normalizeFilter(filter)))
			.sort(kickoffOrder)
			.slice(safeOffset, safeOffset + clampLimit(limit));
	},

	async getEventFixtures(context, eventId) {
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return [];
		const acquisitionStartedAt = performance.now();
		const [snapshot, eventSnapshot] = await Promise.all([
			getCoreFixtureSnapshot(context),
			getCoreEventSnapshot(context),
		]);
		const coreFixtureAcquisitionMs = performance.now() - acquisitionStartedAt;
		const transformStartedAt = performance.now();
		const fixtures = snapshot.fixtures
			.map((fixture) => mapCoreScheduleFixture(fixture, eventSnapshot.currentEventId === eventId))
			.filter((fixture) => fixture.eventId === eventId)
			.sort(kickoffOrder);
		const fixtureTransformMs = performance.now() - transformStartedAt;
		metrics.cacheRepositoryEvents.labels("fixtures", snapshot.source).inc();
		context.logger.debug(
			{
				requestId: context.requestId,
				operationName: context.operationName,
				eventId,
				fixtureCount: fixtures.length,
				fixtureSource: snapshot.source,
				fixtureRevision: snapshot.revision,
				coreFixtureAcquisitionMs: Number(coreFixtureAcquisitionMs.toFixed(2)),
				fixtureTransformMs: Number(fixtureTransformMs.toFixed(2)),
				coreSnapshotMemoStatus: context.coreSnapshotMemoStatus,
			},
			"Core fixture schedule loaded"
		);
		return fixtures;
	},

	async getCurrentFixtures(context) {
		const currentEventId = await getCurrentEventId(context);
		return currentEventId ? this.getEventFixtures(context, currentEventId) : [];
	},
};
