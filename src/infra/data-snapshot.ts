import type { QueryResultRow } from "pg";
import type { DataSqlContractProbe } from "../contracts/data-sql-contract";
import { isPlainRecord as isRecord } from "../contracts/guards";
import type { GraphQLContext } from "../graphql/context";
import {
	parseDataPublicationManifest,
	type DataPublication,
	type DataPublicationManifest,
} from "./data-publication";
import {
	bindCoreRevision,
	readPinnedCorePublicationItems,
	reserveCorePublicationPin,
	TEAM_SELECTION_CORE_PUBLICATION_ITEMS,
} from "./data-snapshot-publication-pins";

export {
	CORE_PUBLICATION_ITEMS,
	TEAM_SELECTION_CORE_PUBLICATION_ITEMS,
} from "./data-snapshot-publication-pins";

export type DataSnapshotSource = "redis" | "postgres";

export type CoreEventData = Readonly<{
	id: number;
	name: string;
	deadlineTime: string | null;
	averageEntryScore: number | null;
	finished: boolean;
	dataChecked: boolean;
	/** FPL freshness fence for final result publication. */
	dataCheckedAt?: string | null;
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
	selectionRules?: CoreSelectionRules | null;
}>;

export type CoreSelectionRules = Readonly<{
	squadSize: number;
	startingSize: number;
	budget: number;
	maxPlayersPerTeam: number;
	currencyMultiplier: number;
	positions: readonly Readonly<{
		id: number;
		name: string;
		shortName: string;
		squadSelect: number;
		minPlay: number;
		maxPlay: number;
	}>[];
	chips: readonly Readonly<{
		id: number;
		name: string;
		number: number;
		startEvent: number;
		stopEvent: number;
		chipType: string;
	}>[];
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

/** The identity slice needed by immutable Live publications. */
export type CoreLiveIdentitySnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	revision: string;
	publicationId: string;
	sourceCheckedAt: string;
	teams: readonly CoreTeamData[];
	players: readonly CorePlayerData[];
}>;

export type CoreEventSnapshot = Readonly<{
	source: DataSnapshotSource;
	seasonCode: string;
	revision: string;
	publicationId: string;
	sourceCheckedAt: string;
	events: readonly CoreEventData[];
	currentEventId: number | null;
	selectionRules?: CoreSelectionRules | null;
}>;

const coreSnapshotMemo = new WeakMap<object, Promise<CoreDataSnapshot>>();
const coreFixtureSnapshotMemo = new WeakMap<object, Promise<CoreFixtureSnapshot>>();
const coreEventSnapshotMemo = new WeakMap<object, Promise<CoreEventSnapshot>>();
const coreTeamSnapshotMemo = new WeakMap<object, Promise<CoreTeamSnapshot>>();
const coreLiveIdentitySnapshotMemo = new WeakMap<object, Promise<CoreLiveIdentitySnapshot>>();
const teamSelectionCoreSnapshotMemo = new WeakMap<object, Promise<CoreDataSnapshot>>();

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
	const dataCheckedAtRaw = pick(row, "dataCheckedAt", "data_checked_at");
	const dataCheckedAt =
		dataCheckedAtRaw === null || dataCheckedAtRaw === undefined ? null : isoDate(dataCheckedAtRaw);
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
		(dataCheckedAtRaw !== null && dataCheckedAtRaw !== undefined && dataCheckedAt === null) ||
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
		dataCheckedAt,
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

