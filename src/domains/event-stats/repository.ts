import type { GraphQLContext } from "../../graphql/context";
import { GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID } from "../../contracts/data-fixture-identities";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { gqlCacheKey } from "../../infra/cache-key";
import { hasExactFields } from "../../infra/exact-fields";
import {
	QUERY_CACHE_TTL_SECONDS,
	readJsonQueryCache,
	writeJsonQueryCache,
} from "../../infra/query-cache";
import { getCurrentSeason } from "../../infra/season";
import { buildPlayerMap } from "../../infra/player-map";
import { buildTeamMap } from "../../infra/team-map";

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isSafeNonNegativeInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isSafePositiveInt = (value: unknown): value is number =>
	isSafeNonNegativeInt(value) && value > 0;

const decodeSelectionPlayer = (value: unknown): SelectionStatPlayer | null => {
	if (
		!isRecord(value) ||
		!hasExactFields(value, [
			"id",
			"webName",
			"teamShortName",
			"position",
			"selectedByPercent",
			"eoByPercent",
		])
	) {
		return null;
	}
	if (
		!isSafePositiveInt(value.id) ||
		typeof value.webName !== "string" ||
		typeof value.teamShortName !== "string" ||
		typeof value.position !== "string" ||
		!isFiniteNumber(value.selectedByPercent) ||
		!(value.eoByPercent === null || isFiniteNumber(value.eoByPercent))
	) {
		return null;
	}
	return {
		id: value.id,
		webName: value.webName,
		teamShortName: value.teamShortName,
		position: value.position,
		selectedByPercent: value.selectedByPercent,
		eoByPercent: value.eoByPercent,
	};
};

const decodeCaptainPlayer = (value: unknown): CaptainStatPlayer | null => {
	if (
		!isRecord(value) ||
		!hasExactFields(value, [
			"id",
			"webName",
			"teamShortName",
			"position",
			"captainByPercent",
			"selectedByPercent",
			"eoByPercent",
		])
	) {
		return null;
	}
	if (
		!isSafePositiveInt(value.id) ||
		typeof value.webName !== "string" ||
		typeof value.teamShortName !== "string" ||
		typeof value.position !== "string" ||
		!isFiniteNumber(value.captainByPercent) ||
		!isFiniteNumber(value.selectedByPercent) ||
		!(value.eoByPercent === null || isFiniteNumber(value.eoByPercent))
	) {
		return null;
	}
	return {
		id: value.id,
		webName: value.webName,
		teamShortName: value.teamShortName,
		position: value.position,
		captainByPercent: value.captainByPercent,
		selectedByPercent: value.selectedByPercent,
		eoByPercent: value.eoByPercent,
	};
};

const decodeTransferPlayer = (value: unknown): TransferStatPlayer | null => {
	if (
		!isRecord(value) ||
		!hasExactFields(value, [
			"id",
			"webName",
			"teamShortName",
			"position",
			"transfersEvent",
			"selectedByPercent",
		])
	) {
		return null;
	}
	if (
		!isSafePositiveInt(value.id) ||
		typeof value.webName !== "string" ||
		typeof value.teamShortName !== "string" ||
		typeof value.position !== "string" ||
		!isSafeNonNegativeInt(value.transfersEvent) ||
		!isFiniteNumber(value.selectedByPercent)
	) {
		return null;
	}
	return {
		id: value.id,
		webName: value.webName,
		teamShortName: value.teamShortName,
		position: value.position,
		transfersEvent: value.transfersEvent,
		selectedByPercent: value.selectedByPercent,
	};
};

const decodePlayerList = <T>(
	value: unknown,
	decodeItem: (item: unknown) => T | null
): T[] | null => {
	if (!Array.isArray(value)) return null;
	const items = value.map(decodeItem);
	return items.every((item): item is T => item !== null) ? items : null;
};

const TOURNAMENT_SELECTION_STATS_FIELDS = [
	"totalEntries",
	"goalkeepers",
	"defenders",
	"midfielders",
	"forwards",
	"captainSelect",
	"viceCaptainSelect",
	"mostSelectedPlayers",
	"mostTransferIn",
	"mostTransferOut",
] as const;

