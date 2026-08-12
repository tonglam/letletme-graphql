import type { GraphQLContext } from "../graphql/context";
import { getCoreDataSnapshot, getCoreFixtureSnapshot, type CoreTeamData } from "./data-snapshot";
import type { Team } from "./types";

const mapTeam = (team: CoreTeamData): Team => ({
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
});

const mapTeams = (teams: readonly CoreTeamData[]): Map<number, Team> =>
	new Map(teams.map((team) => [team.id, mapTeam(team)]));

export async function buildTeamMap(context: GraphQLContext): Promise<Map<number, Team>> {
	const snapshot = await getCoreDataSnapshot(context);
	return mapTeams(snapshot.teams);
}

export async function buildFixtureTeamMap(context: GraphQLContext): Promise<Map<number, Team>> {
	const snapshot = await getCoreFixtureSnapshot(context);
	return mapTeams(snapshot.teams);
}

export const buildTeamMapById = (teams: Team[]): Map<number, Team> =>
	new Map(teams.map((team) => [team.id, team]));
