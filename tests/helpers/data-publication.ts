import { createHash } from "crypto";
import type { GraphQLContext } from "../../src/graphql/context";
import {
	activeDataPublicationKey,
	dataPublicationItemKey,
	type DataPublicationManifest,
	type DataPublicationScope,
} from "../../src/infra/data-publication";
import type {
	CoreEventData,
	CoreFixtureData,
	CorePhaseData,
	CorePlayerData,
	CoreTeamData,
} from "../../src/infra/data-snapshot";

export type TestPublication = Readonly<{
	scope: DataPublicationScope;
	manifest: DataPublicationManifest;
	values: Readonly<Record<string, unknown>>;
	store: ReadonlyMap<string, string>;
}>;

export type TestCoreData = Readonly<{
	events: CoreEventData[];
	teams: CoreTeamData[];
	players: CorePlayerData[];
	phases: CorePhaseData[];
	fixtures: CoreFixtureData[];
	currentEventId: number | null;
}>;

const publishedAt = "2026-08-09T01:00:00.000Z";

const itemCount = (value: unknown): number => {
	if (Array.isArray(value)) return value.length;
	if (value && typeof value === "object") return Object.keys(value).length;
	return value === null || value === undefined ? 0 : 1;
};

const publicationId = (revision: number): string =>
	`00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`;

export const createTestPublication = (
	scope: DataPublicationScope,
	revision: number,
	values: Readonly<Record<string, unknown>>,
	options: {
		state?: "scheduled" | "live" | "settled";
		sourceCheckedAt?: string;
		lastSuccessfulFetchAt?: string;
	} = {}
): TestPublication => {
	const store = new Map<string, string>();
	const items = Object.entries(values).map(([name, value]) => {
		const payload = JSON.stringify(value);
		const key = dataPublicationItemKey(scope, revision, name);
		store.set(key, payload);
		return {
			name,
			key,
			type: "string" as const,
			count: itemCount(value),
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
		};
	});
	const manifest: DataPublicationManifest = {
		dataset: scope.dataset,
		seasonCode: scope.seasonCode,
		eventId: scope.eventId ?? null,
		revision,
		publicationId: publicationId(revision),
		sourceCheckedAt: options.sourceCheckedAt ?? publishedAt,
		...(options.lastSuccessfulFetchAt
			? { lastSuccessfulFetchAt: options.lastSuccessfulFetchAt }
			: {}),
		publishedAt,
		state:
			scope.dataset === "fpl:core" || scope.dataset === "fpl:market"
				? "active"
				: (options.state ?? "scheduled"),
		items,
	};
	store.set(activeDataPublicationKey(scope), JSON.stringify(manifest));
	return { scope, manifest, values, store };
};

const roundRobinPairs = (): Array<Array<[number, number]>> => {
	const rotation = Array.from({ length: 20 }, (_, index) => index + 1);
	const rounds: Array<Array<[number, number]>> = [];
	for (let round = 0; round < 19; round += 1) {
		const pairs: Array<[number, number]> = [];
		for (let index = 0; index < 10; index += 1) {
			const first = rotation[index]!;
			const second = rotation[19 - index]!;
			pairs.push((round + index) % 2 === 0 ? [first, second] : [second, first]);
		}
		rounds.push(pairs);
		rotation.splice(1, 0, rotation.pop()!);
	}
	return rounds;
};