export const decodeTournamentSelectionStats = (value: unknown): TournamentSelectionStats | null => {
	if (!isRecord(value) || !hasExactFields(value, TOURNAMENT_SELECTION_STATS_FIELDS)) return null;
	const goalkeepers = decodePlayerList(value.goalkeepers, decodeSelectionPlayer);
	const defenders = decodePlayerList(value.defenders, decodeSelectionPlayer);
	const midfielders = decodePlayerList(value.midfielders, decodeSelectionPlayer);
	const forwards = decodePlayerList(value.forwards, decodeSelectionPlayer);
	const captainSelect = decodePlayerList(value.captainSelect, decodeCaptainPlayer);
	const viceCaptainSelect = decodePlayerList(value.viceCaptainSelect, decodeCaptainPlayer);
	const mostSelectedPlayers = decodePlayerList(value.mostSelectedPlayers, decodeSelectionPlayer);
	const mostTransferIn = decodePlayerList(value.mostTransferIn, decodeTransferPlayer);
	const mostTransferOut = decodePlayerList(value.mostTransferOut, decodeTransferPlayer);
	if (
		!isSafeNonNegativeInt(value.totalEntries) ||
		!goalkeepers ||
		!defenders ||
		!midfielders ||
		!forwards ||
		!captainSelect ||
		!viceCaptainSelect ||
		!mostSelectedPlayers ||
		!mostTransferIn ||
		!mostTransferOut
	) {
		return null;
	}
	return {
		totalEntries: value.totalEntries,
		goalkeepers,
		defenders,
		midfielders,
		forwards,
		captainSelect,
		viceCaptainSelect,
		mostSelectedPlayers,
		mostTransferIn,
		mostTransferOut,
	};
};

const privateCacheKey = async (context: GraphQLContext, key: string): Promise<string> =>
	gqlCacheKey(context, key);

export type SelectionStatPlayer = {
	id: number;
	webName: string;
	teamShortName: string;
	position: string;
	selectedByPercent: number;
	eoByPercent: number | null;
};

export type CaptainStatPlayer = {
	id: number;
	webName: string;
	teamShortName: string;
	position: string;
	captainByPercent: number;
	selectedByPercent: number;
	eoByPercent: number | null;
};

export type TransferStatPlayer = {
	id: number;
	webName: string;
	teamShortName: string;
	position: string;
	transfersEvent: number;
	selectedByPercent: number;
};

export type TournamentSelectionStats = {
	totalEntries: number;
	goalkeepers: SelectionStatPlayer[];
	defenders: SelectionStatPlayer[];
	midfielders: SelectionStatPlayer[];
	forwards: SelectionStatPlayer[];
	captainSelect: CaptainStatPlayer[];
	viceCaptainSelect: CaptainStatPlayer[];
	mostSelectedPlayers: SelectionStatPlayer[];
	mostTransferIn: TransferStatPlayer[];
	mostTransferOut: TransferStatPlayer[];
};

export type DbTournamentSelectionStatRow = {
	element_id: number;
	pick_count: number;
	captain_count: number;
	vice_captain_count: number;
	transfer_in_count: number;
	transfer_out_count: number;
	total_entries: number;
	selection_percentage: number | string;
	captain_percentage: number | string;
	vice_captain_percentage: number | string;
	effective_ownership_percentage: number | string;
};

export type TournamentSelectionIndexRow = {
	playerId: number;
	count: number;
	percentage: number;
};

type TournamentSelectionIndexReadRow = {
	publication_id: number | string;
	expected_entries: number | string;
	complete_pick_entries: number | string;
	revision: number | string;
	publication_state: string;
	ownership_state: string;
	captaincy_state: string;
	vice_captaincy_state: string;
	transfers_state: string;
	element_id: number | string | null;
	selected_count: number | string | null;
	effective_selection_count: number | string | null;
	captain_count: number | string | null;
	vice_captain_count: number | string | null;
	transfer_in_count: number | string | null;
	transfer_out_count: number | string | null;
	player_name: string | null;
	player_position: number | string | null;
	team_short_name: string | null;
};

