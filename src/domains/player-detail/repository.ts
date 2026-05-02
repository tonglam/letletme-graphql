import type { GraphQLContext } from "../../graphql/context";
import { getCurrentSeason } from "../../infra/season";

export type PlayerDetail = {
	id: number;
	webName: string;
	teamShortName: string;
	elementType: number;
	elementTypeName: string;
	price: number;
	startPrice: number;
	totalPoints: number;

	selectedByPercent: number | null;
	form: number | null;
	seasonTransfersIn: number;
	seasonTransfersOut: number;
	transfersInEvent: number;
	transfersOutEvent: number;

	eventPoints: number | null;
	minutes: number | null;
	goalsScored: number;
	assists: number;
	cleanSheets: number;
	goalsConceded: number;
	ownGoals: number;
	penaltiesSaved: number;
	yellowCards: number;
	redCards: number;
	saves: number;
	bonus: number;
	bps: number;

	influence: number | null;
	creativity: number | null;
	threat: number | null;
	ictIndex: number | null;

	fixtures: PlayerFixture[];
};

export type PlayerFixture = {
	event: number;
	againstTeamShortName: string;
	wasHome: boolean;
	finished: boolean;
	kickoffTime: string | null;
	score: string | null;
	difficulty: number;
	bgw: boolean;
};

const elementTypeToName = (type: number): string => {
	switch (type) {
		case 1:
			return "GOALKEEPER";
		case 2:
			return "DEFENDER";
		case 3:
			return "MIDFIELDER";
		case 4:
			return "FORWARD";
		default:
			return "";
	}
};

const parseNum = (value: unknown): number | null => {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const p = Number.parseFloat(value.trim());
		return Number.isFinite(p) ? p : null;
	}
	return null;
};

const parseInt_ = (value: unknown): number | null => {
	const n = parseNum(value);
	return n === null ? null : Math.trunc(n);
};

const parseBool = (value: unknown): boolean => {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		return v === "true" || v === "1";
	}
	return false;
};

const parseJson = (value: string): Record<string, unknown> | null => {
	try {
		const p: unknown = JSON.parse(value);
		if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
		return p as Record<string, unknown>;
	} catch {
		return null;
	}
};

const pickValue = (
	source: Record<string, unknown>,
	primary: string,
	...aliases: string[]
): unknown => {
	if (Object.hasOwn(source, primary) && source[primary] !== undefined) {
		return source[primary];
	}
	for (const alias of aliases) {
		if (Object.hasOwn(source, alias) && source[alias] !== undefined) {
			return source[alias];
		}
	}
	return null;
};

async function loadPlayerFromRedis(
	context: GraphQLContext,
	season: string,
	playerId: number,
): Promise<{
	webName: string;
	elementType: number;
	teamId: number;
	price: number;
	startPrice: number;
} | null> {
	const hashKey = `Player:${season}`;
	const raw = await context.redis.hget(hashKey, String(playerId));
	if (!raw) return null;

	const p = parseJson(raw);
	if (!p) return null;

	return {
		webName: String(p.webName ?? ""),
		elementType: parseInt_(p.type ?? p.elementType) ?? 0,
		teamId: parseInt_(p.teamId ?? p.team_id) ?? 0,
		price: parseInt_(p.price ?? p.nowCost) ?? 0,
		startPrice: parseInt_(p.startPrice ?? p.start_price) ?? 0,
	};
}

async function loadTeamShortNameFromRedis(
	context: GraphQLContext,
	season: string,
	teamId: number,
): Promise<string> {
	const raw = await context.redis.hget(`Team:${season}`, String(teamId));
	if (!raw) return "";
	const t = parseJson(raw);
	return t ? String(t.shortName ?? t.short_name ?? "") : "";
}

async function loadPlayerStatFromRedis(
	context: GraphQLContext,
	season: string,
	playerId: number,
): Promise<Record<string, unknown> | null> {
	const raw = await context.redis.hget(
		`PlayerStat:${season}`,
		String(playerId),
	);
	if (!raw) return null;
	return parseJson(raw);
}

async function loadEventLiveFromRedis(
	context: GraphQLContext,
	season: string,
	eventId: number,
	playerId: number,
): Promise<Record<string, unknown> | null> {
	const raw = await context.redis.hget(
		`EventLive:${season}:${eventId}`,
		String(playerId),
	);
	if (!raw) return null;
	return parseJson(raw);
}

async function loadTeamFixtures(
	context: GraphQLContext,
	season: string,
	teamId: number,
): Promise<PlayerFixture[]> {
	const hashKey = `FixturesByTeam:${season}:${teamId}`;
	const hash = await context.redis.hgetall(hashKey);

	const fixtures: PlayerFixture[] = [];

	for (const [eventStr, rawValue] of Object.entries(hash)) {
		const f = parseJson(rawValue);
		if (!f) continue;

		const event = parseInt_(f.event ?? eventStr) ?? 0;
		if (event <= 0) continue;

		fixtures.push({
			event,
			againstTeamShortName: String(
				f.againstTeamShortName ?? f.against_team_short_name ?? "",
			),
			wasHome: parseBool(f.wasHome ?? f.was_home),
			finished: parseBool(f.finished),
			kickoffTime: String(f.kickoffTime ?? f.kickoff_time ?? "") || null,
			score: f.score ? String(f.score) : null,
			difficulty: parseInt_(f.difficulty) ?? 0,
			bgw: parseBool(f.bgw),
		});
	}

	fixtures.sort((a, b) => a.event - b.event);
	return fixtures;
}

function buildPlayerDetailCacheKey(playerId: number, eventId: number): string {
	return `player_detail:${playerId}:${eventId}`;
}

