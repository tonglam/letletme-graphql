import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import {
	getTeamSelectionCoreSnapshot,
	type CoreDataSnapshot,
	type CoreSelectionRules,
} from "../../infra/data-snapshot";
import {
	getMarketSnapshotContext,
	refreshMarketSnapshotContext,
	type MarketSnapshotContext,
} from "../market/context";

const MAX_EVENT_ID = 38;
const MAX_HORIZON = 8;

type SelectionPhase =
	| "PRESEASON"
	| "PRE_DEADLINE"
	| "LIVE"
	| "SETTLING"
	| "SETTLED"
	| "BETWEEN_GAMEWEEKS"
	| "OFFSEASON"
	| "UNAVAILABLE";

const error = (message: string, code: string): GraphQLError =>
	new GraphQLError(message, { extensions: { code } });

const phaseFor = (
	event: CoreDataSnapshot["events"][number],
	snapshot: CoreDataSnapshot,
	requestedEventId: number,
	now: number
): SelectionPhase => {
	const deadline = event.deadlineTime ? Date.parse(event.deadlineTime) : Number.NaN;
	if (snapshot.currentEventId === null && requestedEventId === 1 && !event.finished) {
		return Number.isFinite(deadline) && deadline > now ? "PRESEASON" : "LIVE";
	}
	if (!event.finished && Number.isFinite(deadline) && deadline > now) return "PRE_DEADLINE";
	if (!event.finished && snapshot.currentEventId === requestedEventId) return "LIVE";
	if (event.finished) {
		const latestFinished = snapshot.events
			.filter((candidate) => candidate.finished)
			.sort((left, right) => right.id - left.id)[0]?.id;
		return latestFinished === requestedEventId ? "SETTLED" : "SETTLING";
	}
	return "UNAVAILABLE";
};

const positionName = (id: number): "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD" =>
	id === 1 ? "GOALKEEPER" : id === 2 ? "DEFENDER" : id === 3 ? "MIDFIELDER" : "FORWARD";

export type TeamSelectionDesk = {
	season: string;
	coreRevision: string;
	marketRevision: string | null;
	checkedAt: string;
	deadline: string | null;
	phase: SelectionPhase;
	eventId: number;
	horizon: number;
	rules: CoreSelectionRules | null;
	players: Array<Record<string, unknown>>;
	fixtures: Array<Record<string, unknown>>;
	playerPool: {
		state: "AVAILABLE" | "UNAVAILABLE" | "PENDING";
		checkedAt: string | null;
		message: string | null;
	};
	fixtureSection: {
		state: "AVAILABLE" | "UNAVAILABLE" | "PENDING";
		checkedAt: string | null;
		message: string | null;
	};
	rulesSection: {
		state: "AVAILABLE" | "UNAVAILABLE" | "PENDING";
		checkedAt: string | null;
		message: string | null;
	};
};

type MarketFact = {
	price: number;
	ownership: number | null;
	status: string;
	news: string;
	chanceOfPlaying: number | null;
};

const loadMarketFacts = async (
	context: GraphQLContext
): Promise<{ revision: string | null; facts: Map<number, MarketFact> }> => {
	try {
		let marketContext = await getMarketSnapshotContext(context);
		const load = async (pin: MarketSnapshotContext | null) =>
			context.database.query<{
				element_id: number;
				price: number;
				selected_by_percent: number | string | null;
				status: string;
				news: string;
				chance_of_playing_this_round: number | null;
			}>(
				`SELECT DISTINCT ON (element_id)
				element_id, price, selected_by_percent, status, news,
				chance_of_playing_this_round
				 FROM fpl.player_market_snapshots
				 WHERE season_id = $1
				   AND ($2::date IS NULL OR snapshot_date = $2::date)
				   AND ($3::timestamptz IS NULL OR captured_at = $3::timestamptz)
				 ORDER BY element_id, snapshot_date DESC, captured_at DESC`,
				[context.currentSeason.seasonId, pin?.snapshotDate ?? null, pin?.capturedAt ?? null]
			);
		let result = await load(marketContext);
		if (marketContext && result.rows.length === 0) {
			marketContext = await refreshMarketSnapshotContext(context);
			if (!marketContext) throw new Error("Market snapshot pin unavailable after retry");
			result = await load(marketContext);
			if (result.rows.length === 0) throw new Error("Market snapshot pin changed during query");
		}
		return {
			revision: marketContext?.revision ?? null,
			facts: new Map(
				result.rows.map(
					(row) =>
						[
							row.element_id,
							{
								price: row.price,
								ownership:
									row.selected_by_percent === null ? null : Number(row.selected_by_percent),
								status: row.status,
								news: row.news,
								chanceOfPlaying: row.chance_of_playing_this_round,
							},
						] as const
				)
			),
		};
	} catch (marketError) {
		context.logger.warn({ err: marketError }, "Team Selection market facts are unavailable");
		return { revision: null, facts: new Map() };
	}
};