const parseSelectionIndexInteger = (value: unknown, minimum: number): number | null => {
	const candidate =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: null;
	return candidate !== null && Number.isSafeInteger(candidate) && candidate >= minimum
		? candidate
		: null;
};

/**
 * Reads the active immutable publication for the live player/team picker.
 * Keep this separate from the legacy event-stats materialized view: the Data
 * repair job publishes the immutable scope even while the compatibility view
 * is being retired.
 */
export const TOURNAMENT_SELECTION_INDEX_SQL = `
	SELECT
		publication.publication_id,
		publication.expected_entries,
		publication.complete_pick_entries,
		publication.revision,
		publication.publication_state,
		publication.ownership_state,
		publication.captaincy_state,
		publication.vice_captaincy_state,
		publication.transfers_state,
		rows.element_id,
		rows.selected_count,
		rows.effective_selection_count,
		rows.captain_count,
		rows.vice_captain_count,
		rows.transfer_in_count,
		rows.transfer_out_count,
		rows.player_name,
		rows.player_position,
		rows.team_short_name
	FROM reporting.tournament_selection_stat_publications publication
	LEFT JOIN reporting.tournament_selection_stat_rows rows
		ON rows.publication_id = publication.publication_id
	WHERE publication.season_id = $1
		AND publication.tournament_id = $2
		AND publication.event_id = $3
		AND publication.is_active
		AND publication.publication_state = 'READY'
		AND publication.ownership_state = 'READY'
		AND publication.expected_entries > 0
		AND publication.complete_pick_entries = publication.expected_entries
	ORDER BY rows.selected_count DESC NULLS LAST, rows.element_id
`;

export const TOURNAMENT_SELECTION_INDEX_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "live-tournament.selection-index",
		sql: TOURNAMENT_SELECTION_INDEX_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 2],
		resultTypes: [
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "publication_id",
				pgType: "bigint",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "expected_entries",
				pgType: "integer",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "complete_pick_entries",
				pgType: "integer",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "revision",
				pgType: "bigint",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "publication_state",
				pgType: "text",
			},
			{
				relation: "reporting.tournament_selection_stat_publications",
				column: "ownership_state",
				pgType: "text",
			},
			{
				relation: "reporting.tournament_selection_stat_rows",
				column: "element_id",
				pgType: "integer",
			},
			{
				relation: "reporting.tournament_selection_stat_rows",
				column: "selected_count",
				pgType: "integer",
			},
		],
		runtime: "must-return-selection-row",
	},
];

const positionTypeToEnum = (type: number): string => {
	switch (type) {
		case 1:
			return "GOALKEEPER";
		case 2:
			return "DEFENDER";
		case 3:
			return "MIDFIELDER";
		case 4:
			return "FORWARD";
		default:
			return "MIDFIELDER";
	}
};

