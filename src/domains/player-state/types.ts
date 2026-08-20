export type PlayerStateTrend =
	"RISING" | "STABLE" | "FALLING" | "MIXED" | "UNAVAILABLE" | "UNKNOWN";

export type PlayerStateConfidence = "HIGH" | "MEDIUM" | "LOW";

export type PlayerStateDirection = "RISING" | "STABLE" | "FALLING" | "UNKNOWN";

export type PlayerStateDimensionKind =
	"AVAILABILITY_ROLE" | "FPL_OUTPUT" | "REAL_WORLD_PROCESS" | "HISTORICAL_RELIABILITY" | "OUTLOOK";

export type PlayerStateDimensionRating =
	| "SECURE"
	| "MANAGED"
	| "AT_RISK"
	| "STRONG"
	| "TYPICAL"
	| "WEAK"
	| "PROVEN"
	| "VARIABLE"
	| "EMERGING"
	| "INSUFFICIENT"
	| "FAVOURABLE"
	| "NEUTRAL"
	| "DIFFICULT"
	| "TEAM_CONTEXT_ONLY"
	| "UNAVAILABLE"
	| "UNKNOWN";

export type PlayerStateMetricSource =
	"FPL_CURRENT" | "FPL_HISTORY" | "UNDERSTAT_CURRENT" | "UNDERSTAT_HISTORY" | "DERIVED";

export type PlayerStateMappingStatus =
	"VERIFIED" | "UNVERIFIED" | "AMBIGUOUS" | "QUARANTINED" | "UNAVAILABLE" | "NOT_APPLICABLE";

export type PlayerStateProvider = "FPL" | "UNDERSTAT";
export type PlayerStateProviderScope = "CURRENT" | "HISTORY";
export type PlayerStateDataStatus = "AVAILABLE" | "UNAVAILABLE";
export type PlayerStateAnalysisStatus =
	"READY" | "PRESEASON" | "INSUFFICIENT" | "NOT_APPLICABLE" | "UNAVAILABLE";
export type PlayerStateProviderMode =
	"FPL_ONLY" | "FPL_WITH_UNDERSTAT_HISTORY" | "FPL_WITH_UNDERSTAT_CURRENT";

export type PlayerSeasonPhase = "PRESEASON" | "ACTIVE" | "COMPLETED";

export type PlayerSeasonSignalCode =
	| "UNDERSTAT_NPXG_PER_90"
	| "UNDERSTAT_XA_PER_90"
	| "UNDERSTAT_NPXG_XA_PER_90"
	| "UNDERSTAT_KEY_PASSES_PER_90"
	| "OFFICIAL_CLEAN_SHEET_RATE"
	| "OFFICIAL_SAVES_PER_90";

export type PlayerSeasonSignal = {
	code: PlayerSeasonSignalCode;
	provider: PlayerStateProvider;
	value: number | null;
	unit: string;
	sampleMinutes: number | null;
	analysisStatus: PlayerStateAnalysisStatus;
	reasonCodes: string[];
};

export type PlayerSeasonTimelinePoint = {
	season: string;
	phase: PlayerSeasonPhase;
	position: number;
	fplTotalPoints: number | null;
	signals: PlayerSeasonSignal[];
};

export type PlayerStateMetric = {
	code: string;
	source: PlayerStateMetricSource;
	value: number | null;
	baseline: number | null;
	percentile: number | null;
	unit: string;
	season: string | null;
	sampleMinutes: number | null;
	sampleSize: number | null;
	smallSample: boolean;
	capability: boolean;
};

export type PlayerRadarAxis = {
	code: string;
	value: number | null;
	percentile: number | null;
	unit: string;
	direction: "HIGHER_IS_BETTER" | "LOWER_IS_BETTER" | "NEUTRAL";
	sampleMinutes: number | null;
	available: boolean;
	capability: boolean;
	reasonCode: string | null;
};

export type PlayerRadarProfile = {
	source: "FPL";
	position: number;
	season: string;
	asOfEventId: number | null;
	sampleMinutes: number;
	smallSample: boolean;
	axes: PlayerRadarAxis[];
};

export type PlayerStateReason = {
	code: string;
	dimension: PlayerStateDimensionKind;
	current: number | null;
	baseline: number | null;
	percentile: number | null;
};