const mapCoreSelectionRules = (value: unknown): CoreSelectionRules | null => {
	if (!isRecord(value)) return value === null || value === undefined ? null : null;
	const squadSize = integer(value.squadSize);
	const startingSize = integer(value.startingSize);
	const budget = integer(value.budget);
	const maxPlayersPerTeam = integer(value.maxPlayersPerTeam);
	const currencyMultiplier = integer(value.currencyMultiplier);
	const rawPositions = asRows(value.positions);
	const rawChips = asRows(value.chips);
	if (
		squadSize === null ||
		startingSize === null ||
		budget === null ||
		maxPlayersPerTeam === null ||
		currencyMultiplier === null ||
		!rawPositions ||
		!rawChips
	) {
		return null;
	}
	const positions = rawPositions.map((position) => ({
		id: integer(position.id),
		name: string(position.name),
		shortName: string(position.shortName),
		squadSelect: integer(position.squadSelect),
		minPlay: integer(position.minPlay),
		maxPlay: integer(position.maxPlay),
	}));
	const chips = rawChips.map((chip) => ({
		id: integer(chip.id),
		name: string(chip.name),
		number: integer(chip.number),
		startEvent: integer(chip.startEvent),
		stopEvent: integer(chip.stopEvent),
		chipType: string(chip.chipType),
	}));
	if (
		positions.some(
			(position) =>
				position.id === null ||
				position.name === null ||
				position.shortName === null ||
				position.squadSelect === null ||
				position.minPlay === null ||
				position.maxPlay === null
		) ||
		chips.some(
			(chip) =>
				chip.id === null ||
				chip.name === null ||
				chip.number === null ||
				chip.startEvent === null ||
				chip.stopEvent === null ||
				chip.chipType === null
		)
	) {
		return null;
	}
	return {
		squadSize,
		startingSize,
		budget,
		maxPlayersPerTeam,
		currencyMultiplier,
		positions: positions as CoreSelectionRules["positions"],
		chips: chips as CoreSelectionRules["chips"],
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
		selectionRules: mapCoreSelectionRules(publication.items.selectionRules),
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
		selectionRules: mapCoreSelectionRules(publication.items.selectionRules),
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

const publicationCoreLiveIdentitySnapshot = (
	publication: DataPublication
): CoreLiveIdentitySnapshot | null => {
	const teams = mapArray(publication.items.teams, mapCoreTeam);
	const players = mapArray(publication.items.players, mapCorePlayer);
	if (
		!teams ||
		!players ||
		teams.length === 0 ||
		players.length === 0 ||
		!hasUniquePositiveIds(teams, (team) => team.id) ||
		!hasUniquePositiveIds(players, (player) => player.id) ||
		players.some((player) => !teams.some((team) => team.id === player.teamId))
	) {
		return null;
	}
	return {
		source: "redis",
		seasonCode: publication.manifest.seasonCode,
		revision: String(publication.manifest.revision),
		publicationId: publication.manifest.publicationId,
		sourceCheckedAt: publication.manifest.sourceCheckedAt,
		teams,
		players,
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
	source_metadata: unknown;
};

export const CORE_FALLBACK_SQL = `
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
		), '[]'::jsonb) AS fixtures,
		COALESCE((
			SELECT source_metadata FROM fpl.seasons WHERE season_id = $1 LIMIT 1
		), '{}'::jsonb) AS source_metadata
	FROM authority
`;

/**
 * Decode a Core fallback row with the same identity and shape checks used by
 * the PostgreSQL reader. The Data contract runner calls this function against
 * the producer-owned fixture so RLS omissions or nested field drift fail the
 * contract before a Redis miss can expose an unavailable Core snapshot.
 */
export const parseCoreFallbackRow = (
	value: unknown,
	seasonCode: string,
	expectedManifest?: DataPublicationManifest | null
): CoreDataSnapshot | null => {
	if (!isRecord(value)) return null;
	const row = value as CoreFallbackRow;
	const revision = integer(row.revision);
	const sourceCheckedAt = isoDate(row.source_checked_at);
	const events = mapArray(row.events, mapCoreEvent);
	const teams = mapArray(row.teams, mapCoreTeam);
	const players = mapArray(row.players, mapCorePlayer);
	const phases = mapArray(row.phases, mapCorePhase);
	const fixtures = mapArray(row.fixtures, mapCoreFixture);
	const sourceMetadata = isRecord(row.source_metadata) ? row.source_metadata : null;
	const manifest = row.manifest
		? parseDataPublicationManifest(JSON.stringify(row.manifest), {
				dataset: "fpl:core",
				seasonCode,
			})
		: null;
	const coreIdentityComplete =
		events !== null &&
		teams !== null &&
		players !== null &&
		phases !== null &&
		fixtures !== null &&
		hasCompleteCoreIdentity(events, teams, players, phases, fixtures);
	if (
		integer(row.authority_count) !== 1 ||
		typeof row.publication_id !== "string" ||
		revision === null ||
		revision <= 0 ||
		!manifest ||
		manifest.publicationId !== row.publication_id ||
		manifest.revision !== revision ||
		(expectedManifest !== null &&
			expectedManifest !== undefined &&
			(manifest.publicationId !== expectedManifest.publicationId ||
				manifest.revision !== expectedManifest.revision)) ||
		!sourceCheckedAt ||
		!events ||
		!teams ||
		!players ||
		!phases ||
		!fixtures ||
		!coreIdentityComplete
	) {
		return null;
	}
	return {
		source: "postgres",
		seasonCode,
		revision: String(revision),
		publicationId: row.publication_id,
		sourceCheckedAt,
		events,
		teams,
		players,
		phases,
		fixtures,
		currentEventId: resolveCurrentEventId(events, undefined, sourceCheckedAt),
		selectionRules: mapCoreSelectionRules(sourceMetadata?.selectionRules),
	};
};

/** Explicitly binds the phase columns consumed by mapCorePhase. */
export const CORE_PHASE_SHAPE_SQL = `
	SELECT phase_id, name, start_event, stop_event, highest_score
	FROM fpl.phases
	WHERE season_id = $1
	ORDER BY phase_id
`;

type CoreEventFallbackRow = QueryResultRow & {
	authority_count: string | number;
	publication_id: string | null;
	revision: string | number | null;
	manifest: unknown;
	source_checked_at: string | Date | null;
	events: unknown;
	source_metadata: unknown;
};

type CoreTeamFallbackRow = QueryResultRow & {
	authority_count: string | number;
	publication_id: string | null;
	revision: string | number | null;
	manifest: unknown;
	source_checked_at: string | Date | null;
	teams: unknown;
};

type CoreLiveIdentityFallbackRow = CoreTeamFallbackRow & {
	players: unknown;
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
		), '[]'::jsonb) AS events,
		COALESCE((
			SELECT source_metadata FROM fpl.seasons WHERE season_id = $1 LIMIT 1
		), '{}'::jsonb) AS source_metadata
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

export const CORE_LIVE_IDENTITY_FALLBACK_SQL = `
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
		), '[]'::jsonb) AS teams,
		COALESCE((
			SELECT jsonb_agg((to_jsonb(player_row) - 'season_id') ORDER BY element_id)
			FROM fpl.players player_row WHERE season_id = $1
		), '[]'::jsonb) AS players
	FROM authority
`;

export const DATA_SNAPSHOT_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "data-snapshot.core-fallback",
		sql: CORE_FALLBACK_SQL,
		values: [2026],
		runtime: "must-return-core",
		resultTypes: [
			{ relation: "fpl.events", column: "event_id", pgType: "integer" },
			{
				relation: "fpl.events",
				column: "name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{ relation: "fpl.events", column: "deadline_time", pgType: "timestamp with time zone" },
			{ relation: "fpl.events", column: "finished", pgType: "boolean" },
			{ relation: "fpl.events", column: "data_checked", pgType: "boolean" },
			{ relation: "fpl.events", column: "data_checked_at", pgType: "timestamp with time zone" },
			{ relation: "fpl.events", column: "average_entry_score", pgType: "integer" },
			{ relation: "fpl.events", column: "highest_score", pgType: "integer" },
			{ relation: "fpl.events", column: "is_previous", pgType: "boolean" },
			{ relation: "fpl.events", column: "is_current", pgType: "boolean" },
			{ relation: "fpl.events", column: "is_next", pgType: "boolean" },
			{ relation: "fpl.events", column: "cup_league_create", pgType: "boolean" },
			{ relation: "fpl.events", column: "h2h_ko_matches_created", pgType: "boolean" },
			{
				relation: "fpl.events",
				column: "chip_plays",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{ relation: "fpl.events", column: "average_entry_score", pgType: "integer" },
			{ relation: "fpl.events", column: "highest_scoring_entry", pgType: "bigint" },
			{ relation: "fpl.events", column: "deadline_time_epoch", pgType: "bigint" },
			{ relation: "fpl.events", column: "deadline_time_game_offset", pgType: "integer" },
			{ relation: "fpl.events", column: "highest_score", pgType: "integer" },
			{ relation: "fpl.events", column: "most_selected", pgType: "integer" },
			{ relation: "fpl.events", column: "most_transferred_in", pgType: "integer" },
			{ relation: "fpl.events", column: "top_element", pgType: "integer" },
			{
				relation: "fpl.events",
				column: "top_element_info",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{ relation: "fpl.events", column: "transfers_made", pgType: "bigint" },
			{ relation: "fpl.events", column: "most_captained", pgType: "integer" },
			{ relation: "fpl.events", column: "most_vice_captained", pgType: "integer" },
			{ relation: "fpl.teams", column: "team_id", pgType: "integer" },
			{ relation: "fpl.teams", column: "code", pgType: "integer" },
			{
				relation: "fpl.teams",
				column: "name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "fpl.teams",
				column: "short_name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{ relation: "fpl.teams", column: "strength", pgType: "integer" },
			{ relation: "fpl.teams", column: "position", pgType: "integer" },
			{ relation: "fpl.teams", column: "points", pgType: "integer" },
			{ relation: "fpl.teams", column: "played", pgType: "integer" },
			{ relation: "fpl.teams", column: "win", pgType: "integer" },
			{ relation: "fpl.teams", column: "draw", pgType: "integer" },
			{ relation: "fpl.teams", column: "loss", pgType: "integer" },
			{
				relation: "fpl.teams",
				column: "form",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{ relation: "fpl.teams", column: "strength_overall_home", pgType: "integer" },
			{ relation: "fpl.teams", column: "strength_overall_away", pgType: "integer" },
			{ relation: "fpl.teams", column: "strength_attack_home", pgType: "integer" },
			{ relation: "fpl.teams", column: "strength_attack_away", pgType: "integer" },
			{ relation: "fpl.teams", column: "strength_defence_home", pgType: "integer" },
			{ relation: "fpl.teams", column: "strength_defence_away", pgType: "integer" },
			{ relation: "fpl.players", column: "element_id", pgType: "integer" },
			{ relation: "fpl.players", column: "code", pgType: "integer" },
			{ relation: "fpl.players", column: "element_type", pgType: "integer" },
			{ relation: "fpl.players", column: "team_id", pgType: "integer" },
			{ relation: "fpl.players", column: "price", pgType: "integer" },
			{ relation: "fpl.players", column: "start_price", pgType: "integer" },
			{
				relation: "fpl.players",
				column: "first_name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "fpl.players",
				column: "second_name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{
				relation: "fpl.players",
				column: "web_name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{ relation: "fpl.players", column: "total_points", pgType: "integer" },
			{ relation: "fpl.phases", column: "phase_id", pgType: "integer" },
			{
				relation: "fpl.phases",
				column: "name",
				pgType: "text",
				acceptedPgTypes: ["character varying"],
			},
			{ relation: "fpl.phases", column: "start_event", pgType: "integer" },
			{ relation: "fpl.phases", column: "stop_event", pgType: "integer" },
			{ relation: "fpl.phases", column: "highest_score", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "fixture_id", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "code", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "event_id", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "kickoff_time", pgType: "timestamp with time zone" },
			{ relation: "fpl.fixtures", column: "started", pgType: "boolean" },
			{ relation: "fpl.fixtures", column: "finished", pgType: "boolean" },
			{ relation: "fpl.fixtures", column: "finished_provisional", pgType: "boolean" },
			{ relation: "fpl.fixtures", column: "minutes", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "team_h_id", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "team_a_id", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "team_h_score", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "team_a_score", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "team_h_difficulty", pgType: "integer" },
			{ relation: "fpl.fixtures", column: "team_a_difficulty", pgType: "integer" },
		],
	},
	{ name: "data-snapshot.core-phase-shape", sql: CORE_PHASE_SHAPE_SQL, values: [2026] },
	{
		name: "data-snapshot.core-live-identity-fallback",
		sql: CORE_LIVE_IDENTITY_FALLBACK_SQL,
		values: [2026],
	},
];

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
	const sourceMetadata = isRecord(row?.source_metadata) ? row.source_metadata : null;
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
		selectionRules: mapCoreSelectionRules(sourceMetadata?.selectionRules),
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
	const snapshot = parseCoreFallbackRow(
		result.rows[0],
		context.currentSeason.seasonCode,
		expectedManifest
	);
	if (!snapshot) {
		throw new Error("Coherent PostgreSQL core publication is unavailable");
	}
	return snapshot;
};

export const getCoreDataSnapshot = (context: GraphQLContext): Promise<CoreDataSnapshot> => {
	context.fullCoreLoaded = true;
	if (context.requestScope && typeof context.requestScope === "object") {
		(context.requestScope as { fullCoreLoaded?: boolean }).fullCoreLoaded = true;
	}
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

/** Load the same coherent core publication, including official selection rules. */
export const getTeamSelectionCoreSnapshot = (
	context: GraphQLContext
): Promise<CoreDataSnapshot> => {
	const requestScope = context.requestScope ?? context;
	const existing = teamSelectionCoreSnapshotMemo.get(requestScope);
	if (existing) return bindCoreRevision(context, existing);
	const load = (async (): Promise<CoreDataSnapshot> => {
		const publication = await readPinnedCorePublicationItems(
			context,
			TEAM_SELECTION_CORE_PUBLICATION_ITEMS
		);
		const snapshot = publication ? publicationCoreSnapshot(publication) : null;
		if (snapshot) return snapshot;
		return getCoreDataSnapshot(context);
	})();
	teamSelectionCoreSnapshotMemo.set(requestScope, load);
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
		const publication = await readPinnedCorePublicationItems(context, [
			"events",
			"currentEventId",
			"selectionRules",
		]);
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

/** Live desks need only team labels and player identity, not the full core. */
export const getCoreLiveIdentitySnapshot = (
	context: GraphQLContext
): Promise<CoreLiveIdentitySnapshot> => {
	const requestScope = context.requestScope ?? context;
	const existing = coreLiveIdentitySnapshotMemo.get(requestScope);
	if (existing) return bindCoreRevision(context, existing);
	const load = (async (): Promise<CoreLiveIdentitySnapshot> => {
		const publication = await readPinnedCorePublicationItems(context, ["teams", "players"]);
		const snapshot = publication ? publicationCoreLiveIdentitySnapshot(publication) : null;
		if (snapshot) return snapshot;
		const expectedManifest = await reserveCorePublicationPin(context, "manifest").manifest;
		const result = await context.database.query<CoreLiveIdentityFallbackRow>(
			CORE_LIVE_IDENTITY_FALLBACK_SQL,
			[context.currentSeason.seasonId]
		);
		const row = result.rows[0];
		const authority = validateTargetedCoreAuthority(context, row, expectedManifest);
		const teams = mapArray(row?.teams, mapCoreTeam);
		const players = mapArray(row?.players, mapCorePlayer);
		if (
			!authority ||
			!teams ||
			!players ||
			teams.length === 0 ||
			players.length === 0 ||
			players.some((player) => !teams.some((team) => team.id === player.teamId))
		) {
			throw new Error("Coherent PostgreSQL core live identity publication is unavailable");
		}
		return {
			source: "postgres",
			seasonCode: context.currentSeason.seasonCode,
			revision: String(authority.revision),
			publicationId: authority.publicationId,
			sourceCheckedAt: authority.sourceCheckedAt,
			teams,
			players,
		};
	})();
	coreLiveIdentitySnapshotMemo.set(requestScope, load);
	return bindCoreRevision(context, load);
};

export const coreDatasetRevision = (snapshot: CoreDataSnapshot): string =>
	`core-${snapshot.revision}`;

/**
 * Return the current Core publication revision without loading the complete
 * Core payload. Lightweight roots still need this identity when they build a
 * revisioned GraphQL query-cache key. If Redis has no valid manifest, reuse
 * the normal coherent PostgreSQL fallback so the cache never gets an
 * unversioned or synthetic authority.
 */
export const getCoreDatasetRevision = async (context: GraphQLContext): Promise<string> => {
	const manifest = await reserveCorePublicationPin(context, "manifest").manifest;
	if (manifest) return `core-${manifest.revision}`;
	return coreDatasetRevision(await getCoreDataSnapshot(context));
};