export async function getPlayerAndTeamMaps(
	context: GraphQLContext,
	playerIds: number[],
	eventId?: number,
	season?: string
): Promise<{
	playerMap: Map<number, { id: number; web_name: string; team_id: number; type: number }>;
	teamMap: Map<number, { id: number; name: string; short_name: string }>;
	eventTeamResolutionComplete: boolean;
}> {
	if (playerIds.length === 0) {
		return {
			playerMap: new Map(),
			teamMap: new Map(),
			eventTeamResolutionComplete: true,
		};
	}

	const [fullPlayerMap, fullTeamMap] = await Promise.all([
		buildPlayerMap(context, playerIds),
		buildTeamMap(context),
	]);

	const filteredPlayerMap = new Map<
		number,
		{ id: number; web_name: string; team_id: number; type: number }
	>();
	for (const [id, player] of fullPlayerMap) {
		if (playerIds.includes(id)) {
			filteredPlayerMap.set(id, {
				id: player.id,
				web_name: player.webName,
				team_id: player.teamId,
				type: player.position,
			});
		}
	}

	let eventTeamResolutionComplete = true;
	// Resolve player teams at the requested event for historical accuracy.
	if (eventId !== null && eventId !== undefined && season !== null && season !== undefined) {
		eventTeamResolutionComplete = false;
		try {
			const requestedPlayerIds = [...new Set(playerIds)];
			const playerCodesById = new Map<number, number>();
			for (const playerId of requestedPlayerIds) {
				const full = fullPlayerMap.get(playerId);
				if (full?.code && full.code > 0 && filteredPlayerMap.has(playerId)) {
					playerCodesById.set(playerId, full.code);
				}
			}
			const validCodes = [...playerCodesById.values()];
			if (validCodes.length === requestedPlayerIds.length) {
				const { data, error } = await context.data
					.read("fpl.player_fixture_stats")
					.select("player_code, team_id")
					.eq("season", season)
					.in("player_code", validCodes)
					.lte("event_id", eventId)
					.order("event_id", { ascending: false })
					.order("fixture_id", { ascending: false });
				if (!error && data) {
					const eventTeamMap = new Map<number, number>();
					for (const row of data as { player_code: number; team_id: number }[]) {
						if (!eventTeamMap.has(row.player_code)) {
							eventTeamMap.set(row.player_code, row.team_id);
						}
					}
					for (const [id, player] of filteredPlayerMap) {
						const code = playerCodesById.get(id) ?? 0;
						const eventTeamId = code > 0 ? eventTeamMap.get(code) : undefined;
						if (eventTeamId !== undefined && eventTeamId > 0) {
							filteredPlayerMap.set(id, { ...player, team_id: eventTeamId });
						}
					}
					eventTeamResolutionComplete = requestedPlayerIds.every((playerId) => {
						const code = playerCodesById.get(playerId);
						return code !== undefined && eventTeamMap.has(code);
					});
				}
			}
		} catch (err) {
			context.logger.warn(
				{ err, eventId, season },
				"Failed to resolve event-scoped player teams; using current data"
			);
		}
	}

	const neededTeamIds = new Set([...filteredPlayerMap.values()].map((p) => p.team_id));
	const filteredTeamMap = new Map<number, { id: number; name: string; short_name: string }>();
	for (const [id, team] of fullTeamMap) {
		if (neededTeamIds.has(id)) {
			filteredTeamMap.set(id, { id, name: team.name, short_name: team.shortName });
		}
	}

	return {
		playerMap: filteredPlayerMap,
		teamMap: filteredTeamMap,
		eventTeamResolutionComplete,
	};
}

const EMPTY_STATS: TournamentSelectionStats = {
	totalEntries: 0,
	goalkeepers: [],
	defenders: [],
	midfielders: [],
	forwards: [],
	captainSelect: [],
	viceCaptainSelect: [],
	mostSelectedPlayers: [],
	mostTransferIn: [],
	mostTransferOut: [],
};

type SelectionStatsSnapshot = {
	pickCounts: Map<number, number>;
	captainCounts: Map<number, number>;
	viceCaptainCounts: Map<number, number>;
	transferInCounts: Map<number, number>;
	transferOutCounts: Map<number, number>;
	selectionPercentages: Map<number, number>;
	captainPercentages: Map<number, number>;
	viceCaptainPercentages: Map<number, number>;
	effectiveOwnershipPercentages: Map<number, number>;
};

async function getReadModelRows(
	context: GraphQLContext,
	tournamentId: number,
	eventId: number
): Promise<DbTournamentSelectionStatRow[] | null> {
	const { data, error } = await context.data
		.read("reporting.tournament_selection_stats")
		.select(
			"element_id,pick_count,captain_count,vice_captain_count,transfer_in_count,transfer_out_count,total_entries,selection_percentage,captain_percentage,vice_captain_percentage,effective_ownership_percentage"
		)
		.eq("tournament_id", tournamentId)
		.eq("event_id", eventId);

	if (error) {
		throw new Error(
			`Failed to fetch tournament selection stats read model for tournament ${tournamentId}, event ${eventId}`,
			{ cause: error }
		);
	}

	return (data as DbTournamentSelectionStatRow[] | null) ?? [];
}

