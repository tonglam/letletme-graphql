import type { GraphQLContext } from "../../graphql/context";
import { getCoreDataSnapshot, type CoreFixtureData } from "../../infra/data-snapshot";
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
		const snapshot = await getCoreDataSnapshot(context);
		const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);
		return snapshot.fixtures
			.map(mapFixture)
			.filter((fixture) => matchesFilter(fixture, normalizeFilter(filter)))
			.sort(kickoffOrder)
			.slice(safeOffset, safeOffset + clampLimit(limit));
	},

	async getEventFixtures(context, eventId) {
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return [];
		const snapshot = await getCoreDataSnapshot(context);
		const fixtures = snapshot.fixtures
			.map(mapFixture)
			.filter((fixture) => fixture.eventId === eventId)
			.sort(kickoffOrder);
		metrics.cacheRepositoryEvents.labels("fixtures", snapshot.source).inc();
		context.logger.debug(
			{
				eventId,
				fixtureCount: fixtures.length,
				fixtureSource: snapshot.source,
				fixtureRevision: snapshot.revision,
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
