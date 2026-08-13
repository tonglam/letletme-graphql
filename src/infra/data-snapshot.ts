import type { QueryResultRow } from "pg";
import type { GraphQLContext } from "../graphql/context";
import {
	parseDataPublicationManifest,
	readDataPublication,
	readDataPublicationItemsObserved,
	readDataPublicationItemsAtManifest,
	readDataPublicationManifest,
	type DataPublication,
	type DataPublicationManifest,
} from "./data-publication";

export const CORE_PUBLICATION_ITEMS = [
	"events",
	"teams",
	"players",
	"phases",
	"fixtures",
	"currentEventId",
] as const;

export const LIVE_PUBLICATION_ITEMS = [
	"eventLives",
	"fixtures",
	"liveFixtures",
	"liveBonus",
] as const;

export type DataSnapshotSource = "redis" | "postgres";
export type LiveSnapshotState = "scheduled" | "live" | "settled";

export type CoreEventData = Readonly<{
	id: number;
	name: string;
	deadlineTime: string | null;
	averageEntryScore: number | null;
	finished: boolean;
	dataChecked: boolean;
	highestScoringEntry: number | null;
	deadlineTimeEpoch: number | null;
	deadlineTimeGameOffset: number | null;
	highestScore: number | null;
	isPrevious: boolean;
	isCurrent: boolean;
	isNext: boolean;
	cupLeagueCreate: boolean;
	h2hKoMatchesCreated: boolean;
	chipPlays: unknown[] | null;
	mostSelected: number | null;
	mostTransferredIn: number | null;
	topElement: number | null;
	topElementInfo: unknown | null;
	transfersMade: number | null;
	mostCaptained: number | null;
	mostViceCaptained: number | null;
}>;

export type CoreTeamData = Readonly<{
	id: number;
	code: number;
	name: string;
	shortName: string;
	strength: number | null;
	position: number;
	points: number;
	played: number;
	win: number;
	draw: number;
	loss: number;
	form: string | null;
	strengthOverallHome: number;
	strengthOverallAway: number;
	strengthAttackHome: number;
	strengthAttackAway: number;
	strengthDefenceHome: number;
	strengthDefenceAway: number;
}>;

export type CorePlayerData = Readonly<{
	id: number;
	code: number;
	type: number;
	teamId: number;
	price: number;
	startPrice: number;
	firstName: string | null;
	secondName: string | null;
	webName: string;
	totalPoints: number;
	selectedByPercent: number | null;
}>;

export type CorePhaseData = Readonly<{
	id: number;
	name: string;
	startEvent: number;
	stopEvent: number;
	highestScore: number | null;
}>;

export type CoreFixtureData = Readonly<{
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
}>;

export type LivePerformanceData = Readonly<{
	eventId: number;
	playerId: number;
	minutes: number | null;
	goalsScored: number | null;
	assists: number | null;
	cleanSheets: number | null;
	goalsConceded: number | null;
	ownGoals: number | null;
	penaltiesSaved: number | null;
	penaltiesMissed: number | null;
	yellowCards: number | null;
	redCards: number | null;
	saves: number | null;
	bonus: number | null;
	bps: number | null;
	starts: boolean | null;
	defensiveContribution: number | null;
	expectedGoals: string | null;
	expectedAssists: string | null;
	expectedGoalInvolvements: string | null;
	expectedGoalsConceded: string | null;
	inDreamTeam: boolean | null;
	totalPoints: number;
}>;

export type LiveFixtureData = Readonly<{
	fixtureId: number;
	teamId: number;
	teamName: string;
	teamShortName: string;
	teamScore: number;
	teamPosition: number;
	againstId: number;
	againstName: string;
	againstShortName: string;
	againstTeamScore: number;
	againstTeamPosition: number;
	kickoffTime: string | null;
	score: string;
	wasHome: boolean;
	started: boolean;
	finished: boolean;
}>;

export type LiveFixtureBuckets = Readonly<{
	Playing: readonly LiveFixtureData[];
	Not_Start: readonly LiveFixtureData[];
	Finished: readonly LiveFixtureData[];
}>;

export type LiveFixturesByTeam = Readonly<Record<string, LiveFixtureBuckets>>;
export type LiveBonusByTeam = Readonly<Record<string, Readonly<Record<string, number>>>>;

export type CoreDataSnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	revision: string;
	publicationId: string;
	sourceCheckedAt: string;
	events: readonly CoreEventData[];
	teams: readonly CoreTeamData[];
	players: readonly CorePlayerData[];
	phases: readonly CorePhaseData[];
	fixtures: readonly CoreFixtureData[];
	currentEventId: number | null;
}>;

export type CoreFixtureSnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	revision: string;
	publicationId: string;
	sourceCheckedAt: string;
	teams: readonly CoreTeamData[];
	fixtures: readonly CoreFixtureData[];
}>;

export type CoreTeamSnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	revision: string;
	publicationId: string;
	sourceCheckedAt: string;
	teams: readonly CoreTeamData[];
}>;

export type CoreEventSnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	revision: string;
	publicationId: string;
	sourceCheckedAt: string;
	events: readonly CoreEventData[];
	currentEventId: number | null;
}>;

export type LiveDataSnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	eventId: number;
	revision: string;
	publicationId: string | null;
	sourceCheckedAt: string;
	publishedAt: string;
	state: LiveSnapshotState;
	eventLives: readonly LivePerformanceData[];
	fixtures: readonly CoreFixtureData[];
	liveFixtures: LiveFixturesByTeam;
	liveBonus: LiveBonusByTeam;
}>;

export type TargetedLiveDataSnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	eventId: number;
	revision: string;
	publicationId: string | null;
	sourceCheckedAt: string;
	publishedAt: string;
	state: LiveSnapshotState;
	eventLiveCount: number;
	fixtureCount: number;
	fixtureTeamCount: number;
	bonusTeamCount: number;
	eventLives: readonly LivePerformanceData[];
	liveBonus: LiveBonusByTeam;
}>;

const coreSnapshotMemo = new WeakMap<object, Promise<CoreDataSnapshot>>();
const coreFixtureSnapshotMemo = new WeakMap<object, Promise<CoreFixtureSnapshot>>();
const coreEventSnapshotMemo = new WeakMap<object, Promise<CoreEventSnapshot>>();
const coreTeamSnapshotMemo = new WeakMap<object, Promise<CoreTeamSnapshot>>();
const liveSnapshotMemo = new WeakMap<object, Map<number, Promise<LiveDataSnapshot>>>();

type CorePublicationPin = {
	manifest: Promise<DataPublicationManifest | null>;
	publication?: Promise<DataPublication | null>;
};

const corePublicationPinMemo = new WeakMap<object, CorePublicationPin>();

const bindCoreRevision = <T extends { revision: string }>(
	context: GraphQLContext,
	loading: Promise<T>
): Promise<T> =>
	loading.then((snapshot) => {
		context.dataRevision ??= `core-${snapshot.revision}`;
		return snapshot;
	});

const reserveCorePublicationPin = (
	context: GraphQLContext,
	mode: "manifest" | "publication"
): CorePublicationPin => {
	const requestScope = context.requestScope ?? context;
	const existing = corePublicationPinMemo.get(requestScope);
	if (existing) {
		if (mode === "publication" && !existing.publication) {
			existing.publication = existing.manifest.then((manifest) =>
				manifest
					? readDataPublicationItemsAtManifest(context.redis, manifest, CORE_PUBLICATION_ITEMS)
					: null
			);
		}
		return existing;
	}

	const scope = {
		dataset: "fpl:core" as const,
		seasonCode: context.currentSeason.seasonCode,
	};
	if (mode === "publication") {
		const publication = readDataPublication(context.redis, scope, CORE_PUBLICATION_ITEMS);
		const pin: CorePublicationPin = {
			publication,
			manifest: publication.then((value) => value?.manifest ?? null),
		};
		corePublicationPinMemo.set(requestScope, pin);
		return pin;
	}

	const pin: CorePublicationPin = {
		manifest: readDataPublicationManifest(context.redis, scope),
	};
	corePublicationPinMemo.set(requestScope, pin);
	return pin;
};

const readPinnedCorePublicationItems = async (
	context: GraphQLContext,
	requiredItemNames: readonly string[]
): Promise<DataPublication | null> => {
	const requestScope = context.requestScope ?? context;
	let pin = corePublicationPinMemo.get(requestScope);
	if (!pin) {
		const scope = {
			dataset: "fpl:core" as const,
			seasonCode: context.currentSeason.seasonCode,
		};
		const read = readDataPublicationItemsObserved(context.redis, scope, requiredItemNames);
		const publication = read.then((value) => value.publication);
		pin = {
			manifest: read.then(
				(value) => value.observedManifest ?? readDataPublicationManifest(context.redis, scope)
			),
		};
		corePublicationPinMemo.set(requestScope, pin);
		return publication;
	}
	if (pin.publication) {
		const publication = await pin.publication;
		if (publication) return publication;
	}
	const manifest = await pin.manifest;
	return manifest
		? readDataPublicationItemsAtManifest(context.redis, manifest, requiredItemNames)
		: null;
};

type LivePublicationPin = {
	manifest: Promise<DataPublicationManifest | null>;
	publication?: Promise<DataPublication | null>;
};

const livePublicationPinMemo = new WeakMap<object, Map<number, LivePublicationPin>>();