/**
 * Reads the reporting aggregate used by live tournament desks. This is kept
 * separate from the player-enriched event-stats projection so the desk never
 * needs to load tournament rosters or raw picks at request time.
 */
export async function getTournamentSelectionIndexRows(
	context: GraphQLContext,
	tournamentId: number,
	eventId: number
): Promise<TournamentSelectionIndexRow[]> {
	if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) return [];
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return [];
	const result = await context.database.query(TOURNAMENT_SELECTION_INDEX_SQL, [
		context.currentSeason.seasonId,
		tournamentId,
		eventId,
	]);
	const rows = result.rows as unknown as TournamentSelectionIndexReadRow[];
	if (rows.length === 0) return [];

	const publication = rows[0]!;
	const publicationId = parseSelectionIndexInteger(publication.publication_id, 1);
	const expectedEntries = parseSelectionIndexInteger(publication.expected_entries, 1);
	const completePickEntries = parseSelectionIndexInteger(publication.complete_pick_entries, 0);
	const publicationRevision = parseSelectionIndexInteger(publication.revision, 1);
	if (
		publicationId === null ||
		expectedEntries === null ||
		completePickEntries === null ||
		completePickEntries !== expectedEntries ||
		publicationRevision === null ||
		publication.publication_state !== "READY" ||
		publication.ownership_state !== "READY"
	) {
		throw new Error("Malformed tournament selection index publication");
	}

	const playerIds = new Set<number>();
	const projected: TournamentSelectionIndexRow[] = [];
	for (const row of rows) {
		const rowPublicationId = parseSelectionIndexInteger(row.publication_id, 1);
		const rowExpectedEntries = parseSelectionIndexInteger(row.expected_entries, 1);
		const rowCompletePickEntries = parseSelectionIndexInteger(row.complete_pick_entries, 0);
		const rowRevision = parseSelectionIndexInteger(row.revision, 1);
		if (
			rowPublicationId === null ||
			rowExpectedEntries === null ||
			rowCompletePickEntries === null ||
			rowRevision === null
		) {
			throw new Error("Malformed tournament selection index read model row");
		}
		if (
			rowPublicationId !== publicationId ||
			rowExpectedEntries !== expectedEntries ||
			rowCompletePickEntries !== completePickEntries ||
			rowRevision !== publicationRevision ||
			row.publication_state !== publication.publication_state ||
			row.ownership_state !== publication.ownership_state
		) {
			throw new Error("Inconsistent tournament selection index publication");
		}
		if (row.element_id === null) continue;
		const playerId = parseSelectionIndexInteger(row.element_id, 1);
		const count = parseSelectionIndexInteger(row.selected_count, 0);
		if (playerId === null || count === null || count > expectedEntries) {
			throw new Error("Malformed tournament selection index read model row");
		}
		if (playerIds.has(playerId)) {
			throw new Error("Duplicate tournament selection index player");
		}
		playerIds.add(playerId);
		projected.push({
			playerId,
			count,
			percentage: Number(((count * 100) / expectedEntries).toFixed(4)),
		});
	}
	return projected;
}