export type PlayerStateDimension = {
	kind: PlayerStateDimensionKind;
	rating: PlayerStateDimensionRating;
	direction: PlayerStateDirection;
	confidence: PlayerStateConfidence;
	reasonCodes: string[];
	metrics: PlayerStateMetric[];
};

export type PlayerStateFixture = {
	id: number;
	opponentTeamShortName: string;
	wasHome: boolean;
	difficulty: number;
	kickoffTime: string | null;
};

export type PlayerStateOutlookGameweek = {
	eventId: number;
	bgw: boolean;
	dgw: boolean;
	averageDifficulty: number | null;
	fixtures: PlayerStateFixture[];
};

export type PlayerStateOutlook = {
	rating: PlayerStateDimensionRating;
	horizon: number;
	averageDifficulty: number | null;
	gameweeks: PlayerStateOutlookGameweek[];
};

export type PlayerStateBaselineSeason = {
	season: string;
	position: number;
	minutes: number;
	pointsPer90: number | null;
	returnRate: number | null;
	bonusPer90: number | null;
	positionPercentile: number | null;
	weight: number;
	expectedMetricsAvailable: boolean;
	understatProcessPercentile: number | null;
};

export type PlayerStateOwnBaseline = {
	weightedPercentile: number | null;
	seasons: PlayerStateBaselineSeason[];
};

export type PlayerStatePeerBaseline = {
	position: number;
	minimumMinutes: number;
	cohortSize: number;
	currentPercentile: number | null;
};

export type PlayerStateCareerPoint = {
	season: string;
	position: number;
	minutes: number;
	fplPositionPercentile: number | null;
	understatProcessPercentile: number | null;
	expectedMetricsAvailable: boolean;
};

export type PlayerStateSourceCoverage = {
	provider: PlayerStateProvider;
	scope: PlayerStateProviderScope;
	seasons: string[];
	dataStatus: PlayerStateDataStatus;
	analysisStatus: PlayerStateAnalysisStatus;
	mappingStatus: PlayerStateMappingStatus;
	reasonCodes: string[];
	revision: string | null;
	asOf: string | null;
	freshnessSeconds: number | null;
	stale: boolean;
};

export type PlayerStateCoverage = {
	sources: PlayerStateSourceCoverage[];
	metricCoverage: string[];
	limitations: string[];
};

export type PlayerStateProfile = {
	playerId: number;
	playerCode: number;
	teamId: number;
	position: number;
	season: string;
	horizon: number;
	asOfEventId: number | null;
	asOf: string;
	trend: PlayerStateTrend;
	confidence: PlayerStateConfidence;
	providerMode: PlayerStateProviderMode;
	reasons: PlayerStateReason[];
	profileRadar: PlayerRadarProfile | null;
	dimensions: PlayerStateDimension[];
	ownBaseline: PlayerStateOwnBaseline;
	peerBaseline: PlayerStatePeerBaseline;
	careerTrajectory: PlayerStateCareerPoint[];
	outlook: PlayerStateOutlook;
	coverage: PlayerStateCoverage;
	seasonTimeline: PlayerSeasonTimelinePoint[];
};

export type PlayerGameweekSample = {
	eventId: number;
	totalPoints: number;
	minutes: number;
	started: boolean;
	bonus: number;
	covered: boolean;
};

export type RoleAssessment = {
	rating: PlayerStateDimensionRating;
	direction: PlayerStateDirection;
	starts: number;
	medianStarterMinutes: number | null;
	minutesRange: number | null;
	reasonCodes: string[];
};

export type OutputAssessment = {
	rating: PlayerStateDimensionRating;
	direction: PlayerStateDirection;
	currentPercentile: number | null;
	recentPercentile: number | null;
	baselinePercentile: number | null;
	reasonCodes: string[];
};

export type ReliabilityAssessment = {
	rating: PlayerStateDimensionRating;
	direction: PlayerStateDirection;
	baseline: PlayerStateOwnBaseline;
	reasonCodes: string[];
};

export type ProcessAssessment = {
	rating: PlayerStateDimensionRating;
	direction: PlayerStateDirection;
	available: boolean;
	sampleMinutes: number;
	smallSample: boolean;
	reasonCodes: string[];
	metrics: PlayerStateMetric[];
};

export type AvailabilityAssessment = {
	unavailable: boolean;
	authoritative: boolean;
	stale: boolean;
	status: string | null;
	chance: number | null;
	reasonCode: string;
};