export const teamSelectionTestables = { phaseFor, positionName };

export const teamSelectionService = {
	async getTeamSelectionDesk(
		context: GraphQLContext,
		requestedEventId: number,
		horizon: number
	): Promise<TeamSelectionDesk> {
		if (
			!Number.isSafeInteger(requestedEventId) ||
			requestedEventId < 1 ||
			requestedEventId > MAX_EVENT_ID
		) {
			throw error("Team Selection event ID must be between 1 and 38", "BAD_USER_INPUT");
		}
		if (!Number.isSafeInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON) {
			throw error("Team Selection horizon must be between 1 and 8", "BAD_USER_INPUT");
		}
		const snapshot = await getTeamSelectionCoreSnapshot(context);
		const event = snapshot.events.find((candidate) => candidate.id === requestedEventId);
		if (!event) throw error(`Gameweek event ${requestedEventId} was not found`, "NOT_FOUND");
		const checkedAt = snapshot.sourceCheckedAt;
		const phase = phaseFor(event, snapshot, requestedEventId, Date.now());
		const teamsById = new Map(snapshot.teams.map((team) => [team.id, team] as const));
		const rules = snapshot.selectionRules ?? null;
		const market = await loadMarketFacts(context);
		const players = snapshot.players
			.map((player) => ({
				...(() => {
					const marketFact = market.facts.get(player.id);
					return marketFact
						? {
								price: marketFact.price,
								ownership: marketFact.ownership,
								status: marketFact.status,
								news: marketFact.news,
								chanceOfPlaying: marketFact.chanceOfPlaying,
							}
						: {
								price: player.price,
								ownership: player.selectedByPercent,
								status: null,
								news: null,
								chanceOfPlaying: null,
							};
				})(),
				id: player.id,
				code: player.code,
				webName: player.webName,
				firstName: player.firstName,
				secondName: player.secondName,
				team: teamsById.get(player.teamId),
				position: positionName(player.type),
				form: null,
				totalPoints: player.totalPoints,
			}))
			.filter((player) => player.team !== undefined);
		const eventIds = new Set(
			snapshot.events
				.filter(
					(candidate) =>
						candidate.id >= requestedEventId && candidate.id < requestedEventId + horizon
				)
				.map((candidate) => candidate.id)
		);
		const fixtures = snapshot.fixtures.flatMap((fixture) => {
			if (fixture.eventId === null || !eventIds.has(fixture.eventId)) return [];
			const home = teamsById.get(fixture.teamHId);
			const away = teamsById.get(fixture.teamAId);
			if (!home || !away) return [];
			return [
				{
					id: fixture.id,
					eventId: fixture.eventId,
					kickoffTime: fixture.kickoffTime,
					homeTeam: { id: home.id, name: home.name, shortName: home.shortName },
					awayTeam: { id: away.id, name: away.name, shortName: away.shortName },
					homeDifficulty: fixture.teamHDifficulty,
					awayDifficulty: fixture.teamADifficulty,
				},
			];
		});
		return {
			season: snapshot.seasonCode,
			coreRevision: snapshot.revision,
			marketRevision: market.revision,
			checkedAt,
			deadline: event.deadlineTime,
			phase,
			eventId: requestedEventId,
			horizon,
			rules,
			players,
			fixtures,
			playerPool: {
				state: players.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
				checkedAt,
				message: players.length > 0 ? null : "Official player pool is unavailable.",
			},
			fixtureSection: {
				state: fixtures.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
				checkedAt,
				message:
					fixtures.length > 0
						? null
						: "Official fixtures are unavailable for the requested horizon.",
			},
			rulesSection: {
				state: rules ? "AVAILABLE" : "UNAVAILABLE",
				checkedAt,
				message: rules
					? null
					: "Official selection rules are unavailable; no lineup legality decision is trusted.",
			},
		};
	},
};
