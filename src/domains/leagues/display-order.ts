export enum OfficialLeagueKind {
	SYSTEM = "SYSTEM",
	INVITATIONAL = "INVITATIONAL",
	PUBLIC = "PUBLIC",
}

export enum LeagueScoring {
	CLASSIC = "classic",
	H2H = "h2h",
}

const BROADCASTER_SHORT_NAME = /^(brd-|man-brd-)/;

export type LeagueDisplayOrderInput = {
	name: string;
	scoring?: LeagueScoring | "classic" | "h2h" | "CLASSIC" | "H2H";
	type?: LeagueScoring | "classic" | "h2h" | "CLASSIC" | "H2H";
	officialKind: OfficialLeagueKind | null;
	shortName: string | null;
};

export const mapFplOfficialKind = (value: string | null | undefined): OfficialLeagueKind | null => {
	if (value === "s") return OfficialLeagueKind.SYSTEM;
	if (value === "x") return OfficialLeagueKind.INVITATIONAL;
	if (value === "c") return OfficialLeagueKind.PUBLIC;
	return null;
};

export const isBroadcasterShortName = (shortName: string | null | undefined): boolean =>
	typeof shortName === "string" && BROADCASTER_SHORT_NAME.test(shortName);

export const resolveOfficialKind = (
	officialKind: OfficialLeagueKind | null | undefined,
	shortName: string | null | undefined
): OfficialLeagueKind => {
	if (officialKind) return officialKind;
	if (
		isBroadcasterShortName(shortName) ||
		(typeof shortName === "string" && shortName.trim().length > 0)
	) {
		return OfficialLeagueKind.SYSTEM;
	}
	return OfficialLeagueKind.INVITATIONAL;
};

export const isInvitationalLeague = (league: LeagueDisplayOrderInput): boolean =>
	resolveOfficialKind(league.officialKind, league.shortName) === OfficialLeagueKind.INVITATIONAL;

const isH2H = (league: LeagueDisplayOrderInput): boolean => {
	const value = league.scoring ?? league.type ?? LeagueScoring.CLASSIC;
	return value === LeagueScoring.H2H || value === "h2h" || value === "H2H";
};

/**
 * Official FPL mobile My Leagues group order.
 * 0 Broadcaster, 1 Invitational Classic, 2 Invitational H2H,
 * 3 Public Classic, 4 Public H2H, 5 General.
 */
export const officialLeagueGroup = (league: LeagueDisplayOrderInput): number => {
	const kind = resolveOfficialKind(league.officialKind, league.shortName);
	const h2h = isH2H(league);
	if (kind === OfficialLeagueKind.SYSTEM && isBroadcasterShortName(league.shortName)) return 0;
	if (kind === OfficialLeagueKind.INVITATIONAL && !h2h) return 1;
	if (kind === OfficialLeagueKind.INVITATIONAL && h2h) return 2;
	if (kind === OfficialLeagueKind.PUBLIC && !h2h) return 3;
	if (kind === OfficialLeagueKind.PUBLIC && h2h) return 4;
	return 5;
};

export const compareLeaguesForOfficialDisplay = (
	left: LeagueDisplayOrderInput,
	right: LeagueDisplayOrderInput
): number => {
	const groupDelta = officialLeagueGroup(left) - officialLeagueGroup(right);
	if (groupDelta !== 0) return groupDelta;
	return left.name.localeCompare(right.name, "en");
};

export const sortLeaguesForOfficialDisplay = <T extends LeagueDisplayOrderInput>(
	leagues: T[]
): T[] => [...leagues].sort(compareLeaguesForOfficialDisplay);

export const selectHomeInvitationalLeagues = <T extends LeagueDisplayOrderInput>(
	leagues: T[]
): T[] => sortLeaguesForOfficialDisplay(leagues).filter(isInvitationalLeague);