const reserveLivePublicationPin = (
	context: GraphQLContext,
	eventId: number,
	mode: "manifest" | "publication"
): LivePublicationPin => {
	const requestScope = context.requestScope ?? context;
	let eventPins = livePublicationPinMemo.get(requestScope);
	if (!eventPins) {
		eventPins = new Map();
		livePublicationPinMemo.set(requestScope, eventPins);
	}

	const existing = eventPins.get(eventId);
	if (existing) {
		if (mode === "publication" && !existing.publication) {
			existing.publication = existing.manifest.then((manifest) =>
				manifest
					? readDataPublicationItemsAtManifest(context.redis, manifest, LIVE_PUBLICATION_ITEMS)
					: null
			);
		}
		return existing;
	}

	const scope = {
		dataset: "fpl:live" as const,
		seasonCode: context.currentSeason.seasonCode,
		eventId,
	};
	if (mode === "publication") {
		const publication = readDataPublication(context.redis, scope, LIVE_PUBLICATION_ITEMS);
		const pin: LivePublicationPin = {
			publication,
			manifest: publication.then((value) => value?.manifest ?? null),
		};
		eventPins.set(eventId, pin);
		return pin;
	}

	const pin: LivePublicationPin = {
		manifest: readDataPublicationManifest(context.redis, scope),
	};
	eventPins.set(eventId, pin);
	return pin;
};

export const getLiveDataPublicationManifest = (
	context: GraphQLContext,
	eventId: number
): Promise<DataPublicationManifest | null> => {
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return Promise.resolve(null);
	return reserveLivePublicationPin(context, eventId, "manifest").manifest;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pick = (row: Record<string, unknown>, camel: string, snake: string): unknown =>
	Object.hasOwn(row, camel) ? row[camel] : row[snake];

const finiteNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
};