export const buildTestCoreData = (
	currentEventId: number | null = 1,
	overrides: Partial<TestCoreData> = {}
): TestCoreData => {
	const events: CoreEventData[] = Array.from({ length: 38 }, (_, index) => {
		const id = index + 1;
		return {
			id,
			name: `Gameweek ${id}`,
			deadlineTime: new Date(Date.UTC(2026, 7, 8 + index * 7, 17, 30)).toISOString(),
			averageEntryScore: null,
			finished: id < (currentEventId ?? 0),
			dataChecked: false,
			highestScoringEntry: null,
			deadlineTimeEpoch: null,
			deadlineTimeGameOffset: null,
			highestScore: null,
			isPrevious: currentEventId !== null && id === currentEventId - 1,
			isCurrent: id === currentEventId,
			isNext: currentEventId === null ? id === 1 : id === currentEventId + 1,
			cupLeagueCreate: false,
			h2hKoMatchesCreated: false,
			chipPlays: null,
			mostSelected: null,
			mostTransferredIn: null,
			topElement: null,
			topElementInfo: null,
			transfersMade: null,
			mostCaptained: null,
			mostViceCaptained: null,
		};
	});
	const teams: CoreTeamData[] = Array.from({ length: 20 }, (_, index) => {
		const id = index + 1;
		return {
			id,
			code: 100 + id,
			name: `Team ${id}`,
			shortName: `T${String(id).padStart(2, "0")}`,
			strength: id === 1 ? null : 3,
			position: id,
			points: 0,
			played: 0,
			win: 0,
			draw: 0,
			loss: 0,
			form: null,
			strengthOverallHome: 1000,
			strengthOverallAway: 1000,
			strengthAttackHome: 1000,
			strengthAttackAway: 1000,
			strengthDefenceHome: 1000,
			strengthDefenceAway: 1000,
		};
	});
	const players: CorePlayerData[] = teams.flatMap((team) =>
		Array.from({ length: 11 }, (_, index) => {
			const id = (team.id - 1) * 11 + index + 1;
			return {
				id,
				code: 10_000 + id,
				type: (index % 4) + 1,
				teamId: team.id,
				price: 45 + (index % 5),
				startPrice: 45 + (index % 5),
				firstName: `First${id}`,
				secondName: `Second${id}`,
				webName: `Player ${id}`,
				totalPoints: 0,
				selectedByPercent: null,
			};
		})
	);
	const phases: CorePhaseData[] = [
		{ id: 1, name: "Overall", startEvent: 1, stopEvent: 38, highestScore: null },
	];
	const firstHalf = roundRobinPairs();
	let fixtureId = 1;
	const fixtures: CoreFixtureData[] = [];
	for (let round = 0; round < firstHalf.length; round += 1) {
		for (const [home, away] of firstHalf[round]!) {
			fixtures.push({
				id: fixtureId,
				code: 20_000 + fixtureId,
				eventId: round + 1,
				finished: false,
				finishedProvisional: false,
				kickoffTime: events[round]!.deadlineTime,
				minutes: 0,
				started: false,
				teamHId: home,
				teamAId: away,
				teamHScore: null,
				teamAScore: null,
				teamHDifficulty: 3,
				teamADifficulty: 3,
			});
			fixtureId += 1;
		}
	}
	for (let round = 0; round < firstHalf.length; round += 1) {
		for (const [home, away] of firstHalf[round]!) {
			fixtures.push({
				id: fixtureId,
				code: 20_000 + fixtureId,
				eventId: round + 20,
				finished: false,
				finishedProvisional: false,
				kickoffTime: events[round + 19]!.deadlineTime,
				minutes: 0,
				started: false,
				teamHId: away,
				teamAId: home,
				teamHScore: null,
				teamAScore: null,
				teamHDifficulty: 3,
				teamADifficulty: 3,
			});
			fixtureId += 1;
		}
	}
	return {
		events: overrides.events ?? events,
		teams: overrides.teams ?? teams,
		players: overrides.players ?? players,
		phases: overrides.phases ?? phases,
		fixtures: overrides.fixtures ?? fixtures,
		currentEventId: overrides.currentEventId ?? currentEventId,
	};
};

export const buildCorePublication = (
	seasonCode = "2627",
	revision = 7,
	core = buildTestCoreData()
): TestPublication =>
	createTestPublication({ dataset: "fpl:core", seasonCode }, revision, {
		events: core.events,
		teams: core.teams,
		players: core.players,
		phases: core.phases,
		fixtures: core.fixtures.map(toPublicationFixture),
		currentEventId: core.currentEventId,
		selectionRules: null,
	});

export const toPublicationFixture = (fixture: CoreFixtureData): Record<string, unknown> => ({
	id: fixture.id,
	code: fixture.code,
	event: fixture.eventId,
	finished: fixture.finished,
	finishedProvisional: fixture.finishedProvisional,
	kickoffTime: fixture.kickoffTime,
	minutes: fixture.minutes,
	started: fixture.started,
	teamH: fixture.teamHId,
	teamA: fixture.teamAId,
	teamHScore: fixture.teamHScore,
	teamAScore: fixture.teamAScore,
	teamHDifficulty: fixture.teamHDifficulty,
	teamADifficulty: fixture.teamADifficulty,
});

