export const GRAPHQL_TRAFFIC_CLASSES = ["mini", "web_browser", "web_rsc", "service"] as const;
export type GraphQLTrafficClass = (typeof GRAPHQL_TRAFFIC_CLASSES)[number];

export const GRAPHQL_WORKLOADS = [
	"interactive",
	"home",
	"fixtures",
	"market",
	"player-stats",
	"gameweek",
	"public-other",
] as const;
export type GraphQLWorkload = (typeof GRAPHQL_WORKLOADS)[number];
