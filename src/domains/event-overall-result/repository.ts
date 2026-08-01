import type { GraphQLContext } from "../../graphql/context";
import { metrics } from "../../infra/metrics";
import { getCurrentSeason } from "../../infra/season";

export type ChipPlay = {
	chipName: string;
	numberPlayed: number;
};

export type TopElementInfo = {
	element: number;
	points: number;
};

export type EventResultPlayer = {
	id: number;
	webName: string;
};

export type EventResult = {
	event: number;
	averageScore: number;
	finished: boolean;
	highestScoringEntry: number;
	highestScore: number;
	chipPlays: ChipPlay[];
	mostSelectedId: number;
	mostSelectedPlayer: EventResultPlayer | null;
	mostCaptainedId: number;
	mostCaptainedPlayer: EventResultPlayer | null;
	mostTransferredInId: number;
	mostTransferInPlayer: EventResultPlayer | null;
	topElementInfo: TopElementInfo;
	transfersMade: number;
	mostViceCaptainedId: number;
	mostViceCaptainedPlayer: EventResultPlayer | null;
};

export interface EventOverallResultRepository {
	getEventOverallResult(context: GraphQLContext): Promise<EventResult[]>;
}

type DbEventRow = {
	id: number;
	average_entry_score: number | null;
	finished: boolean;
	highest_scoring_entry: number | null;
	highest_score: number | null;
	chip_plays: unknown[] | null;
	most_selected: number | null;
	most_transferred_in: number | null;
	top_element: number | null;
	top_element_info: unknown | null;
	transfers_made: number | null;
	most_captained: number | null;
	most_vice_captained: number | null;
};

function mapEventResult(row: DbEventRow): EventResult {
	// Parse chipPlays
	let chipPlays: ChipPlay[] = [];
	if (Array.isArray(row.chip_plays)) {
		chipPlays = row.chip_plays
			.map((chip: unknown) => {
				if (typeof chip === "object" && chip !== null) {
					const chipObj = chip as Record<string, unknown>;
					return {
						chipName: String(chipObj.chipName ?? ""),
						numberPlayed: Number(chipObj.numberPlayed ?? 0),
					};
				}
				return null;
			})
			.filter((chip): chip is ChipPlay => chip !== null);
	}

	// Parse topElementInfo
	let topElementInfo: TopElementInfo = { element: 0, points: 0 };
	if (typeof row.top_element_info === "object" && row.top_element_info !== null) {
		const topElement = row.top_element_info as Record<string, unknown>;
		topElementInfo = {
			element: Number(topElement.element ?? 0),
			points: Number(topElement.points ?? 0),
		};
	} else if (typeof row.top_element === "number") {
		topElementInfo = {
			element: row.top_element,
			points: 0,
		};
	}

	return {
		event: row.id,
		averageScore: row.average_entry_score ?? 0,
		finished: row.finished,
		highestScoringEntry: row.highest_scoring_entry ?? 0,
		highestScore: row.highest_score ?? 0,
		chipPlays,
		mostSelectedId: row.most_selected ?? 0,
		mostSelectedPlayer: null,
		mostCaptainedId: row.most_captained ?? 0,
		mostCaptainedPlayer: null,
		mostTransferredInId: row.most_transferred_in ?? 0,
		mostTransferInPlayer: null,
		topElementInfo,
		transfersMade: row.transfers_made ?? 0,
		mostViceCaptainedId: row.most_vice_captained ?? 0,
		mostViceCaptainedPlayer: null,
	};
}

export const eventOverallResultRepository: EventOverallResultRepository = {
	async getEventOverallResult(context: GraphQLContext): Promise<EventResult[]> {
		const season = Number(await getCurrentSeason(context));
		const cacheKey = `EventOverallResult:${season}`;
		try {
			let hashData: Record<string, string> = {};
			try {
				hashData = await context.redis.hgetall(cacheKey);
			} catch (error) {
				context.logger.warn(
					{ err: error, cacheKey, season },
					"Failed to read event overall cache; falling back to database"
				);
				metrics.cacheRepositoryEvents.labels("event_overall", "cache_error").inc();
			}

			if (Object.keys(hashData).length > 0) {
				const eventResults: EventResult[] = [];
				let malformed = false;
				for (const [eventId, jsonValue] of Object.entries(hashData)) {
					try {
						const parsed = JSON.parse(jsonValue) as unknown;
						if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
							const data = parsed as Record<string, unknown>;
							const parsedEvent = Number(data.event ?? eventId);
							if (!Number.isFinite(parsedEvent) || parsedEvent <= 0) {
								malformed = true;
								continue;
							}
							// Convert hash format to EventResult
							const result: EventResult = {
								event: parsedEvent,
								averageScore: Number(data.averageScore ?? data.averageEntryScore ?? 0),
								finished: Boolean(data.finished ?? false),
								highestScoringEntry: Number(data.highestScoringEntry ?? 0),
								highestScore: Number(data.highestScore ?? 0),
								chipPlays: (data.chipPlays as ChipPlay[]) ?? [],
								mostSelectedId: Number(data.mostSelected ?? 0),
								mostSelectedPlayer: null,
								mostCaptainedId: Number(data.mostCaptained ?? 0),
								mostCaptainedPlayer: null,
								mostTransferredInId: Number(data.mostTransferredIn ?? 0),
								mostTransferInPlayer: null,
								topElementInfo: (data.topElementInfo as TopElementInfo) ?? {
									element: 0,
									points: 0,
								},
								transfersMade: Number(data.transfersMade ?? 0),
								mostViceCaptainedId: Number(data.mostViceCaptained ?? 0),
								mostViceCaptainedPlayer: null,
							};
							eventResults.push(result);
						} else {
							malformed = true;
						}
					} catch (error) {
						malformed = true;
						context.logger.warn(
							{ err: error, cacheKey, season, eventId },
							"Failed to parse hash value as JSON"
						);
					}
				}
				if (!malformed && eventResults.length > 0) {
					eventResults.sort((a, b) => a.event - b.event);
					return eventResults;
				}
				metrics.cacheRepositoryEvents.labels("event_overall", "malformed").inc();
				context.logger.warn(
					{ cacheKey, season },
					"Event overall cache contains malformed rows; falling back to database"
				);
			}

			const { data, error } = await context.supabase
				.from("events")
				.select(
					"id, average_entry_score, finished, highest_scoring_entry, highest_score, chip_plays, most_selected, most_transferred_in, top_element, top_element_info, transfers_made, most_captained, most_vice_captained"
				)
				.order("id", { ascending: true });

			if (error) {
				context.logger.error(
					{ err: error, season },
					"Failed to fetch event overall results from DB"
				);
				throw new Error("Failed to fetch event overall results", { cause: error });
			}

			const eventResults = (data as DbEventRow[] | null)?.map(mapEventResult) ?? [];

			return eventResults;
		} catch (error) {
			context.logger.error(
				{ err: error, cacheKey: `EventOverallResult:${season}`, season },
				"Failed to get event overall result"
			);
			throw new Error("Failed to get event overall result", { cause: error });
		}
	},
};