export const buildLivePublication = (
	core: TestCoreData,
	eventId = 1,
	seasonCode = "2627",
	revision = 8,
	overrides: Partial<{
		eventLives: readonly Record<string, unknown>[];
		fixtures: readonly CoreFixtureData[];
		state: "scheduled" | "live" | "settled";
		sourceCheckedAt: string;
		lastSuccessfulFetchAt?: string;
	}> = {}
): TestPublication => {
	const eventLives = buildTestEventLives(core, eventId);
	const fixtures =
		overrides.fixtures ?? core.fixtures.filter((fixture) => fixture.eventId === eventId);
	return createTestPublication(
		{ dataset: "fpl:live", seasonCode, eventId },
		revision,
		{
			eventLive: overrides.eventLives ?? eventLives,
			fixtures: fixtures.map(toPublicationFixture),
		},
		{
			state: overrides.state ?? "scheduled",
			sourceCheckedAt: overrides.sourceCheckedAt,
			lastSuccessfulFetchAt: overrides.lastSuccessfulFetchAt,
		}
	);
};

export const buildTestEventLives = (
	core: TestCoreData,
	eventId: number
): Array<Record<string, unknown>> =>
	core.players.map((player) => ({
		eventId,
		elementId: player.id,
		minutes: 0,
		goalsScored: 0,
		assists: 0,
		cleanSheets: 0,
		goalsConceded: 0,
		ownGoals: 0,
		penaltiesSaved: 0,
		penaltiesMissed: 0,
		yellowCards: 0,
		redCards: 0,
		saves: 0,
		bonus: 0,
		bps: 0,
		starts: false,
		defensiveContribution: 0,
		expectedGoals: "0.00",
		expectedAssists: "0.00",
		expectedGoalInvolvements: "0.00",
		expectedGoalsConceded: "0.00",
		inDreamTeam: false,
		totalPoints: 0,
	}));

export class TestRedis {
	readonly values = new Map<string, string>();
	readonly hashes = new Map<string, Map<string, string>>();
	readonly setCalls: Array<[string, string, ...unknown[]]> = [];

	constructor(...publications: TestPublication[]) {
		for (const publication of publications) {
			for (const [key, value] of publication.store) this.values.set(key, value);
		}
	}

	get = async (key: string): Promise<string | null> => this.values.get(key) ?? null;

	mget = async (...keys: string[]): Promise<Array<string | null>> =>
		keys.map((key) => this.values.get(key) ?? null);

	set = async (key: string, value: string, ...args: unknown[]): Promise<"OK"> => {
		this.values.set(key, value);
		this.setCalls.push([key, value, ...args]);
		return "OK";
	};

	del = async (...keys: string[]): Promise<number> => {
		let deleted = 0;
		for (const key of keys) deleted += this.values.delete(key) ? 1 : 0;
		return deleted;
	};

	hget = async (key: string, field: string): Promise<string | null> =>
		this.hashes.get(key)?.get(field) ?? null;

	hmget = async (key: string, ...fields: string[]): Promise<Array<string | null>> =>
		fields.map((field) => this.hashes.get(key)?.get(field) ?? null);

	hgetall = async (key: string): Promise<Record<string, string>> =>
		Object.fromEntries(this.hashes.get(key) ?? []);

	hlen = async (key: string): Promise<number> => this.hashes.get(key)?.size ?? 0;

	hset = async (key: string, ...pairs: string[]): Promise<number> => {
		const hash = this.hashes.get(key) ?? new Map<string, string>();
		let added = 0;
		for (let index = 0; index < pairs.length; index += 2) {
			const field = pairs[index]!;
			if (!hash.has(field)) added += 1;
			hash.set(field, pairs[index + 1]!);
		}
		this.hashes.set(key, hash);
		return added;
	};

	expire = async (): Promise<number> => 1;

	pipeline = () => {
		const operations: Array<() => Promise<unknown>> = [];
		const pipeline = {
			set: (key: string, value: string, ...args: unknown[]) => {
				operations.push(() => this.set(key, value, ...args));
				return pipeline;
			},
			del: (...keys: string[]) => {
				operations.push(() => this.del(...keys));
				return pipeline;
			},
			exec: async () => Promise.all(operations.map((operation) => operation())),
		};
		return pipeline;
	};
}

export const testLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

export const buildSnapshotContext = (
	redis: TestRedis,
	options: {
		seasonId?: number;
		seasonCode?: string;
		dataRevision?: string;
		databaseQuery?: (...args: unknown[]) => Promise<{ rows: unknown[] }>;
	} = {}
): GraphQLContext =>
	({
		currentSeason: {
			seasonId: options.seasonId ?? 2026,
			seasonCode: options.seasonCode ?? "2627",
		},
		dataRevision: options.dataRevision ?? "core-7",
		redis,
		database: {
			query:
				options.databaseQuery ??
				(async () => {
					throw new Error("Unexpected database query");
				}),
		},
		data: {
			read: () => {
				throw new Error("Unexpected read-model query");
			},
		},
		logger: testLogger,
	}) as unknown as GraphQLContext;
