import type { Player, Team } from "../../infra/types";
import type { LivePerformance } from "../live/repository";
import type { EntryEventTransferRow } from "./repository";

export type EntryEventTransfersData = {
	event: number;
	entry: number;
	elementIn: number;
	elementInWebName: string;
	elementInType: number;
	elementInTypeName: string;
	elementInTeamId: number;
	elementInTeamName: string;
	elementInTeamShortName: string;
	elementInCost: number;
	elementInPoints: number;
	elementInPlayed: boolean;
	elementOut: number;
	elementOutWebName: string;
	elementOutTeamId: number;
	elementOutTeamName: string;
	elementOutTeamShortName: string;
	elementOutType: number;
	elementOutTypeName: string;
	elementOutCost: number;
	elementOutPoints: number;
	elementOutPlayed: boolean;
	time: string;
};

const elementTypeName = (position: number | undefined): string => {
	switch (position) {
		case 1:
			return "GKP";
		case 2:
			return "DEF";
		case 3:
			return "MID";
		case 4:
			return "FWD";
		default:
			return "";
	}
};

export const buildTeamMapById = (teams: Team[]): Map<number, Team> =>
	new Map(teams.map((team) => [team.id, team]));

export const enrichTransferRows = (params: {
	entryId: number;
	eventId: number;
	transferRows: EntryEventTransferRow[];
	playersById: Map<number, Player>;
	teamsById: Map<number, Team>;
	liveByPlayer: Map<number, LivePerformance>;
}): EntryEventTransfersData[] => {
	const {
		entryId,
		eventId,
		transferRows,
		playersById,
		teamsById,
		liveByPlayer,
	} = params;

	return transferRows.map((row) => {
		const inPlayer = playersById.get(row.elementIn);
		const outPlayer = playersById.get(row.elementOut);
		const inTeam = inPlayer ? teamsById.get(inPlayer.teamId) : undefined;
		const outTeam = outPlayer ? teamsById.get(outPlayer.teamId) : undefined;
		const inLive = liveByPlayer.get(row.elementIn);
		const outLive = liveByPlayer.get(row.elementOut);

		return {
			event: eventId,
			entry: entryId,
			elementIn: row.elementIn,
			elementInWebName: inPlayer?.webName ?? "",
			elementInType: inPlayer?.position ?? 0,
			elementInTypeName: elementTypeName(inPlayer?.position),
			elementInTeamId: inPlayer?.teamId ?? 0,
			elementInTeamName: inTeam?.name ?? "",
			elementInTeamShortName: inTeam?.shortName ?? "",
			elementInCost: inPlayer?.price ?? 0,
			elementInPoints: inLive?.totalPoints ?? 0,
			elementInPlayed: (inLive?.minutes ?? 0) > 0,
			elementOut: row.elementOut,
			elementOutWebName: outPlayer?.webName ?? "",
			elementOutTeamId: outPlayer?.teamId ?? 0,
			elementOutTeamName: outTeam?.name ?? "",
			elementOutTeamShortName: outTeam?.shortName ?? "",
			elementOutType: outPlayer?.position ?? 0,
			elementOutTypeName: elementTypeName(outPlayer?.position),
			elementOutCost: outPlayer?.price ?? 0,
			elementOutPoints: outLive?.totalPoints ?? 0,
			elementOutPlayed: (outLive?.minutes ?? 0) > 0,
			time: row.time ?? "",
		};
	});
};
