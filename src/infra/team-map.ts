import type { GraphQLContext } from "../graphql/context";
import { getCoreDataSnapshot } from "./data-snapshot";
import type { Team } from "./types";

export async function buildTeamMap(context: GraphQLContext): Promise<Map<number, Team>> {
	const snapshot = await getCoreDataSnapshot(context);
	return new Map(
		snapshot.teams.map((team) => [
			team.id,
			{
				id: team.id,
				code: team.code,
				name: team.name,
				shortName: team.shortName,
				strength: team.strength,
				position: team.position,
				points: team.points,
				played: team.played,
				win: team.win,
				draw: team.draw,
				loss: team.loss,
				form: team.form,
				strengthOverallHome: team.strengthOverallHome,
				strengthOverallAway: team.strengthOverallAway,
				strengthAttackHome: team.strengthAttackHome,
				strengthAttackAway: team.strengthAttackAway,
				strengthDefenceHome: team.strengthDefenceHome,
				strengthDefenceAway: team.strengthDefenceAway,
			} satisfies Team,
		])
	);
}

export const buildTeamMapById = (teams: Team[]): Map<number, Team> =>
	new Map(teams.map((team) => [team.id, team]));