function mapPlayerDetail(
	playerId: number,
	player: {
		webName: string;
		elementType: number;
		price: number;
		startPrice: number;
	},
	teamShortName: string,
	playerStat: Record<string, unknown> | null,
	eventLive: Record<string, unknown> | null,
	fixtures: PlayerFixture[],
): PlayerDetail {
	const elementType = player.elementType;

	// Season cumulative stats from PlayerStat
	const totalPoints =
		parseInt_(pickValue(playerStat ?? {}, "totalPoints", "total_points")) ?? 0;
	const selectedByPercent = parseNum(
		pickValue(playerStat ?? {}, "selectedByPercent", "selected_by_percent"),
	);
	const form = parseNum(pickValue(playerStat ?? {}, "form"));
	const seasonTransfersIn =
		parseInt_(pickValue(playerStat ?? {}, "transfersIn", "transfers_in")) ?? 0;
	const seasonTransfersOut =
		parseInt_(pickValue(playerStat ?? {}, "transfersOut", "transfers_out")) ??
		0;

	// Event-specific stats from EventLive (preferred) or PlayerStat (fallback)
	const eventSource = eventLive ?? playerStat ?? {};

	const eventPoints = eventLive
		? (parseInt_(pickValue(eventLive, "totalPoints", "total_points")) ?? null)
		: null;

	const minutes = parseInt_(pickValue(eventSource, "minutes"));
	const goalsScored =
		parseInt_(pickValue(eventSource, "goalsScored", "goals_scored")) ?? 0;
	const assists = parseInt_(pickValue(eventSource, "assists")) ?? 0;
	const cleanSheets =
		parseInt_(pickValue(eventSource, "cleanSheets", "clean_sheets")) ?? 0;
	const goalsConceded =
		parseInt_(pickValue(eventSource, "goalsConceded", "goals_conceded")) ?? 0;
	const ownGoals =
		parseInt_(pickValue(eventSource, "ownGoals", "own_goals")) ?? 0;
	const penaltiesSaved =
		parseInt_(pickValue(eventSource, "penaltiesSaved", "penalties_saved")) ?? 0;
	const yellowCards =
		parseInt_(pickValue(eventSource, "yellowCards", "yellow_cards")) ?? 0;
	const redCards =
		parseInt_(pickValue(eventSource, "redCards", "red_cards")) ?? 0;
	const saves = parseInt_(pickValue(eventSource, "saves")) ?? 0;
	const bonus = parseInt_(pickValue(eventSource, "bonus")) ?? 0;
	const bps = parseInt_(pickValue(eventSource, "bps")) ?? 0;

	const influence = parseNum(pickValue(eventSource, "influence"));
	const creativity = parseNum(pickValue(eventSource, "creativity"));
	const threat = parseNum(pickValue(eventSource, "threat"));
	const ictIndex = parseNum(pickValue(eventSource, "ictIndex", "ict_index"));

	const transfersInEvent =
		parseInt_(
			pickValue(eventSource, "transfersInEvent", "transfers_in_event"),
		) ?? 0;
	const transfersOutEvent =
		parseInt_(
			pickValue(eventSource, "transfersOutEvent", "transfers_out_event"),
		) ?? 0;

	return {
		id: playerId,
		webName: player.webName,
		teamShortName,
		elementType,
		elementTypeName: elementTypeToName(elementType),
		price: player.price,
		startPrice: player.startPrice,
		totalPoints,

		selectedByPercent,
		form,
		seasonTransfersIn,
		seasonTransfersOut,
		transfersInEvent,
		transfersOutEvent,

		eventPoints,
		minutes,
		goalsScored,
		assists,
		cleanSheets,
		goalsConceded,
		ownGoals,
		penaltiesSaved,
		yellowCards,
		redCards,
		saves,
		bonus,
		bps,

		influence,
		creativity,
		threat,
		ictIndex,

		fixtures,
	};
}

export interface PlayerDetailRepository {
	getPlayerDetail(
		context: GraphQLContext,
		playerId: number,
		eventId: number,
	): Promise<PlayerDetail | null>;
}

const NULL_SENTINEL = "__pd:null__";

export const playerDetailRepository: PlayerDetailRepository = {
	async getPlayerDetail(
		context: GraphQLContext,
		playerId: number,
		eventId: number,
	): Promise<PlayerDetail | null> {
		if (!Number.isFinite(playerId) || playerId <= 0) return null;
		if (!Number.isFinite(eventId) || eventId <= 0) return null;

		const cacheKey = buildPlayerDetailCacheKey(playerId, eventId);
		const cached = await context.redis.get(cacheKey);
		if (cached !== null) {
			if (cached === NULL_SENTINEL) return null;
			try {
				return JSON.parse(cached) as PlayerDetail;
			} catch {
				// fall through to fetch
			}
		}

		const season = await getCurrentSeason(context);

		// Parallel: load player info + stats/live/fixtures (stats/live need teamId so only player is first)
		const [player, playerStat, eventLive] = await Promise.all([
			loadPlayerFromRedis(context, season, playerId),
			loadPlayerStatFromRedis(context, season, playerId),
			loadEventLiveFromRedis(context, season, eventId, playerId),
		]);

		if (!player) {
			context.logger.warn({ playerId }, "Player not found in Redis");
			await context.redis.set(cacheKey, NULL_SENTINEL, "EX", 3600);
			return null;
		}

		const [teamShortName, fixtures] = await Promise.all([
			loadTeamShortNameFromRedis(context, season, player.teamId),
			loadTeamFixtures(context, season, player.teamId),
		]);

		const detail = mapPlayerDetail(
			playerId,
			player,
			teamShortName,
			playerStat,
			eventLive,
			fixtures,
		);

		await context.redis.set(cacheKey, JSON.stringify(detail), "EX", 3600);
		return detail;
	},
};
