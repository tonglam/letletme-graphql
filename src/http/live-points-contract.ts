export const LIVE_POINTS_CONTRACT_HEADER = "X-LetLetMe-Contract";
export const LIVE_POINTS_CONTRACT_VALUE = "live-points-v2";

const LIVE_POINTS_ROOT_FIELDS = new Set([
	"calcLivePointsByEntry",
	"calcLivePointsForEntries",
	"liveScores",
	"playerLive",
	"eventLive",
	"eventLiveExplain",
	"eventLiveExplains",
	"liveSnapshot",
	"liveContext",
	"liveMatchdayDesk",
	"liveFixturePlayers",
	"entryLiveCompetitionBoard",
	"entryLiveCompetitionsDesk",
	"tournamentSelectionIndex",
	"tournamentEntrySquads",
]);

export const isLivePointsRootField = (field: string): boolean => LIVE_POINTS_ROOT_FIELDS.has(field);

export const requiresLivePointsV2Contract = (rootFields: readonly string[]): boolean =>
	rootFields.some(isLivePointsRootField);

export const hasLivePointsV2Contract = (headers: Headers): boolean =>
	headers.get(LIVE_POINTS_CONTRACT_HEADER) === LIVE_POINTS_CONTRACT_VALUE;