const integer = (value: unknown): number | null => {
	const parsed = finiteNumber(value);
	return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

const nullableInteger = (value: unknown): number | null | undefined =>
	value === null ? null : (integer(value) ?? undefined);

const nullableNumber = (value: unknown): number | null | undefined =>
	value === null ? null : (finiteNumber(value) ?? undefined);

const boolean = (value: unknown): boolean | null => {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	return null;
};

const nullableBoolean = (value: unknown): boolean | null | undefined =>
	value === null ? null : (boolean(value) ?? undefined);

const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

const nullableString = (value: unknown): string | null | undefined => {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return string(value) ?? undefined;
};

const isoDate = (value: unknown): string | null => {
	if (!(typeof value === "string" || value instanceof Date)) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const asRows = (value: unknown): Record<string, unknown>[] | null =>
	Array.isArray(value) && value.every(isRecord) ? value : null;

const hasUniquePositiveIds = <T>(values: readonly T[], id: (value: T) => number): boolean => {
	const ids = values.map(id);
	return (
		ids.every((value) => Number.isSafeInteger(value) && value > 0) &&
		new Set(ids).size === ids.length
	);
};

const EXPECTED_EVENT_COUNT = 38;
const EXPECTED_TEAM_COUNT = 20;
const EXPECTED_FIXTURE_COUNT = 380;
const MIN_PLAYERS_PER_TEAM = 11;

const hasSameIds = <T, U>(
	left: readonly T[],
	right: readonly U[],
	leftId: (value: T) => number,
	rightId: (value: U) => number
): boolean => {
	if (left.length !== right.length) return false;
	const ids = new Set(left.map(leftId));
	return ids.size === left.length && right.every((value) => ids.has(rightId(value)));
};

const hasCompleteCoreIdentity = (
	events: readonly CoreEventData[],
	teams: readonly CoreTeamData[],
	players: readonly CorePlayerData[],
	phases: readonly CorePhaseData[],
	fixtures: readonly CoreFixtureData[]
): boolean => {
	if (
		events.length !== EXPECTED_EVENT_COUNT ||
		teams.length !== EXPECTED_TEAM_COUNT ||
		fixtures.length !== EXPECTED_FIXTURE_COUNT ||
		phases.length === 0 ||
		!hasUniquePositiveIds(events, (event) => event.id) ||
		!hasUniquePositiveIds(teams, (team) => team.id) ||
		!hasUniquePositiveIds(players, (player) => player.id) ||
		!hasUniquePositiveIds(phases, (phase) => phase.id) ||
		!hasUniquePositiveIds(fixtures, (fixture) => fixture.id)
	) {
		return false;
	}

	const eventIds = new Set(events.map((event) => event.id));
	if (
		Array.from({ length: EXPECTED_EVENT_COUNT }, (_, index) => index + 1).some(
			(eventId) => !eventIds.has(eventId)
		)
	) {
		return false;
	}

	const teamIds = new Set(teams.map((team) => team.id));
	const playersByTeam = new Map<number, number>(teams.map((team) => [team.id, 0]));
	const positions = new Set<number>();
	for (const player of players) {
		if (!teamIds.has(player.teamId)) return false;
		playersByTeam.set(player.teamId, (playersByTeam.get(player.teamId) ?? 0) + 1);
		positions.add(player.type);
	}
	if (
		positions.size !== 4 ||
		[...playersByTeam.values()].some((count) => count < MIN_PLAYERS_PER_TEAM)
	) {
		return false;
	}

	if (
		phases.some(
			(phase) =>
				phase.startEvent < 1 ||
				phase.stopEvent > EXPECTED_EVENT_COUNT ||
				phase.startEvent > phase.stopEvent
		) ||
		!phases.some((phase) => phase.startEvent === 1 && phase.stopEvent === EXPECTED_EVENT_COUNT)
	) {
		return false;
	}

	const appearances = new Map<number, number>(teams.map((team) => [team.id, 0]));
	const pairings = new Map<string, { lowerHome: number; upperHome: number }>();
	for (const fixture of fixtures) {
		if (
			!teamIds.has(fixture.teamHId) ||
			!teamIds.has(fixture.teamAId) ||
			fixture.teamHId === fixture.teamAId ||
			(fixture.eventId !== null && !eventIds.has(fixture.eventId))
		) {
			return false;
		}
		appearances.set(fixture.teamHId, (appearances.get(fixture.teamHId) ?? 0) + 1);
		appearances.set(fixture.teamAId, (appearances.get(fixture.teamAId) ?? 0) + 1);
		const lower = Math.min(fixture.teamHId, fixture.teamAId);
		const upper = Math.max(fixture.teamHId, fixture.teamAId);
		const key = `${lower}:${upper}`;
		const pairing = pairings.get(key) ?? { lowerHome: 0, upperHome: 0 };
		if (fixture.teamHId === lower) pairing.lowerHome += 1;
		else pairing.upperHome += 1;
		pairings.set(key, pairing);
	}
	return (
		[...appearances.values()].every((count) => count === EXPECTED_EVENT_COUNT) &&
		pairings.size === (EXPECTED_TEAM_COUNT * (EXPECTED_TEAM_COUNT - 1)) / 2 &&
		[...pairings.values()].every((pairing) => pairing.lowerHome === 1 && pairing.upperHome === 1)
	);
};

const hasCompleteCoreEventIdentity = (events: readonly CoreEventData[]): boolean => {
	if (
		events.length !== EXPECTED_EVENT_COUNT ||
		!hasUniquePositiveIds(events, (event) => event.id)
	) {
		return false;
	}
	const eventIds = new Set(events.map((event) => event.id));
	return Array.from({ length: EXPECTED_EVENT_COUNT }, (_, index) => index + 1).every((eventId) =>
		eventIds.has(eventId)
	);
};

const mapCoreEvent = (row: Record<string, unknown>): CoreEventData | null => {
	const id = integer(pick(row, "id", "event_id"));
	const name = string(row.name);
	const deadlineTimeRaw = pick(row, "deadlineTime", "deadline_time");
	const deadlineTime = deadlineTimeRaw === null ? null : isoDate(deadlineTimeRaw);
	const finished = boolean(row.finished);
	const dataChecked = boolean(pick(row, "dataChecked", "data_checked"));
	const isPrevious = boolean(pick(row, "isPrevious", "is_previous"));
	const isCurrent = boolean(pick(row, "isCurrent", "is_current"));
	const isNext = boolean(pick(row, "isNext", "is_next"));
	const cupLeagueCreate = boolean(pick(row, "cupLeagueCreate", "cup_league_create"));
	const h2hKoMatchesCreated = boolean(pick(row, "h2hKoMatchesCreated", "h2h_ko_matches_created"));
	const averageEntryScore = nullableNumber(pick(row, "averageEntryScore", "average_entry_score"));
	const highestScoringEntry = nullableInteger(
		pick(row, "highestScoringEntry", "highest_scoring_entry")
	);
	const deadlineTimeEpoch = nullableInteger(pick(row, "deadlineTimeEpoch", "deadline_time_epoch"));
	const deadlineTimeGameOffset = nullableInteger(
		pick(row, "deadlineTimeGameOffset", "deadline_time_game_offset")
	);
	const highestScore = nullableInteger(pick(row, "highestScore", "highest_score"));
	const mostSelected = nullableInteger(pick(row, "mostSelected", "most_selected"));
	const mostTransferredIn = nullableInteger(pick(row, "mostTransferredIn", "most_transferred_in"));
	const topElement = nullableInteger(pick(row, "topElement", "top_element"));
	const transfersMade = nullableInteger(pick(row, "transfersMade", "transfers_made"));
	const mostCaptained = nullableInteger(pick(row, "mostCaptained", "most_captained"));
	const mostViceCaptained = nullableInteger(pick(row, "mostViceCaptained", "most_vice_captained"));
	if (
		id === null ||
		id <= 0 ||
		name === null ||
		(deadlineTime === null && deadlineTimeRaw !== null) ||
		finished === null ||
		dataChecked === null ||
		isPrevious === null ||
		isCurrent === null ||
		isNext === null ||
		cupLeagueCreate === null ||
		h2hKoMatchesCreated === null ||
		averageEntryScore === undefined ||
		highestScoringEntry === undefined ||
		deadlineTimeEpoch === undefined ||
		deadlineTimeGameOffset === undefined ||
		highestScore === undefined ||
		mostSelected === undefined ||
		mostTransferredIn === undefined ||
		topElement === undefined ||
		transfersMade === undefined ||
		mostCaptained === undefined ||
		mostViceCaptained === undefined
	) {
		return null;
	}
	const chipPlaysRaw = pick(row, "chipPlays", "chip_plays");
	const topElementInfoRaw = pick(row, "topElementInfo", "top_element_info");
	return {
		id,
		name,
		deadlineTime,
		averageEntryScore,
		finished,
		dataChecked,
		highestScoringEntry,
		deadlineTimeEpoch,
		deadlineTimeGameOffset,
		highestScore,
		isPrevious,
		isCurrent,
		isNext,
		cupLeagueCreate,
		h2hKoMatchesCreated,
		chipPlays: Array.isArray(chipPlaysRaw) ? chipPlaysRaw : null,
		mostSelected,
		mostTransferredIn,
		topElement,
		topElementInfo: isRecord(topElementInfoRaw) ? topElementInfoRaw : null,
		transfersMade,
		mostCaptained,
		mostViceCaptained,
	};
};

const mapCoreTeam = (row: Record<string, unknown>): CoreTeamData | null => {
	const id = integer(pick(row, "id", "team_id"));
	const code = integer(row.code);
	const name = string(row.name);
	const shortName = string(pick(row, "shortName", "short_name"));
	const strength = nullableInteger(row.strength);
	const position = integer(row.position);
	const points = integer(row.points);
	const played = integer(row.played);
	const win = integer(row.win);
	const draw = integer(row.draw);
	const loss = integer(row.loss);
	const form = nullableString(row.form);
	const strengthOverallHome = integer(pick(row, "strengthOverallHome", "strength_overall_home"));
	const strengthOverallAway = integer(pick(row, "strengthOverallAway", "strength_overall_away"));
	const strengthAttackHome = integer(pick(row, "strengthAttackHome", "strength_attack_home"));
	const strengthAttackAway = integer(pick(row, "strengthAttackAway", "strength_attack_away"));
	const strengthDefenceHome = integer(pick(row, "strengthDefenceHome", "strength_defence_home"));
	const strengthDefenceAway = integer(pick(row, "strengthDefenceAway", "strength_defence_away"));
	if (
		id === null ||
		id <= 0 ||
		code === null ||
		name === null ||
		shortName === null ||
		strength === undefined ||
		position === null ||
		points === null ||
		played === null ||
		win === null ||
		draw === null ||
		loss === null ||
		form === undefined ||
		strengthOverallHome === null ||
		strengthOverallAway === null ||
		strengthAttackHome === null ||
		strengthAttackAway === null ||
		strengthDefenceHome === null ||
		strengthDefenceAway === null
	) {
		return null;
	}
	return {
		id,
		code,
		name,
		shortName,
		strength,
		position,
		points,
		played,
		win,
		draw,
		loss,
		form,
		strengthOverallHome,
		strengthOverallAway,
		strengthAttackHome,
		strengthAttackAway,
		strengthDefenceHome,
		strengthDefenceAway,
	};
};

const mapCorePlayer = (row: Record<string, unknown>): CorePlayerData | null => {
	const id = integer(pick(row, "id", "element_id"));
	const code = integer(row.code);
	const type = integer(pick(row, "type", "element_type"));
	const teamId = integer(pick(row, "teamId", "team_id"));
	const price = integer(row.price);
	const startPrice = integer(pick(row, "startPrice", "start_price"));
	const firstName = nullableString(pick(row, "firstName", "first_name"));
	const secondName = nullableString(pick(row, "secondName", "second_name"));
	const webName = string(pick(row, "webName", "web_name"));
	const totalPointsRaw = pick(row, "totalPoints", "total_points");
	const totalPoints = totalPointsRaw === undefined ? 0 : integer(totalPointsRaw);
	const selectedRaw = pick(row, "selectedByPercent", "selected_by_percent");
	const selectedByPercent = selectedRaw === undefined ? null : nullableNumber(selectedRaw);
	if (
		id === null ||
		id <= 0 ||
		code === null ||
		type === null ||
		type < 1 ||
		type > 4 ||
		teamId === null ||
		teamId <= 0 ||
		price === null ||
		startPrice === null ||
		firstName === undefined ||
		secondName === undefined ||
		webName === null ||
		totalPoints === null ||
		selectedByPercent === undefined
	) {
		return null;
	}
	return {
		id,
		code,
		type,
		teamId,
		price,
		startPrice,
		firstName,
		secondName,
		webName,
		totalPoints,
		selectedByPercent,
	};
};

const mapCorePhase = (row: Record<string, unknown>): CorePhaseData | null => {
	const id = integer(pick(row, "id", "phase_id"));
	const name = string(row.name);
	const startEvent = integer(pick(row, "startEvent", "start_event"));
	const stopEvent = integer(pick(row, "stopEvent", "stop_event"));
	const highestScore = nullableInteger(pick(row, "highestScore", "highest_score"));
	if (
		id === null ||
		id <= 0 ||
		name === null ||
		startEvent === null ||
		stopEvent === null ||
		highestScore === undefined
	) {
		return null;
	}
	return { id, name, startEvent, stopEvent, highestScore };
};

const mapCoreFixture = (row: Record<string, unknown>): CoreFixtureData | null => {
	const id = integer(pick(row, "id", "fixture_id"));
	const code = integer(row.code);
	const eventId = nullableInteger(pick(row, "event", "event_id"));
	const finished = boolean(row.finished);
	const finishedProvisional = boolean(pick(row, "finishedProvisional", "finished_provisional"));
	const kickoffRaw = pick(row, "kickoffTime", "kickoff_time");
	const kickoffTime = kickoffRaw === null ? null : isoDate(kickoffRaw);
	const minutes = integer(row.minutes);
	const started = nullableBoolean(row.started);
	const teamHId = integer(pick(row, "teamH", "team_h_id"));
	const teamAId = integer(pick(row, "teamA", "team_a_id"));
	const teamHScore = nullableInteger(pick(row, "teamHScore", "team_h_score"));
	const teamAScore = nullableInteger(pick(row, "teamAScore", "team_a_score"));
	const teamHDifficulty = nullableInteger(pick(row, "teamHDifficulty", "team_h_difficulty"));
	const teamADifficulty = nullableInteger(pick(row, "teamADifficulty", "team_a_difficulty"));
	if (
		id === null ||
		id <= 0 ||
		code === null ||
		eventId === undefined ||
		finished === null ||
		finishedProvisional === null ||
		(kickoffTime === null && kickoffRaw !== null) ||
		minutes === null ||
		started === undefined ||
		teamHId === null ||
		teamHId <= 0 ||
		teamAId === null ||
		teamAId <= 0 ||
		teamHScore === undefined ||
		teamAScore === undefined ||
		teamHDifficulty === undefined ||
		teamADifficulty === undefined
	) {
		return null;
	}
	return {
		id,
		code,
		eventId,
		finished,
		finishedProvisional,
		kickoffTime,
		minutes,
		started,
		teamHId,
		teamAId,
		teamHScore,
		teamAScore,
		teamHDifficulty,
		teamADifficulty,
	};
};

const mapLivePerformance = (row: Record<string, unknown>): LivePerformanceData | null => {
	const eventId = integer(pick(row, "eventId", "event_id"));
	const playerId = integer(pick(row, "elementId", "element_id"));
	const requiredNullableIntegers = [
		["minutes", "minutes"],
		["goalsScored", "goals_scored"],
		["assists", "assists"],
		["cleanSheets", "clean_sheets"],
		["goalsConceded", "goals_conceded"],
		["ownGoals", "own_goals"],
		["penaltiesSaved", "penalties_saved"],
		["penaltiesMissed", "penalties_missed"],
		["yellowCards", "yellow_cards"],
		["redCards", "red_cards"],
		["saves", "saves"],
		["bonus", "bonus"],
		["bps", "bps"],
		["defensiveContribution", "defensive_contribution"],
	] as const;
	const values = Object.fromEntries(
		requiredNullableIntegers.map(([camel, snake]) => [
			camel,
			nullableInteger(pick(row, camel, snake)),
		])
	) as Record<(typeof requiredNullableIntegers)[number][0], number | null | undefined>;
	const starts = nullableBoolean(row.starts);
	const expectedGoals = nullableString(pick(row, "expectedGoals", "expected_goals"));
	const expectedAssists = nullableString(pick(row, "expectedAssists", "expected_assists"));
	const expectedGoalInvolvements = nullableString(
		pick(row, "expectedGoalInvolvements", "expected_goal_involvements")
	);
	const expectedGoalsConceded = nullableString(
		pick(row, "expectedGoalsConceded", "expected_goals_conceded")
	);
	const inDreamTeam = nullableBoolean(pick(row, "inDreamTeam", "in_dream_team"));
	const totalPoints = integer(pick(row, "totalPoints", "total_points"));
	if (
		eventId === null ||
		eventId <= 0 ||
		playerId === null ||
		playerId <= 0 ||
		Object.values(values).some((value) => value === undefined) ||
		starts === undefined ||
		expectedGoals === undefined ||
		expectedAssists === undefined ||
		expectedGoalInvolvements === undefined ||
		expectedGoalsConceded === undefined ||
		inDreamTeam === undefined ||
		totalPoints === null
	) {
		return null;
	}
	return {
		eventId,
		playerId,
		minutes: values.minutes!,
		goalsScored: values.goalsScored!,
		assists: values.assists!,
		cleanSheets: values.cleanSheets!,
		goalsConceded: values.goalsConceded!,
		ownGoals: values.ownGoals!,
		penaltiesSaved: values.penaltiesSaved!,
		penaltiesMissed: values.penaltiesMissed!,
		yellowCards: values.yellowCards!,
		redCards: values.redCards!,
		saves: values.saves!,
		bonus: values.bonus!,
		bps: values.bps!,
		starts,
		defensiveContribution: values.defensiveContribution!,
		expectedGoals,
		expectedAssists,
		expectedGoalInvolvements,
		expectedGoalsConceded,
		inDreamTeam,
		totalPoints,
	};
};

const mapArray = <T>(
	value: unknown,
	mapper: (row: Record<string, unknown>) => T | null
): T[] | null => {
	const rows = asRows(value);
	if (!rows) return null;
	const mapped = rows.map(mapper);
	return mapped.every((row): row is T => row !== null) ? mapped : null;
};

const resolveCurrentEventId = (
	events: readonly CoreEventData[],
	preferred: unknown,
	sourceCheckedAt: string
): number | null => {
	const preferredId = preferred === null ? null : integer(preferred);
	if (preferredId !== null && events.some((event) => event.id === preferredId)) return preferredId;
	const flagged = events.find((event) => event.isCurrent);
	if (flagged) return flagged.id;
	const checkedAt = Date.parse(sourceCheckedAt);
	return (
		[...events]
			.filter((event) => event.deadlineTime !== null && Date.parse(event.deadlineTime) <= checkedAt)
			.sort((left, right) => String(right.deadlineTime).localeCompare(String(left.deadlineTime)))[0]
			?.id ?? null
	);
};

const publicationCoreSnapshot = (publication: DataPublication): CoreDataSnapshot | null => {
	const events = mapArray(publication.items.events, mapCoreEvent);
	const teams = mapArray(publication.items.teams, mapCoreTeam);
	const players = mapArray(publication.items.players, mapCorePlayer);
	const phases = mapArray(publication.items.phases, mapCorePhase);
	const fixtures = mapArray(publication.items.fixtures, mapCoreFixture);
	if (
		!events ||
		!teams ||
		!players ||
		!phases ||
		!fixtures ||
		!hasCompleteCoreIdentity(events, teams, players, phases, fixtures)
	) {
		return null;
	}
	const rawCurrentEventId = publication.items.currentEventId;
	const currentEventId = rawCurrentEventId === null ? null : integer(rawCurrentEventId);
	if (
		(currentEventId === null && rawCurrentEventId !== null) ||
		(currentEventId !== null && !events.some((event) => event.id === currentEventId))
	) {
		return null;
	}
	return {
		source: "redis",
		seasonCode: publication.manifest.seasonCode,
		revision: String(publication.manifest.revision),
		publicationId: publication.manifest.publicationId,
		sourceCheckedAt: publication.manifest.sourceCheckedAt,
		events,
		teams,
		players,
		phases,
		fixtures,
		currentEventId,
	};
};

const publicationCoreFixtureSnapshot = (
	publication: DataPublication
): CoreFixtureSnapshot | null => {
	const teams = mapArray(publication.items.teams, mapCoreTeam);
	const fixtures = mapArray(publication.items.fixtures, mapCoreFixture);
	if (!teams || !fixtures || teams.length === 0) return null;
	const teamIds = new Set(teams.map((team) => team.id));
	if (fixtures.some((fixture) => !teamIds.has(fixture.teamHId) || !teamIds.has(fixture.teamAId))) {
		return null;
	}
	return {
		source: "redis",
		seasonCode: publication.manifest.seasonCode,
		revision: String(publication.manifest.revision),
		publicationId: publication.manifest.publicationId,
		sourceCheckedAt: publication.manifest.sourceCheckedAt,
		teams,
		fixtures,
	};
};

const publicationCoreEventSnapshot = (publication: DataPublication): CoreEventSnapshot | null => {
	const events = mapArray(publication.items.events, mapCoreEvent);
	const currentEventId = integer(publication.items.currentEventId);
	if (!events || !hasCompleteCoreEventIdentity(events)) return null;
	return {
		source: "redis",
		seasonCode: publication.manifest.seasonCode,
		revision: String(publication.manifest.revision),
		publicationId: publication.manifest.publicationId,
		sourceCheckedAt: publication.manifest.sourceCheckedAt,
		events,
		currentEventId,
	};
};

const publicationCoreTeamSnapshot = (publication: DataPublication): CoreTeamSnapshot | null => {
	const teams = mapArray(publication.items.teams, mapCoreTeam);
	if (!teams || teams.length === 0 || !hasUniquePositiveIds(teams, (team) => team.id)) return null;
	return {
		source: "redis",
		seasonCode: publication.manifest.seasonCode,
		revision: String(publication.manifest.revision),
		publicationId: publication.manifest.publicationId,
		sourceCheckedAt: publication.manifest.sourceCheckedAt,
		teams,
	};
};

type CoreFallbackRow = QueryResultRow & {
	authority_count: string | number;
	publication_id: string | null;
	revision: string | number | null;
	manifest: unknown;
	source_checked_at: string | Date | null;
	events: unknown;
	teams: unknown;
	players: unknown;
	phases: unknown;
	fixtures: unknown;
};

const CORE_FALLBACK_SQL = `
	WITH active_publication AS MATERIALIZED (
		SELECT
			publication_id::text,
			revision::text,
			manifest,
			COALESCE(manifest ->> 'sourceCheckedAt', activated_at::text) AS source_checked_at
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:core'
		  AND season_id = $1
		  AND event_id IS NULL
		  AND status = 'active'
	), authority AS (
		SELECT
			count(*)::text AS authority_count,
			min(publication_id) AS publication_id,
			min(revision) AS revision,
			min(manifest::text)::jsonb AS manifest,
			min(source_checked_at) AS source_checked_at
		FROM active_publication
	)
	SELECT
		authority.*,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(event_row) - 'season_id') ORDER BY event_id)
			FROM fpl.events event_row WHERE season_id = $1
		), '[]'::jsonb) AS events,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(team_row) - 'season_id') ORDER BY team_id)
			FROM fpl.teams team_row WHERE season_id = $1
		), '[]'::jsonb) AS teams,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(player_row) - 'season_id') ORDER BY element_id)
			FROM fpl.players player_row WHERE season_id = $1
		), '[]'::jsonb) AS players,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(phase_row) - 'season_id') ORDER BY phase_id)
			FROM fpl.phases phase_row WHERE season_id = $1
		), '[]'::jsonb) AS phases,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(fixture_row) - 'season_id') ORDER BY fixture_id)
			FROM fpl.fixtures fixture_row WHERE season_id = $1
		), '[]'::jsonb) AS fixtures
	FROM authority
`;

type CoreEventFallbackRow = QueryResultRow & {
	authority_count: string | number;
	publication_id: string | null;
	revision: string | number | null;
	manifest: unknown;
	source_checked_at: string | Date | null;
	events: unknown;
};

type CoreTeamFallbackRow = QueryResultRow & {
	authority_count: string | number;
	publication_id: string | null;
	revision: string | number | null;
	manifest: unknown;
	source_checked_at: string | Date | null;
	teams: unknown;
};

const CORE_EVENT_FALLBACK_SQL = `
	WITH active_publication AS MATERIALIZED (
		SELECT
			publication_id::text,
			revision::text,
			manifest,
			COALESCE(manifest ->> 'sourceCheckedAt', activated_at::text) AS source_checked_at
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:core'
		  AND season_id = $1
		  AND event_id IS NULL
		  AND status = 'active'
	), authority AS (
		SELECT
			count(*)::text AS authority_count,
			min(publication_id) AS publication_id,
			min(revision) AS revision,
			min(manifest::text)::jsonb AS manifest,
			min(source_checked_at) AS source_checked_at
		FROM active_publication
	)
	SELECT
		authority.*,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(event_row) - 'season_id') ORDER BY event_id)
			FROM fpl.events event_row WHERE season_id = $1
		), '[]'::jsonb) AS events
	FROM authority
`;

const CORE_TEAM_FALLBACK_SQL = `
	WITH active_publication AS MATERIALIZED (
		SELECT
			publication_id::text,
			revision::text,
			manifest,
			COALESCE(manifest ->> 'sourceCheckedAt', activated_at::text) AS source_checked_at
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:core'
		  AND season_id = $1
		  AND event_id IS NULL
		  AND status = 'active'
	), authority AS (
		SELECT
			count(*)::text AS authority_count,
			min(publication_id) AS publication_id,
			min(revision) AS revision,
			min(manifest::text)::jsonb AS manifest,
			min(source_checked_at) AS source_checked_at
		FROM active_publication
	)
	SELECT
		authority.*,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(team_row) - 'season_id') ORDER BY team_id)
			FROM fpl.teams team_row WHERE season_id = $1
		), '[]'::jsonb) AS teams
	FROM authority
`;

const validateTargetedCoreAuthority = (
	context: GraphQLContext,
	row: CoreEventFallbackRow | CoreTeamFallbackRow | undefined,
	expectedManifest: DataPublicationManifest | null | undefined
): { revision: number; sourceCheckedAt: string; publicationId: string } | null => {
	const revision = integer(row?.revision);
	const sourceCheckedAt = isoDate(row?.source_checked_at);
	const manifest = row?.manifest
		? parseDataPublicationManifest(JSON.stringify(row.manifest), {
				dataset: "fpl:core",
				seasonCode: context.currentSeason.seasonCode,
			})
		: null;
	if (
		!row ||
		integer(row.authority_count) !== 1 ||
		typeof row.publication_id !== "string" ||
		revision === null ||
		revision <= 0 ||
		!sourceCheckedAt ||
		!manifest ||
		manifest.publicationId !== row.publication_id ||
		manifest.revision !== revision ||
		(expectedManifest !== null &&
			expectedManifest !== undefined &&
			(manifest.publicationId !== expectedManifest.publicationId ||
				manifest.revision !== expectedManifest.revision))
	) {
		return null;
	}
	return { revision, sourceCheckedAt, publicationId: row.publication_id };
};

const loadCoreEventSnapshotFromPostgres = async (
	context: GraphQLContext,
	expectedManifest?: DataPublicationManifest | null
): Promise<CoreEventSnapshot> => {
	const result = await context.database.query<CoreEventFallbackRow>(CORE_EVENT_FALLBACK_SQL, [
		context.currentSeason.seasonId,
	]);
	const row = result.rows[0];
	const authority = validateTargetedCoreAuthority(context, row, expectedManifest);
	const events = mapArray(row?.events, mapCoreEvent);
	if (!authority || !events || !hasCompleteCoreEventIdentity(events)) {
		throw new Error("Coherent PostgreSQL core event publication is unavailable");
	}
	return {
		source: "postgres",
		seasonCode: context.currentSeason.seasonCode,
		revision: String(authority.revision),
		publicationId: authority.publicationId,
		sourceCheckedAt: authority.sourceCheckedAt,
		events,
		currentEventId: resolveCurrentEventId(events, undefined, authority.sourceCheckedAt),
	};
};

const loadCoreTeamSnapshotFromPostgres = async (
	context: GraphQLContext,
	expectedManifest?: DataPublicationManifest | null
): Promise<CoreTeamSnapshot> => {
	const result = await context.database.query<CoreTeamFallbackRow>(CORE_TEAM_FALLBACK_SQL, [
		context.currentSeason.seasonId,
	]);
	const row = result.rows[0];
	const authority = validateTargetedCoreAuthority(context, row, expectedManifest);
	const teams = mapArray(row?.teams, mapCoreTeam);
	if (!authority || !teams || teams.length === 0) {
		throw new Error("Coherent PostgreSQL core team publication is unavailable");
	}
	return {
		source: "postgres",
		seasonCode: context.currentSeason.seasonCode,
		revision: String(authority.revision),
		publicationId: authority.publicationId,
		sourceCheckedAt: authority.sourceCheckedAt,
		teams,
	};
};

const loadCoreSnapshotFromPostgres = async (
	context: GraphQLContext,
	expectedManifest?: DataPublicationManifest | null
): Promise<CoreDataSnapshot> => {
	const result = await context.database.query<CoreFallbackRow>(CORE_FALLBACK_SQL, [
		context.currentSeason.seasonId,
	]);
	const row = result.rows[0];
	const revision = integer(row?.revision);
	const sourceCheckedAt = isoDate(row?.source_checked_at);
	const events = mapArray(row?.events, mapCoreEvent);
	const teams = mapArray(row?.teams, mapCoreTeam);
	const players = mapArray(row?.players, mapCorePlayer);
	const phases = mapArray(row?.phases, mapCorePhase);
	const fixtures = mapArray(row?.fixtures, mapCoreFixture);
	const manifest = row?.manifest
		? parseDataPublicationManifest(JSON.stringify(row.manifest), {
				dataset: "fpl:core",
				seasonCode: context.currentSeason.seasonCode,
			})
		: null;
	const preservesPinnedPublication =
		expectedManifest !== null &&
		expectedManifest !== undefined &&
		manifest?.publicationId === expectedManifest.publicationId &&
		manifest.revision === expectedManifest.revision;
	const coreIdentityComplete =
		events !== null &&
		teams !== null &&
		players !== null &&
		phases !== null &&
		fixtures !== null &&
		hasCompleteCoreIdentity(events, teams, players, phases, fixtures);
	if (
		!row ||
		integer(row.authority_count) !== 1 ||
		typeof row.publication_id !== "string" ||
		revision === null ||
		revision <= 0 ||
		!manifest ||
		manifest.publicationId !== row.publication_id ||
		manifest.revision !== revision ||
		(expectedManifest !== null && expectedManifest !== undefined && !preservesPinnedPublication) ||
		!sourceCheckedAt ||
		!events ||
		!teams ||
		!players ||
		!phases ||
		!fixtures ||
		!coreIdentityComplete
	) {
		throw new Error(
			`Coherent PostgreSQL core publication is unavailable ` +
				`(events=${events?.length ?? "invalid"}, teams=${teams?.length ?? "invalid"}, ` +
				`players=${players?.length ?? "invalid"}, phases=${phases?.length ?? "invalid"}, ` +
				`fixtures=${fixtures?.length ?? "invalid"}, identity=${coreIdentityComplete})`
		);
	}
	return {
		source: "postgres",
		seasonCode: context.currentSeason.seasonCode,
		revision: String(revision),
		publicationId: row.publication_id,
		sourceCheckedAt,
		events,
		teams,
		players,
		phases,
		fixtures,
		currentEventId: resolveCurrentEventId(events, undefined, sourceCheckedAt),
	};
};

const normalizeLiveFixtureData = (value: unknown): LiveFixtureData | null => {
	if (!isRecord(value)) return null;
	const fixtureId = integer(pick(value, "fixtureId", "fixture_id"));
	const teamId = integer(pick(value, "teamId", "team_id"));
	const teamName = string(pick(value, "teamName", "team_name"));
	const teamShortName = string(pick(value, "teamShortName", "team_short_name"));
	const teamScore = integer(pick(value, "teamScore", "team_score"));
	const teamPosition = integer(pick(value, "teamPosition", "team_position"));
	const againstId = integer(pick(value, "againstId", "against_id"));
	const againstName = string(pick(value, "againstName", "against_name"));
	const againstShortName = string(pick(value, "againstShortName", "against_short_name"));
	const againstTeamScore = integer(pick(value, "againstTeamScore", "against_team_score"));
	const againstTeamPosition = integer(pick(value, "againstTeamPosition", "against_team_position"));
	const kickoffRaw = pick(value, "kickoffTime", "kickoff_time");
	const kickoffTime = kickoffRaw === null ? null : isoDate(kickoffRaw);
	const score = string(value.score);
	const wasHome = boolean(pick(value, "wasHome", "was_home"));
	const started = boolean(value.started);
	const finished = boolean(value.finished);
	if (
		fixtureId === null ||
		fixtureId <= 0 ||
		teamId === null ||
		teamId <= 0 ||
		teamName === null ||
		teamShortName === null ||
		teamScore === null ||
		teamPosition === null ||
		againstId === null ||
		againstId <= 0 ||
		againstName === null ||
		againstShortName === null ||
		againstTeamScore === null ||
		againstTeamPosition === null ||
		(kickoffTime === null && kickoffRaw !== null) ||
		score === null ||
		wasHome === null ||
		started === null ||
		finished === null
	) {
		return null;
	}
	return {
		fixtureId,
		teamId,
		teamName,
		teamShortName,
		teamScore,
		teamPosition,
		againstId,
		againstName,
		againstShortName,
		againstTeamScore,
		againstTeamPosition,
		kickoffTime,
		score,
		wasHome,
		started,
		finished,
	};
};

const normalizeLiveFixtures = (value: unknown): LiveFixturesByTeam | null => {
	if (!isRecord(value)) return null;
	const result: Record<string, LiveFixtureBuckets> = {};
	for (const [teamId, rawBuckets] of Object.entries(value)) {
		if (!/^\d+$/.test(teamId) || !isRecord(rawBuckets)) return null;
		const buckets: Partial<Record<keyof LiveFixtureBuckets, readonly LiveFixtureData[]>> = {};
		for (const status of ["Playing", "Not_Start", "Finished"] as const) {
			const rows = rawBuckets[status];
			if (!Array.isArray(rows)) return null;
			const mapped = rows.map(normalizeLiveFixtureData);
			if (mapped.some((row) => row === null)) return null;
			buckets[status] = mapped as LiveFixtureData[];
		}
		result[teamId] = buckets as LiveFixtureBuckets;
	}
	return result;
};

const normalizeLiveBonus = (value: unknown): LiveBonusByTeam | null => {
	if (!isRecord(value)) return null;
	const result: Record<string, Record<string, number>> = {};
	for (const [teamId, rawPlayers] of Object.entries(value)) {
		if (!/^\d+$/.test(teamId) || !isRecord(rawPlayers)) return null;
		const players: Record<string, number> = {};
		for (const [playerId, rawBonus] of Object.entries(rawPlayers)) {
			const bonus = integer(rawBonus);
			if (!/^\d+$/.test(playerId) || bonus === null || bonus < 0) return null;
			players[playerId] = bonus;
		}
		result[teamId] = players;
	}
	return result;
};

type LiveFixtureEntry = Readonly<{
	status: keyof LiveFixtureBuckets;
	teamKey: number;
	row: LiveFixtureData;
}>;

const liveFixtureEntries = (view: LiveFixturesByTeam): LiveFixtureEntry[] =>
	Object.entries(view).flatMap(([teamId, buckets]) =>
		(["Playing", "Not_Start", "Finished"] as const).flatMap((status) =>
			buckets[status].map((row) => ({ status, teamKey: Number(teamId), row }))
		)
	);

const validateLiveFixtureView = (
	liveFixtures: LiveFixturesByTeam,
	fixtures: readonly CoreFixtureData[],
	core: CoreDataSnapshot
): boolean => {
	const entries = liveFixtureEntries(liveFixtures);
	if (entries.length !== fixtures.length * 2) return false;

	const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
	const teamsById = new Map(core.teams.map((team) => [team.id, team]));
	const orientations = new Map<number, Set<boolean>>();
	for (const entry of entries) {
		const { row, status, teamKey } = entry;
		const fixture = fixturesById.get(row.fixtureId);
		const team = teamsById.get(row.teamId);
		const opponent = teamsById.get(row.againstId);
		const expectedFinished = fixture ? fixture.finished || fixture.finishedProvisional : false;
		const expectedStatus: keyof LiveFixtureBuckets = expectedFinished
			? "Finished"
			: fixture?.started
				? "Playing"
				: "Not_Start";
		const expectedTeamId = row.wasHome ? fixture?.teamHId : fixture?.teamAId;
		const expectedOpponentId = row.wasHome ? fixture?.teamAId : fixture?.teamHId;
		const expectedTeamScore = row.wasHome ? fixture?.teamHScore : fixture?.teamAScore;
		const expectedOpponentScore = row.wasHome ? fixture?.teamAScore : fixture?.teamHScore;
		if (
			!fixture ||
			!team ||
			!opponent ||
			teamKey !== row.teamId ||
			row.teamId !== expectedTeamId ||
			row.againstId !== expectedOpponentId ||
			row.teamName !== team.name ||
			row.teamShortName !== team.shortName ||
			row.teamPosition !== team.position ||
			row.againstName !== opponent.name ||
			row.againstShortName !== opponent.shortName ||
			row.againstTeamPosition !== opponent.position ||
			row.teamScore !== (expectedTeamScore ?? 0) ||
			row.againstTeamScore !== (expectedOpponentScore ?? 0) ||
			row.score !== `${row.teamScore}-${row.againstTeamScore}` ||
			row.kickoffTime !== fixture.kickoffTime ||
			row.started !== (fixture.started ?? false) ||
			row.finished !== expectedFinished ||
			status !== expectedStatus
		) {
			return false;
		}
		const fixtureOrientations = orientations.get(fixture.id) ?? new Set<boolean>();
		fixtureOrientations.add(row.wasHome);
		orientations.set(fixture.id, fixtureOrientations);
	}
	return (
		orientations.size === fixtures.length &&
		[...orientations.values()].every(
			(fixtureOrientations) =>
				fixtureOrientations.size === 2 &&
				fixtureOrientations.has(true) &&
				fixtureOrientations.has(false)
		)
	);
};

const validateLiveBonus = (
	bonus: LiveBonusByTeam,
	core: CoreDataSnapshot,
	eventId: number
): boolean => {
	const eventTeamIds = new Set(
		core.fixtures
			.filter((fixture) => fixture.eventId === eventId)
			.flatMap((fixture) => [fixture.teamHId, fixture.teamAId])
	);
	const players = new Map(core.players.map((player) => [player.id, player]));
	for (const [teamIdRaw, teamBonus] of Object.entries(bonus)) {
		const teamId = Number(teamIdRaw);
		if (!eventTeamIds.has(teamId)) return false;
		for (const playerIdRaw of Object.keys(teamBonus)) {
			const playerId = Number(playerIdRaw);
			if (!players.has(playerId)) return false;
		}
	}
	return true;
};

const liveStateFromFixtures = (fixtures: readonly CoreFixtureData[]): LiveSnapshotState => {
	if (fixtures.length === 0) return "scheduled";
	const settled = fixtures.every((fixture) => fixture.finished || fixture.finishedProvisional);
	if (settled) return "settled";
	return fixtures.some(
		(fixture) => fixture.started || fixture.finished || fixture.finishedProvisional
	)
		? "live"
		: "scheduled";
};

const publicationLiveSnapshot = (
	publication: DataPublication,
	eventId: number,
	core: CoreDataSnapshot
): LiveDataSnapshot | null => {
	const eventLives = mapArray(publication.items.eventLives, mapLivePerformance);
	const fixtures = mapArray(publication.items.fixtures, mapCoreFixture);
	const liveFixtures = normalizeLiveFixtures(publication.items.liveFixtures);
	const liveBonus = normalizeLiveBonus(publication.items.liveBonus);
	const state = publication.manifest.state;
	if (
		!eventLives ||
		!fixtures ||
		!liveFixtures ||
		!liveBonus ||
		(state !== "scheduled" && state !== "live" && state !== "settled") ||
		eventLives.some((row) => row.eventId !== eventId) ||
		fixtures.some((fixture) => fixture.eventId !== eventId) ||
		!hasUniquePositiveIds(eventLives, (row) => row.playerId) ||
		!hasUniquePositiveIds(fixtures, (fixture) => fixture.id) ||
		!hasSameIds(
			eventLives,
			core.players,
			(row) => row.playerId,
			(player) => player.id
		) ||
		!hasSameIds(
			fixtures,
			core.fixtures.filter((fixture) => fixture.eventId === eventId),
			(fixture) => fixture.id,
			(fixture) => fixture.id
		) ||
		!validateLiveFixtureView(liveFixtures, fixtures, core) ||
		!validateLiveBonus(liveBonus, core, eventId) ||
		state !== liveStateFromFixtures(fixtures)
	) {
		return null;
	}
	return {
		source: "redis",
		seasonCode: publication.manifest.seasonCode,
		eventId,
		revision: String(publication.manifest.revision),
		publicationId: publication.manifest.publicationId,
		sourceCheckedAt: publication.manifest.sourceCheckedAt,
		publishedAt: publication.manifest.publishedAt,
		state,
		eventLives,
		fixtures,
		liveFixtures,
		liveBonus,
	};
};

type LiveFallbackRow = QueryResultRow & {
	authority_count: string | number;
	event_live_count?: string | number | null;
	known_player_count?: string | number | null;
	publication_id: string | null;
	revision: string | number | null;
	manifest: unknown;
	source_checked_at: string | Date | null;
	published_at: string | Date | null;
	event_checked_at: string | Date | null;
	event_lives: unknown;
	fixtures: unknown;
};

const LIVE_FALLBACK_SQL = `
	WITH active_publication AS MATERIALIZED (
		SELECT
			publication_id::text,
			revision::text,
			manifest,
			COALESCE(manifest ->> 'sourceCheckedAt', activated_at::text) AS source_checked_at,
			activated_at::text AS published_at
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:live'
		  AND season_id = $1
		  AND event_id = $2
		  AND status = 'active'
	), authority AS (
		SELECT
			count(*)::text AS authority_count,
			min(publication_id) AS publication_id,
			min(revision) AS revision,
			min(manifest::text)::jsonb AS manifest,
			min(source_checked_at) AS source_checked_at,
			min(published_at) AS published_at
		FROM active_publication
	)
	SELECT
		authority.*,
		(SELECT live_snapshot_checked_at FROM fpl.events WHERE season_id = $1 AND event_id = $2)
			AS event_checked_at,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(live_row) - 'season_id') ORDER BY element_id)
			FROM fpl.player_gameweek_stats live_row
			WHERE season_id = $1 AND event_id = $2
		), '[]'::jsonb) AS event_lives,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(fixture_row) - 'season_id') ORDER BY fixture_id)
			FROM fpl.fixtures fixture_row
			WHERE season_id = $1 AND event_id = $2
		), '[]'::jsonb) AS fixtures
	FROM authority
`;

const TARGETED_LIVE_SQL = `
	WITH active_publication AS MATERIALIZED (
		SELECT
			publication_id::text,
			revision::text,
			COALESCE(manifest ->> 'sourceCheckedAt', activated_at::text) AS source_checked_at,
			activated_at::text AS published_at
		FROM ops.dataset_publications
		WHERE dataset = 'fpl:live'
		  AND season_id = $1
		  AND event_id = $2
		  AND status = 'active'
	), authority AS (
		SELECT
			count(*)::text AS authority_count,
			min(publication_id) AS publication_id,
			min(revision) AS revision,
			min(source_checked_at) AS source_checked_at,
			min(published_at) AS published_at
		FROM active_publication
	)
		SELECT
			authority.*,
			(SELECT count(*)::text
			 FROM fpl.player_gameweek_stats
			 WHERE season_id = $1 AND event_id = $2) AS event_live_count,
			(SELECT count(*)::text
			 FROM fpl.players
			 WHERE season_id = $1 AND element_id = ANY($3::integer[])) AS known_player_count,
			COALESCE((
			SELECT jsonb_agg((to_jsonb(live_row) - 'season_id') ORDER BY element_id)
			FROM fpl.player_gameweek_stats live_row
			WHERE season_id = $1
			  AND event_id = $2
			  AND element_id = ANY($3::integer[])
		), '[]'::jsonb) AS event_lives,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(fixture_row) - 'season_id') ORDER BY fixture_id)
			FROM fpl.fixtures fixture_row
			WHERE season_id = $1 AND event_id = $2
		), '[]'::jsonb) AS fixtures
	FROM authority
`;

const emptyBuckets = (): {
	Playing: LiveFixtureData[];
	Not_Start: LiveFixtureData[];
	Finished: LiveFixtureData[];
} => ({
	Playing: [],
	Not_Start: [],
	Finished: [],
});

const fixtureStatus = (fixture: CoreFixtureData): keyof LiveFixtureBuckets =>
	fixture.finished || fixture.finishedProvisional
		? "Finished"
		: fixture.started
			? "Playing"
			: "Not_Start";

const buildLiveFixtureView = (
	fixtures: readonly CoreFixtureData[],
	core: CoreDataSnapshot
): LiveFixturesByTeam => {
	const teams = new Map(core.teams.map((team) => [team.id, team]));
	const byTeam: Record<string, ReturnType<typeof emptyBuckets>> = {};
	for (const fixture of fixtures) {
		const home = teams.get(fixture.teamHId);
		const away = teams.get(fixture.teamAId);
		if (!home || !away) continue;
		const status = fixtureStatus(fixture);
		const homeScore = fixture.teamHScore ?? 0;
		const awayScore = fixture.teamAScore ?? 0;
		const create = (wasHome: boolean): LiveFixtureData => ({
			fixtureId: fixture.id,
			teamId: wasHome ? home.id : away.id,
			teamName: wasHome ? home.name : away.name,
			teamShortName: wasHome ? home.shortName : away.shortName,
			teamScore: wasHome ? homeScore : awayScore,
			teamPosition: wasHome ? home.position : away.position,
			againstId: wasHome ? away.id : home.id,
			againstName: wasHome ? away.name : home.name,
			againstShortName: wasHome ? away.shortName : home.shortName,
			againstTeamScore: wasHome ? awayScore : homeScore,
			againstTeamPosition: wasHome ? away.position : home.position,
			kickoffTime: fixture.kickoffTime,
			score: wasHome ? `${homeScore}-${awayScore}` : `${awayScore}-${homeScore}`,
			wasHome,
			started: fixture.started === true,
			finished: fixture.finished || fixture.finishedProvisional,
		});
		for (const row of [create(true), create(false)]) {
			const buckets = (byTeam[String(row.teamId)] ??= emptyBuckets());
			buckets[status].push(row);
		}
	}
	return byTeam;
};

type FixtureBonusCandidate = Readonly<{
	elementId: number;
	teamId: number;
	value: number;
}>;

const fixtureStatCandidates = (
	rawFixture: Record<string, unknown> | undefined,
	fixture: CoreFixtureData,
	identifier: "bonus" | "bps"
): FixtureBonusCandidate[] => {
	const rawStats: unknown = rawFixture?.stats;
	if (!Array.isArray(rawStats)) return [];
	const stat: unknown = (rawStats as unknown[]).find(
		(value) => isRecord(value) && value.identifier === identifier
	);
	if (!isRecord(stat)) return [];
	const mapSide = (value: unknown, teamId: number): FixtureBonusCandidate[] => {
		if (!Array.isArray(value)) return [];
		const candidates: FixtureBonusCandidate[] = [];
		for (const item of value) {
			if (!isRecord(item)) continue;
			const elementId = integer(item.element);
			const statValue = integer(item.value);
			if (elementId && elementId > 0 && statValue !== null) {
				candidates.push({ elementId, teamId, value: statValue });
			}
		}
		return candidates;
	};
	return [...mapSide(stat.h, fixture.teamHId), ...mapSide(stat.a, fixture.teamAId)];
};

const rankFixtureBonus = (candidates: readonly FixtureBonusCandidate[]): Map<number, number> => {
	const awards = new Map<number, number>();
	const ranked = candidates
		.filter((candidate) => candidate.value > 0)
		.sort((left, right) => right.value - left.value);
	if (ranked.length === 0) return awards;

	const awardTier = (bonus: number, fromIndex: number): number => {
		const tierValue = ranked[fromIndex]!.value;
		let index = fromIndex;
		while (index < ranked.length && ranked[index]!.value === tierValue) {
			awards.set(ranked[index]!.elementId, bonus);
			index += 1;
		}
		return index;
	};

	let index = awardTier(3, 0);
	if (index >= 3 || index >= ranked.length) return awards;
	if (index === 1) {
		index = awardTier(2, index);
		if (index >= 3 || index >= ranked.length) return awards;
	}
	awardTier(1, index);
	return awards;
};

const buildLiveBonus = (
	rawFixtures: unknown,
	fixtures: readonly CoreFixtureData[]
): LiveBonusByTeam => {
	const rawById = new Map<number, Record<string, unknown>>();
	if (Array.isArray(rawFixtures)) {
		for (const rawFixture of rawFixtures) {
			if (!isRecord(rawFixture)) continue;
			const fixtureId = integer(pick(rawFixture, "id", "fixture_id"));
			if (fixtureId && fixtureId > 0) rawById.set(fixtureId, rawFixture);
		}
	}

	const byTeam: Record<string, Record<string, number>> = {};
	const add = (candidate: FixtureBonusCandidate): void => {
		if (candidate.value <= 0) return;
		const team = (byTeam[String(candidate.teamId)] ??= {});
		team[String(candidate.elementId)] = (team[String(candidate.elementId)] ?? 0) + candidate.value;
	};

	for (const fixture of fixtures) {
		if (!fixture.started && !fixture.finished && !fixture.finishedProvisional) continue;
		const rawFixture = rawById.get(fixture.id);
		const official = fixtureStatCandidates(rawFixture, fixture, "bonus").filter(
			(candidate) => candidate.value > 0
		);
		if (official.length > 0) {
			official.forEach(add);
			continue;
		}
		if (fixture.finished || fixture.finishedProvisional) continue;

		const bps = fixtureStatCandidates(rawFixture, fixture, "bps");
		const teamByElement = new Map(
			bps.map((candidate) => [candidate.elementId, candidate.teamId] as const)
		);
		for (const [elementId, value] of rankFixtureBonus(bps)) {
			const teamId = teamByElement.get(elementId);
			if (teamId !== undefined) add({ elementId, teamId, value });
		}
	}
	return byTeam;
};

const loadLiveSnapshotFromPostgres = async (
	context: GraphQLContext,
	eventId: number,
	expectedManifest?: DataPublicationManifest | null
): Promise<LiveDataSnapshot> => {
	const [core, result] = await Promise.all([
		getCoreDataSnapshot(context),
		context.database.query<LiveFallbackRow>(LIVE_FALLBACK_SQL, [
			context.currentSeason.seasonId,
			eventId,
		]),
	]);
	const row = result.rows[0];
	const authorityCount = integer(row?.authority_count) ?? 0;
	const eventCheckedAt = isoDate(row?.event_checked_at);
	const sourceCheckedAt = eventCheckedAt ?? isoDate(row?.source_checked_at) ?? core.sourceCheckedAt;
	const publishedAt =
		authorityCount === 1 ? (isoDate(row?.published_at) ?? sourceCheckedAt) : sourceCheckedAt;
	const eventLives = mapArray(row?.event_lives, mapLivePerformance);
	const fixtures = mapArray(row?.fixtures, mapCoreFixture);
	const manifest = row?.manifest
		? parseDataPublicationManifest(JSON.stringify(row.manifest), {
				dataset: "fpl:live",
				seasonCode: context.currentSeason.seasonCode,
				eventId,
			})
		: null;
	const preservesPinnedPublication =
		authorityCount === 1 &&
		expectedManifest !== null &&
		expectedManifest !== undefined &&
		manifest?.publicationId === expectedManifest.publicationId &&
		manifest.revision === expectedManifest.revision;
	const coreEventFixtures = core.fixtures.filter((fixture) => fixture.eventId === eventId);
	const coreTeamIds = new Set(core.teams.map((team) => team.id));
	if (
		!row ||
		authorityCount > 1 ||
		(expectedManifest !== null &&
			expectedManifest !== undefined &&
			authorityCount === 1 &&
			!preservesPinnedPublication) ||
		(authorityCount === 1 &&
			(!manifest ||
				manifest.publicationId !== row.publication_id ||
				manifest.revision !== integer(row.revision))) ||
		!eventLives ||
		!fixtures ||
		eventLives.some((live) => live.eventId !== eventId) ||
		fixtures.some((fixture) => fixture.eventId !== eventId) ||
		!hasUniquePositiveIds(eventLives, (live) => live.playerId) ||
		!hasUniquePositiveIds(fixtures, (fixture) => fixture.id) ||
		(eventLives.length > 0
			? !hasSameIds(
					eventLives,
					core.players,
					(live) => live.playerId,
					(player) => player.id
				)
			: fixtures.some(
					(fixture) => fixture.started === true || fixture.finished || fixture.finishedProvisional
				)) ||
		!hasSameIds(
			fixtures,
			coreEventFixtures,
			(fixture) => fixture.id,
			(fixture) => fixture.id
		) ||
		fixtures.some(
			(fixture) => !coreTeamIds.has(fixture.teamHId) || !coreTeamIds.has(fixture.teamAId)
		)
	) {
		throw new Error(`Coherent PostgreSQL live publication is unavailable for event ${eventId}`);
	}
	const revision = preservesPinnedPublication
		? String(expectedManifest.revision)
		: `db-${sourceCheckedAt ? Date.parse(sourceCheckedAt) : core.revision}`;
	const state = liveStateFromFixtures(fixtures);
	if (preservesPinnedPublication && expectedManifest.state !== state) {
		throw new Error(`Pinned live publication state is unavailable for event ${eventId}`);
	}
	const liveFixtures = buildLiveFixtureView(fixtures, core);
	const liveBonus = buildLiveBonus(row.fixtures, fixtures);
	if (
		!validateLiveFixtureView(liveFixtures, fixtures, core) ||
		!validateLiveBonus(liveBonus, core, eventId)
	) {
		throw new Error(`Coherent PostgreSQL live derivatives are unavailable for event ${eventId}`);
	}
	return {
		source: preservesPinnedPublication ? "redis" : "postgres",
		seasonCode: context.currentSeason.seasonCode,
		eventId,
		revision,
		publicationId: preservesPinnedPublication ? expectedManifest.publicationId : null,
		sourceCheckedAt: preservesPinnedPublication
			? expectedManifest.sourceCheckedAt
			: sourceCheckedAt,
		publishedAt: preservesPinnedPublication ? expectedManifest.publishedAt : publishedAt,
		state,
		eventLives,
		fixtures,
		liveFixtures,
		liveBonus,
	};
};

export const getCoreDataSnapshot = (context: GraphQLContext): Promise<CoreDataSnapshot> => {
	const requestScope = context.requestScope ?? context;
	const existing = coreSnapshotMemo.get(requestScope);
	if (existing) {
		context.coreSnapshotMemoStatus = "hit";
		return bindCoreRevision(context, existing);
	}
	context.coreSnapshotMemoStatus = "miss";
	const publication = reserveCorePublicationPin(context, "publication").publication!;
	const load = (async (): Promise<CoreDataSnapshot> => {
		const published = await publication;
		const snapshot = published ? publicationCoreSnapshot(published) : null;
		if (snapshot) return snapshot;
		const expectedManifest = await reserveCorePublicationPin(context, "manifest").manifest;
		context.logger.warn(
			{ season: context.currentSeason.seasonCode },
			"Core Data publication unavailable; using one coherent PostgreSQL snapshot"
		);
		return loadCoreSnapshotFromPostgres(context, expectedManifest);
	})();
	coreSnapshotMemo.set(requestScope, load);
	return bindCoreRevision(context, load);
};

const projectCoreFixtureSnapshot = (snapshot: CoreDataSnapshot): CoreFixtureSnapshot => ({
	source: snapshot.source,
	seasonCode: snapshot.seasonCode,
	revision: snapshot.revision,
	publicationId: snapshot.publicationId,
	sourceCheckedAt: snapshot.sourceCheckedAt,
	teams: snapshot.teams,
	fixtures: snapshot.fixtures,
});

export const getCoreFixtureSnapshot = (context: GraphQLContext): Promise<CoreFixtureSnapshot> => {
	const requestScope = context.requestScope ?? context;
	const existing = coreFixtureSnapshotMemo.get(requestScope);
	if (existing) return bindCoreRevision(context, existing);
	const load = (async (): Promise<CoreFixtureSnapshot> => {
		const publication = await readPinnedCorePublicationItems(context, ["teams", "fixtures"]);
		const snapshot = publication ? publicationCoreFixtureSnapshot(publication) : null;
		if (snapshot) return snapshot;
		context.logger.warn(
			{ season: context.currentSeason.seasonCode },
			"Core fixture publication unavailable; using the coherent PostgreSQL core snapshot"
		);
		return projectCoreFixtureSnapshot(await getCoreDataSnapshot(context));
	})();
	coreFixtureSnapshotMemo.set(requestScope, load);
	return bindCoreRevision(context, load);
};

export const getCoreEventSnapshot = (context: GraphQLContext): Promise<CoreEventSnapshot> => {
	const requestScope = context.requestScope ?? context;
	const existing = coreEventSnapshotMemo.get(requestScope);
	if (existing) return bindCoreRevision(context, existing);
	const load = (async (): Promise<CoreEventSnapshot> => {
		const publication = await readPinnedCorePublicationItems(context, ["events", "currentEventId"]);
		const snapshot = publication ? publicationCoreEventSnapshot(publication) : null;
		if (snapshot) return snapshot;
		context.logger.warn(
			{ season: context.currentSeason.seasonCode },
			"Core event publication unavailable; using the targeted PostgreSQL event snapshot"
		);
		const expectedManifest = await reserveCorePublicationPin(context, "manifest").manifest;
		return loadCoreEventSnapshotFromPostgres(context, expectedManifest);
	})();
	coreEventSnapshotMemo.set(requestScope, load);
	return bindCoreRevision(context, load);
};

export const getCoreTeamSnapshot = (context: GraphQLContext): Promise<CoreTeamSnapshot> => {
	const requestScope = context.requestScope ?? context;
	const existing = coreTeamSnapshotMemo.get(requestScope);
	if (existing) return bindCoreRevision(context, existing);
	const load = (async (): Promise<CoreTeamSnapshot> => {
		const publication = await readPinnedCorePublicationItems(context, ["teams"]);
		const snapshot = publication ? publicationCoreTeamSnapshot(publication) : null;
		if (snapshot) return snapshot;
		context.logger.warn(
			{ season: context.currentSeason.seasonCode },
			"Core team publication unavailable; using the targeted PostgreSQL team snapshot"
		);
		const expectedManifest = await reserveCorePublicationPin(context, "manifest").manifest;
		return loadCoreTeamSnapshotFromPostgres(context, expectedManifest);
	})();
	coreTeamSnapshotMemo.set(requestScope, load);
	return bindCoreRevision(context, load);
};

export const getLiveDataSnapshot = (
	context: GraphQLContext,
	eventId: number
): Promise<LiveDataSnapshot> => {
	if (!Number.isSafeInteger(eventId) || eventId <= 0) {
		return Promise.reject(new Error("Live Data snapshot requires a positive event ID"));
	}
	const requestScope = context.requestScope ?? context;
	let eventSnapshots = liveSnapshotMemo.get(requestScope);
	if (!eventSnapshots) {
		eventSnapshots = new Map();
		liveSnapshotMemo.set(requestScope, eventSnapshots);
	}
	const existing = eventSnapshots.get(eventId);
	if (existing) return existing;
	const pin = reserveLivePublicationPin(context, eventId, "publication");
	const publication = pin.publication!;
	const load = (async (): Promise<LiveDataSnapshot> => {
		const [published, manifest, core] = await Promise.all([
			publication,
			pin.manifest,
			getCoreDataSnapshot(context),
		]);
		const snapshot = published ? publicationLiveSnapshot(published, eventId, core) : null;
		if (snapshot) return snapshot;
		context.logger.warn(
			{ season: context.currentSeason.seasonCode, eventId },
			"Live Data publication unavailable; using one coherent PostgreSQL snapshot"
		);
		return loadLiveSnapshotFromPostgres(context, eventId, manifest);
	})();
	eventSnapshots.set(eventId, load);
	return load;
};

const projectTargetedLiveSnapshot = (
	snapshot: LiveDataSnapshot,
	playerIds: ReadonlySet<number>
): TargetedLiveDataSnapshot => ({
	source: snapshot.source,
	seasonCode: snapshot.seasonCode,
	eventId: snapshot.eventId,
	revision: snapshot.revision,
	publicationId: snapshot.publicationId,
	sourceCheckedAt: snapshot.sourceCheckedAt,
	publishedAt: snapshot.publishedAt,
	state: snapshot.state,
	eventLiveCount: snapshot.eventLives.length,
	fixtureCount: snapshot.fixtures.length,
	fixtureTeamCount: Object.keys(snapshot.liveFixtures).length,
	bonusTeamCount: Object.keys(snapshot.liveBonus).length,
	eventLives: snapshot.eventLives.filter((row) => playerIds.has(row.playerId)),
	liveBonus: snapshot.liveBonus,
});

export const getTargetedLiveDataSnapshot = async (
	context: GraphQLContext,
	eventId: number,
	playerIds: number[],
	expected: {
		publicationId: string;
		revision: string;
		sourceCheckedAt: string;
		publishedAt: string;
		state: LiveSnapshotState;
		eventLiveCount: number;
		fixtureCount: number;
		fixtureTeamCount: number;
		bonusTeamCount: number;
	}
): Promise<TargetedLiveDataSnapshot> => {
	const uniquePlayerIds = Array.from(
		new Set(playerIds.filter((playerId) => Number.isSafeInteger(playerId) && playerId > 0))
	);
	const requestedPlayerIds = new Set(uniquePlayerIds);
	try {
		const [core, result] = await Promise.all([
			getCoreFixtureSnapshot(context),
			context.database.query<LiveFallbackRow>(TARGETED_LIVE_SQL, [
				context.currentSeason.seasonId,
				eventId,
				uniquePlayerIds,
			]),
		]);
		const row = result.rows[0];
		const authorityCount = integer(row?.authority_count) ?? 0;
		const eventLiveCount = integer(row?.event_live_count);
		const knownPlayerCount = integer(row?.known_player_count);
		const eventLives = mapArray(row?.event_lives, mapLivePerformance);
		const fixtures = mapArray(row?.fixtures, mapCoreFixture);
		const coreEventFixtures = core.fixtures.filter((fixture) => fixture.eventId === eventId);
		const coreTeamIds = new Set(core.teams.map((team) => team.id));
		if (
			!row ||
			authorityCount !== 1 ||
			row.publication_id !== expected.publicationId ||
			String(row.revision) !== expected.revision ||
			eventLiveCount !== expected.eventLiveCount ||
			knownPlayerCount === null ||
			!eventLives ||
			!fixtures ||
			eventLives.some(
				(live) => live.eventId !== eventId || !requestedPlayerIds.has(live.playerId)
			) ||
			!hasUniquePositiveIds(eventLives, (live) => live.playerId) ||
			(expected.eventLiveCount > 0 && eventLives.length !== knownPlayerCount) ||
			(expected.eventLiveCount === 0 && eventLives.length > 0) ||
			fixtures.some((fixture) => fixture.eventId !== eventId) ||
			!hasUniquePositiveIds(fixtures, (fixture) => fixture.id) ||
			!hasSameIds(
				fixtures,
				coreEventFixtures,
				(fixture) => fixture.id,
				(fixture) => fixture.id
			) ||
			fixtures.some(
				(fixture) => !coreTeamIds.has(fixture.teamHId) || !coreTeamIds.has(fixture.teamAId)
			) ||
			fixtures.length !== expected.fixtureCount ||
			new Set(fixtures.flatMap((fixture) => [fixture.teamHId, fixture.teamAId])).size !==
				expected.fixtureTeamCount ||
			liveStateFromFixtures(fixtures) !== expected.state
		) {
			throw new Error(`Targeted live publication is unavailable for event ${eventId}`);
		}
		const liveBonus = buildLiveBonus(row.fixtures, fixtures);
		if (Object.keys(liveBonus).length !== expected.bonusTeamCount) {
			throw new Error(`Targeted live bonus is incoherent for event ${eventId}`);
		}
		return {
			source: "redis",
			seasonCode: context.currentSeason.seasonCode,
			eventId,
			revision: expected.revision,
			publicationId: expected.publicationId,
			sourceCheckedAt: expected.sourceCheckedAt,
			publishedAt: expected.publishedAt,
			state: expected.state,
			eventLiveCount: expected.eventLiveCount,
			fixtureCount: expected.fixtureCount,
			fixtureTeamCount: expected.fixtureTeamCount,
			bonusTeamCount: expected.bonusTeamCount,
			eventLives,
			liveBonus,
		};
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId, playerCount: uniquePlayerIds.length },
			"Targeted live read unavailable; using the coherent full snapshot"
		);
		return projectTargetedLiveSnapshot(
			await getLiveDataSnapshot(context, eventId),
			requestedPlayerIds
		);
	}
};

export const coreDatasetRevision = (snapshot: CoreDataSnapshot): string =>
	`core-${snapshot.revision}`;

export const liveDatasetRevision = (
	coreRevision: string,
	eventId: number,
	liveRevision: string
): string => `${coreRevision}.live-${eventId}-${liveRevision}`;
