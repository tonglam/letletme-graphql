import type { GraphQLContext } from "../../graphql/context";
import { getCoreDataSnapshot, type CoreEventData } from "../../infra/data-snapshot";

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
	getEventOverallResult(context: GraphQLContext, eventId?: number | null): Promise<EventResult[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function mapEventResult(row: CoreEventData): EventResult {
	const chipPlays = (row.chipPlays ?? [])
		.map((chip): ChipPlay | null => {
			if (!isRecord(chip)) return null;
			return {
				chipName: String(chip.chipName ?? ""),
				numberPlayed: Number(chip.numberPlayed ?? 0),
			};
		})
		.filter((chip): chip is ChipPlay => chip !== null);
	const topElement = isRecord(row.topElementInfo) ? row.topElementInfo : null;
	const topElementInfo: TopElementInfo = {
		element: Number(topElement?.element ?? row.topElement ?? 0),
		points: Number(topElement?.points ?? 0),
	};
	return {
		event: row.id,
		averageScore: row.averageEntryScore ?? 0,
		finished: row.finished,
		highestScoringEntry: row.highestScoringEntry ?? 0,
		highestScore: row.highestScore ?? 0,
		chipPlays,
		mostSelectedId: row.mostSelected ?? 0,
		mostSelectedPlayer: null,
		mostCaptainedId: row.mostCaptained ?? 0,
		mostCaptainedPlayer: null,
		mostTransferredInId: row.mostTransferredIn ?? 0,
		mostTransferInPlayer: null,
		topElementInfo,
		transfersMade: row.transfersMade ?? 0,
		mostViceCaptainedId: row.mostViceCaptained ?? 0,
		mostViceCaptainedPlayer: null,
	};
}

export const eventOverallResultRepository: EventOverallResultRepository = {
	async getEventOverallResult(
		context: GraphQLContext,
		eventId?: number | null
	): Promise<EventResult[]> {
		const snapshot = await getCoreDataSnapshot(context);
		const results = snapshot.events
			.map(mapEventResult)
			.sort((left, right) => left.event - right.event);
		if (eventId === undefined || eventId === null) return results;
		return results.filter((result) => result.event === eventId);
	},
};