function snapshotFromReadModel(rows: DbTournamentSelectionStatRow[]): {
	snapshot: SelectionStatsSnapshot;
	totalEntries: number;
} | null {
	const snapshot: SelectionStatsSnapshot = {
		pickCounts: new Map(),
		captainCounts: new Map(),
		viceCaptainCounts: new Map(),
		transferInCounts: new Map(),
		transferOutCounts: new Map(),
		selectionPercentages: new Map(),
		captainPercentages: new Map(),
		viceCaptainPercentages: new Map(),
		effectiveOwnershipPercentages: new Map(),
	};
	let totalEntries = 0;

	for (const row of rows) {
		const playerId = Number(row.element_id);
		if (!Number.isSafeInteger(playerId) || playerId <= 0) continue;

		const pickCount = Number(row.pick_count) || 0;
		const captainCount = Number(row.captain_count) || 0;
		const viceCaptainCount = Number(row.vice_captain_count) || 0;
		const transferInCount = Number(row.transfer_in_count) || 0;
		const transferOutCount = Number(row.transfer_out_count) || 0;
		const rowTotalEntries = Number(row.total_entries);
		const selectionPercentage = Number(row.selection_percentage);
		const captainPercentage = Number(row.captain_percentage);
		const viceCaptainPercentage = Number(row.vice_captain_percentage);
		const effectiveOwnershipPercentage = Number(row.effective_ownership_percentage);
		if (
			!Number.isInteger(rowTotalEntries) ||
			rowTotalEntries <= 0 ||
			(totalEntries !== 0 && totalEntries !== rowTotalEntries) ||
			![
				selectionPercentage,
				captainPercentage,
				viceCaptainPercentage,
				effectiveOwnershipPercentage,
			].every(Number.isFinite)
		) {
			return null;
		}
		totalEntries = rowTotalEntries;

		if (pickCount > 0) snapshot.pickCounts.set(playerId, pickCount);
		if (captainCount > 0) snapshot.captainCounts.set(playerId, captainCount);
		if (viceCaptainCount > 0) snapshot.viceCaptainCounts.set(playerId, viceCaptainCount);
		if (transferInCount > 0) snapshot.transferInCounts.set(playerId, transferInCount);
		if (transferOutCount > 0) snapshot.transferOutCounts.set(playerId, transferOutCount);
		snapshot.selectionPercentages.set(playerId, selectionPercentage);
		snapshot.captainPercentages.set(playerId, captainPercentage);
		snapshot.viceCaptainPercentages.set(playerId, viceCaptainPercentage);
		snapshot.effectiveOwnershipPercentages.set(playerId, effectiveOwnershipPercentage);
	}

	return totalEntries > 0 ? { snapshot, totalEntries } : null;
}

async function buildTournamentSelectionStats(
	context: GraphQLContext,
	snapshot: SelectionStatsSnapshot,
	effectiveTotal: number,
	safeLimit: number,
	eventId?: number,
	season?: string
): Promise<TournamentSelectionStats> {
	const {
		pickCounts,
		captainCounts,
		viceCaptainCounts,
		transferInCounts,
		transferOutCounts,
		selectionPercentages,
		captainPercentages,
		viceCaptainPercentages,
		effectiveOwnershipPercentages,
	} = snapshot;

	const allPlayerIds = [
		...new Set([
			...pickCounts.keys(),
			...captainCounts.keys(),
			...viceCaptainCounts.keys(),
			...transferInCounts.keys(),
			...transferOutCounts.keys(),
		]),
	];

	const { playerMap, teamMap } = await getPlayerAndTeamMaps(context, allPlayerIds, eventId, season);

	const buildSelectionPlayer = (playerId: number): SelectionStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const selectedPct = selectionPercentages.get(playerId) ?? 0;
		const effectiveOwnershipPct = effectiveOwnershipPercentages.get(playerId) ?? 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			selectedByPercent: Math.round(selectedPct * 100) / 100,
			eoByPercent: Math.round(effectiveOwnershipPct * 100) / 100,
		};
	};

	const sortedByPick = [...pickCounts.entries()].sort((a, b) => b[1] - a[1]);

	const sortByPosition = (type: number): SelectionStatPlayer[] =>
		sortedByPick
			.filter(([playerId]) => playerMap.get(playerId)?.type === type)
			.slice(0, safeLimit)
			.map(([playerId]) => buildSelectionPlayer(playerId))
			.filter((p): p is SelectionStatPlayer => p !== null);

	const buildCaptainPlayer = (
		playerId: number,
		rolePercentage: number
	): CaptainStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const rolePct = rolePercentage;
		const selectedPct = selectionPercentages.get(playerId) ?? 0;
		const effectiveOwnershipPct = effectiveOwnershipPercentages.get(playerId) ?? 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			captainByPercent: Math.round(rolePct * 100) / 100,
			selectedByPercent: Math.round(selectedPct * 100) / 100,
			eoByPercent: Math.round(effectiveOwnershipPct * 100) / 100,
		};
	};

	const captainSelect: CaptainStatPlayer[] = [...captainCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId]) => buildCaptainPlayer(playerId, captainPercentages.get(playerId) ?? 0))
		.filter((p): p is CaptainStatPlayer => p !== null);

	const viceCaptainSelect: CaptainStatPlayer[] = [...viceCaptainCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId]) => buildCaptainPlayer(playerId, viceCaptainPercentages.get(playerId) ?? 0))
		.filter((p): p is CaptainStatPlayer => p !== null);

	const mostSelectedPlayers: SelectionStatPlayer[] = sortedByPick
		.slice(0, safeLimit)
		.map(([playerId]) => buildSelectionPlayer(playerId))
		.filter((p): p is SelectionStatPlayer => p !== null);

	const buildTransferPlayer = (
		playerId: number,
		transferCount: number
	): TransferStatPlayer | null => {
		const player = playerMap.get(playerId);
		if (!player) return null;
		const team = teamMap.get(player.team_id);
		const selectedPct = selectionPercentages.get(playerId) ?? 0;
		return {
			id: player.id,
			webName: player.web_name,
			teamShortName: team?.short_name ?? "",
			position: positionTypeToEnum(player.type),
			transfersEvent: transferCount,
			selectedByPercent: Math.round(selectedPct * 100) / 100,
		};
	};

	const mostTransferIn: TransferStatPlayer[] = [...transferInCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId, count]) => buildTransferPlayer(playerId, count))
		.filter((p): p is TransferStatPlayer => p !== null);

	const mostTransferOut: TransferStatPlayer[] = [...transferOutCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, safeLimit)
		.map(([playerId, count]) => buildTransferPlayer(playerId, count))
		.filter((p): p is TransferStatPlayer => p !== null);

	return {
		totalEntries: effectiveTotal,
		goalkeepers: sortByPosition(1),
		defenders: sortByPosition(2),
		midfielders: sortByPosition(3),
		forwards: sortByPosition(4),
		captainSelect,
		viceCaptainSelect,
		mostSelectedPlayers,
		mostTransferIn,
		mostTransferOut,
	};
}

