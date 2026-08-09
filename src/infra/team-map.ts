import type { GraphQLContext } from "../graphql/context";
import { getCurrentSeason } from "./season";
import type { Team } from "./types";

export async function buildTeamMap(context: GraphQLContext): Promise<Map<number, Team>> {
	const season = await getCurrentSeason(context);
	const hashKey = `Team:${season}`;
	const result = new Map<number, Team>();

	try {
		const hash = await context.redis.hgetall(hashKey);
		if (hash && Object.keys(hash).length > 0) {
			for (const [hashField, value] of Object.entries(hash)) {
				const parsed = JSON.parse(value) as Record<string, unknown>;
				const team = parseTeam(parsed, hashField);
				if (!team) throw new Error("Malformed Team hash row");
				result.set(team.id, team);
			}
			return result;
		}
	} catch (err) {
		context.logger.warn(
			{ err, hashKey },
			"Failed to read Team hash from Redis, falling back to DB"
		);
	}

	const { data, error } = await context.supabase
		.from("teams")
		.select(
			"id, code, name, short_name, strength, position, points, played, win, draw, loss, form, strength_overall_home, strength_overall_away, strength_attack_home, strength_attack_away, strength_defence_home, strength_defence_away"
		)
		.order("position", { ascending: true });

	if (error) {
		throw new Error("Failed to fetch teams", { cause: error });
	}
	if (data) {
		for (const row of data as Record<string, unknown>[]) {
			const team = parseTeamFromDb(row);
			result.set(team.id, team);
		}
	}
	return result;
}

export const buildTeamMapById = (teams: Team[]): Map<number, Team> =>
	new Map(teams.map((team) => [team.id, team]));

const parseNullableNumber = (value: unknown): number | null => {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "number" && typeof value !== "string") return null;
	const parsed = typeof value === "string" ? Number(value.trim()) : value;
	return Number.isInteger(parsed) && Number.isFinite(parsed) ? parsed : null;
};

const parseRequiredInteger = (value: unknown): number | null => {
	if (value === null || value === undefined) return null;
	if (typeof value === "string" && value.trim().length === 0) return null;
	if (typeof value !== "number" && typeof value !== "string") return null;
	const parsed = typeof value === "string" ? Number(value.trim()) : value;
	return Number.isInteger(parsed) && Number.isFinite(parsed) ? parsed : null;
};

const parseCachedInteger = (value: unknown, fallback = 0): number | null =>
	value === undefined || value === null ? fallback : parseRequiredInteger(value);

function parseTeam(parsed: Record<string, unknown>, hashField?: string): Team | null {
	const id = parseRequiredInteger(parsed.id);
	const name = String(parsed.name ?? "").trim();
	const shortName = String(parsed.shortName ?? parsed.short_name ?? "").trim();
	const code = parseCachedInteger(parsed.code);
	const position = parseCachedInteger(parsed.position);
	const points = parseCachedInteger(parsed.points);
	const played = parseCachedInteger(parsed.played);
	const win = parseCachedInteger(parsed.win);
	const draw = parseCachedInteger(parsed.draw);
	const loss = parseCachedInteger(parsed.loss);
	const strengthOverallHome = parseCachedInteger(
		parsed.strengthOverallHome ?? parsed.strength_overall_home
	);
	const strengthOverallAway = parseCachedInteger(
		parsed.strengthOverallAway ?? parsed.strength_overall_away
	);
	const strengthAttackHome = parseCachedInteger(
		parsed.strengthAttackHome ?? parsed.strength_attack_home
	);
	const strengthAttackAway = parseCachedInteger(
		parsed.strengthAttackAway ?? parsed.strength_attack_away
	);
	const strengthDefenceHome = parseCachedInteger(
		parsed.strengthDefenceHome ?? parsed.strength_defence_home
	);
	const strengthDefenceAway = parseCachedInteger(
		parsed.strengthDefenceAway ?? parsed.strength_defence_away
	);
	if (
		id === null ||
		id <= 0 ||
		(hashField !== undefined && hashField !== String(id)) ||
		name.length === 0 ||
		shortName.length === 0 ||
		code === null ||
		position === null ||
		points === null ||
		played === null ||
		win === null ||
		draw === null ||
		loss === null ||
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
		strength: parseNullableNumber(parsed.strength),
		position,
		points,
		played,
		win,
		draw,
		loss,
		form: parsed.form ? String(parsed.form) : null,
		strengthOverallHome,
		strengthOverallAway,
		strengthAttackHome,
		strengthAttackAway,
		strengthDefenceHome,
		strengthDefenceAway,
	};
}

function parseTeamFromDb(row: Record<string, unknown>): Team {
	return {
		id: Number(row.id),
		code: Number(row.code ?? 0),
		name: String(row.name ?? ""),
		shortName: String(row.short_name ?? ""),
		strength: parseNullableNumber(row.strength),
		position: Number(row.position ?? 0),
		points: Number(row.points ?? 0),
		played: Number(row.played ?? 0),
		win: Number(row.win ?? 0),
		draw: Number(row.draw ?? 0),
		loss: Number(row.loss ?? 0),
		form: row.form ? String(row.form) : null,
		strengthOverallHome: Number(row.strength_overall_home ?? 0),
		strengthOverallAway: Number(row.strength_overall_away ?? 0),
		strengthAttackHome: Number(row.strength_attack_home ?? 0),
		strengthAttackAway: Number(row.strength_attack_away ?? 0),
		strengthDefenceHome: Number(row.strength_defence_home ?? 0),
		strengthDefenceAway: Number(row.strength_defence_away ?? 0),
	};
}
