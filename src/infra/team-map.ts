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
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

function parseTeam(parsed: Record<string, unknown>, hashField?: string): Team | null {
	const id = Number(parsed.id ?? 0);
	const name = String(parsed.name ?? "").trim();
	const shortName = String(parsed.shortName ?? parsed.short_name ?? "").trim();
	if (
		!Number.isInteger(id) ||
		id <= 0 ||
		(hashField !== undefined && hashField !== String(id)) ||
		name.length === 0 ||
		shortName.length === 0
	) {
		return null;
	}
	return {
		id,
		code: Number(parsed.code ?? 0),
		name,
		shortName,
		strength: parseNullableNumber(parsed.strength),
		position: Number(parsed.position ?? 0),
		points: Number(parsed.points ?? 0),
		played: Number(parsed.played ?? 0),
		win: Number(parsed.win ?? 0),
		draw: Number(parsed.draw ?? 0),
		loss: Number(parsed.loss ?? 0),
		form: parsed.form ? String(parsed.form) : null,
		strengthOverallHome: Number(parsed.strengthOverallHome ?? parsed.strength_overall_home ?? 0),
		strengthOverallAway: Number(parsed.strengthOverallAway ?? parsed.strength_overall_away ?? 0),
		strengthAttackHome: Number(parsed.strengthAttackHome ?? parsed.strength_attack_home ?? 0),
		strengthAttackAway: Number(parsed.strengthAttackAway ?? parsed.strength_attack_away ?? 0),
		strengthDefenceHome: Number(parsed.strengthDefenceHome ?? parsed.strength_defence_home ?? 0),
		strengthDefenceAway: Number(parsed.strengthDefenceAway ?? parsed.strength_defence_away ?? 0),
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
