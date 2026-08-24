import type { GraphQLContext } from "../../graphql/context";
import type { Entry } from "../entries/repository";
import { entriesService } from "../entries/service";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import { entryLiveCalcService, type LiveCalcData } from "./calc-service";
import { isTraceableOfficialManagerScore, type LiveManagerScore } from "./manager-score";

export type EntryLive = {
	entry: Entry;
	event: Event;
	eventPoints: number;
	eventRank: number | null;
	overallPoints: number;
	overallRank: number;
	eventTransfers: number;
	eventTransfersCost: number;
	eventNetPoints: number;
	previousOverallPoints: number | null;
	previousOverallRank: number | null;
	liveTotalPoints: number;
	score: LiveManagerScore;
};

export const projectEntryLiveFromCalc = (params: {
	entry: Entry;
	event: Event;
	calc: LiveCalcData;
}): EntryLive | null => {
	const { calc } = params;
	const hasProjectableAvailability =
		calc.availability === "READY" ||
		(calc.availability === "NO_PICKS" &&
			calc.score.source === "FPL_FINAL_RESULT" &&
			calc.score.state === "FINAL");
	if (
		!hasProjectableAvailability ||
		!isTraceableOfficialManagerScore(calc.score) ||
		typeof calc.score.eventPoints !== "number" ||
		typeof calc.score.netEventPoints !== "number" ||
		typeof calc.score.totalPoints !== "number"
	) {
		return null;
	}

	return {
		entry: params.entry,
		event: params.event,
		eventPoints: calc.score.eventPoints,
		eventRank: calc.score.eventRank,
		overallPoints: calc.score.totalPoints,
		overallRank: calc.score.overallRank ?? calc.overallRank,
		eventTransfers: calc.eventTransfers ?? calc.transfersList.length,
		eventTransfersCost: calc.score.transferCost,
		eventNetPoints: calc.score.netEventPoints,
		previousOverallPoints: calc.lastOverallPoints,
		previousOverallRank: calc.lastOverallRank > 0 ? calc.lastOverallRank : null,
		liveTotalPoints: calc.score.totalPoints,
		score: calc.score,
	};
};

export const entryLiveService = {
	async getEntryLive(
		context: GraphQLContext,
		entryId: number,
		eventId: number
	): Promise<EntryLive | null> {
		if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(eventId)) {
			return null;
		}

		if (entryId <= 0 || eventId <= 0) {
			return null;
		}

		const [entry, event, calc] = await Promise.all([
			entriesService.getEntryById(context, entryId),
			eventsService.getEventById(context, eventId),
			entryLiveCalcService.calcLivePointsByEntry(context, eventId, entryId, true),
		]);

		if (!entry || !event) {
			return null;
		}

		return projectEntryLiveFromCalc({ entry, event, calc });
	},
};
