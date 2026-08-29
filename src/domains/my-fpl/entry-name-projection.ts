import type { GraphQLContext } from "../../graphql/context";
import type {
	MyFplCompetitionAggregate,
	MyFplCompetitionBoardPage,
	MyFplCompetitionBoardRow,
	MyFplEntryIdentity,
} from "./repository";

export type CurrentEntryRead = (
	context: GraphQLContext,
	entryIds: readonly number[]
) => Promise<ReadonlyMap<number, { entryName: string }>>;

export const createMyFplEntryNameProjection = (readEntries: CurrentEntryRead) => {
	const loadCurrentEntryNames = async (
		context: GraphQLContext,
		entryIds: readonly number[]
	): Promise<Map<number, string>> => {
		const uniqueEntryIds = [
			...new Set(entryIds.filter((entryId) => Number.isSafeInteger(entryId) && entryId > 0)),
		];
		if (uniqueEntryIds.length === 0) return new Map();

		const entries = await readEntries(context, uniqueEntryIds);
		const names = new Map<number, string>();
		for (const entryId of uniqueEntryIds) {
			const entry = entries.get(entryId);
			if (entry) names.set(entryId, entry.entryName);
		}
		return names;
	};

	const applyCurrentEntryName = (
		entry: MyFplEntryIdentity | null,
		currentEntryName: string
	): MyFplEntryIdentity | null => (entry ? { ...entry, entryName: currentEntryName } : null);

	const applyCurrentEntryNamesToBoardPage = async (
		context: GraphQLContext,
		page: MyFplCompetitionBoardPage
	): Promise<MyFplCompetitionBoardPage> => {
		const entryIds = [
			...page.rows.map((row) => row.entryId),
			...(page.viewerRow ? [page.viewerRow.entryId] : []),
		];
		const names = await loadCurrentEntryNames(context, entryIds);
		const applyRowName = (
			row: MyFplCompetitionBoardRow | null
		): MyFplCompetitionBoardRow | null => {
			if (!row) return null;
			const currentEntryName = names.get(row.entryId);
			return currentEntryName === undefined ? row : { ...row, entryName: currentEntryName };
		};
		return {
			...page,
			rows: page.rows
				.map(applyRowName)
				.filter((row): row is MyFplCompetitionBoardRow => row !== null),
			viewerRow: applyRowName(page.viewerRow),
		};
	};

	const applyCurrentEntryNamesToAggregate = async (
		context: GraphQLContext,
		aggregate: MyFplCompetitionAggregate
	): Promise<MyFplCompetitionAggregate> => {
		const entryIds = [
			...aggregate.metrics.map((metric) => metric.leaderEntryId),
			...aggregate.topPerformers.map((performance) => performance.entryId),
			...aggregate.risers.map((performance) => performance.entryId),
			...aggregate.fallers.map((performance) => performance.entryId),
		].filter(
			(entryId): entryId is number =>
				typeof entryId === "number" && Number.isSafeInteger(entryId) && entryId > 0
		);
		const names = await loadCurrentEntryNames(context, entryIds);
		const currentNameFor = (entryId: number, fallback: string | null): string | null =>
			names.get(entryId) ?? fallback;
		return {
			...aggregate,
			metrics: aggregate.metrics.map((metric) => {
				const leaderEntryId = metric.leaderEntryId;
				return {
					...metric,
					leaderEntryName:
						leaderEntryId === null
							? metric.leaderEntryName
							: currentNameFor(leaderEntryId, metric.leaderEntryName),
				};
			}),
			topPerformers: aggregate.topPerformers.map((performance) => ({
				...performance,
				entryName: currentNameFor(performance.entryId, performance.entryName),
			})),
			risers: aggregate.risers.map((performance) => ({
				...performance,
				entryName: currentNameFor(performance.entryId, performance.entryName),
			})),
			fallers: aggregate.fallers.map((performance) => ({
				...performance,
				entryName: currentNameFor(performance.entryId, performance.entryName),
			})),
		};
	};

	return {
		loadCurrentEntryNames,
		applyCurrentEntryName,
		applyCurrentEntryNamesToBoardPage,
		applyCurrentEntryNamesToAggregate,
	};
};