/**
 * Public-safe path: consume only a published aggregate snapshot. It never
 * falls back to entry IDs, picks, or the per-manager aggregation RPCs.
 */
export async function getTournamentSelectionStatsReadModel(
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	limit: number
): Promise<TournamentSelectionStats | null> {
	if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) return null;
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
	const safeLimit = Math.min(Math.max(limit, 1), 12);
	const rows = await getReadModelRows(context, tournamentId, eventId);
	if (!rows || rows.length === 0) return null;
	const parsed = snapshotFromReadModel(rows);
	if (!parsed) return null;
	const { snapshot, totalEntries } = parsed;
	const season = await getCurrentSeason(context);
	return buildTournamentSelectionStats(context, snapshot, totalEntries, safeLimit, eventId, season);
}

export interface EventStatsRepository {
	getTournamentSelectionStats(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number
	): Promise<TournamentSelectionStats>;
}

export const eventStatsRepository: EventStatsRepository = {
	async getTournamentSelectionStats(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number
	): Promise<TournamentSelectionStats> {
		if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) return EMPTY_STATS;
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return EMPTY_STATS;
		const safeLimit = Math.min(Math.max(limit, 1), 100);

		const cacheKey = await privateCacheKey(
			context,
			`tournament-selection-stats:${tournamentId}:${eventId}:${safeLimit}`
		);
		const cached = await readJsonQueryCache(context, cacheKey, decodeTournamentSelectionStats);
		if (cached) {
			return cached;
		}

		const readModelRows = await getReadModelRows(context, tournamentId, eventId);
		if (readModelRows && readModelRows.length > 0) {
			const parsed = snapshotFromReadModel(readModelRows);
			if (!parsed) return EMPTY_STATS;
			const { snapshot, totalEntries } = parsed;
			const season = await getCurrentSeason(context);
			const result = await buildTournamentSelectionStats(
				context,
				snapshot,
				totalEntries,
				safeLimit,
				eventId,
				season
			);
			await writeJsonQueryCache(context, cacheKey, result, QUERY_CACHE_TTL_SECONDS.REPORTING);
			return result;
		}

		return EMPTY_STATS;
	},
};
