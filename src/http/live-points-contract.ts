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
	"tournamentDetailDesk",
	"gameweekDesk",
]);

export const isLivePointsRootField = (field: string): boolean => LIVE_POINTS_ROOT_FIELDS.has(field);

const LIVE_POINTS_HOT_PATH_ROOT_FIELDS = new Set([
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
]);

export const isLivePointsHotPathRootField = (field: string): boolean =>
	LIVE_POINTS_HOT_PATH_ROOT_FIELDS.has(field);

// These roots are bounded, read-only companions that do not require the full
// Data Core refresh.  A query containing one alongside a V2 live root must
// stay on the Redis-first admission path.
const LIVE_POINTS_HOT_PATH_SAFE_COMPANION_ROOT_FIELDS = new Set([
	"_empty",
	"__typename",
	"__schema",
	"__type",
	"event",
	"events",
	"currentEventInfo",
	"coreEventContext",
	"fixtures",
	"eventFixtures",
]);

export const isLivePointsHotPathSafeCompanionRootField = (field: string): boolean =>
	LIVE_POINTS_HOT_PATH_SAFE_COMPANION_ROOT_FIELDS.has(field);

export const isLivePointsHotPathOperation = (rootFields: readonly string[]): boolean =>
	rootFields.some(isLivePointsHotPathRootField) &&
	rootFields.every(
		(field) =>
			isLivePointsHotPathRootField(field) || isLivePointsHotPathSafeCompanionRootField(field)
	);

export const requiresLivePointsV2Contract = (rootFields: readonly string[]): boolean =>
	rootFields.some(isLivePointsRootField);

export const hasLivePointsV2Contract = (headers: Headers): boolean =>
	headers.get(LIVE_POINTS_CONTRACT_HEADER) === LIVE_POINTS_CONTRACT_VALUE;
