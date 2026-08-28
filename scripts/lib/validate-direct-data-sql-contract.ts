import type {
	DataSqlContractProbe,
	DataSqlContractResultType,
} from "../../src/contracts/data-sql-contract";
import { ENTRIES_DATA_SQL_CONTRACT } from "../../src/domains/entries/repository";
import { GAMEWEEK_DATA_SQL_CONTRACT } from "../../src/domains/gameweek/service";
import { HOME_MARKET_DATA_SQL_CONTRACT } from "../../src/domains/home/market-repository";
import { HOME_DATA_SQL_CONTRACT } from "../../src/domains/home/repository";
import { MARKET_DATA_SQL_CONTRACT } from "../../src/domains/market/repository";
import {
	MY_FPL_DATA_SQL_CONTRACT,
	parseCompetitionAggregatePayload,
	parseCompetitionBoardProbe,
	parseCompetitionSeasonPathPoints,
	parseSnapshotPublicationRow,
	parseSnapshotEntryPayload,
} from "../../src/domains/my-fpl/repository";
import { buildMarketPulse, type MarketSnapshotRow } from "../../src/domains/market/repository";
import { PLAYER_DETAIL_DATA_SQL_CONTRACT } from "../../src/domains/player-detail/repository";
import { PLAYER_VALUES_DATA_SQL_CONTRACT } from "../../src/domains/player-values/repository";
import {
	parsePlayerPickerRow,
	PLAYERS_DATA_SQL_CONTRACT,
} from "../../src/domains/players/repository";
import {
	parsePlayerStateSeasonRow,
	PLAYER_STATE_DATA_SQL_CONTRACT,
} from "../../src/domains/player-state/repository";
import { PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/public-league-trends/repository";
import { TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/trends/repository";
import {
	BRIEFING_DATA_SQL_CONTRACT,
	BRIEFING_ACTIVE_METADATA_SQL,
	parseBriefingActiveMetadata,
	parseBriefingFallbackRow,
} from "../../src/infra/content-publication";
import {
	DATA_SNAPSHOT_DATA_SQL_CONTRACT,
	parseCoreFallbackRow,
	parseLiveFallbackRow,
	type LiveFallbackRow,
} from "../../src/infra/data-snapshot";
import type { QueryExecutor } from "../../src/infra/database";
import {
	PRICE_CHANGE_DATA_SQL_CONTRACT,
	parsePriceChangeContractRow,
} from "../../src/infra/price-change-predictions-client";

export const DIRECT_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	...BRIEFING_DATA_SQL_CONTRACT,
	...ENTRIES_DATA_SQL_CONTRACT,
	...GAMEWEEK_DATA_SQL_CONTRACT,
	...HOME_DATA_SQL_CONTRACT,
	...HOME_MARKET_DATA_SQL_CONTRACT,
	...MARKET_DATA_SQL_CONTRACT,
	...MY_FPL_DATA_SQL_CONTRACT,
	...PLAYER_DETAIL_DATA_SQL_CONTRACT,
	...PLAYERS_DATA_SQL_CONTRACT,
	...PLAYER_VALUES_DATA_SQL_CONTRACT,
	...PLAYER_STATE_DATA_SQL_CONTRACT,
	...PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT,
	...TRENDS_DATA_SQL_CONTRACT,
	...DATA_SNAPSHOT_DATA_SQL_CONTRACT,
	...PRICE_CHANGE_DATA_SQL_CONTRACT,
];

type ResultTypeRow = {
	relation_name: string;
	column_name: string;
	actual_type: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isValidTimestamp = (value: unknown): boolean => {
	if (value instanceof Date) return Number.isFinite(value.getTime());
	return typeof value === "string" && Number.isFinite(Date.parse(value));
};

const CONTRACT_SEASON_CODE = "2627";
const CONTRACT_ENTRY_ID = 1;
const CONTRACT_PLAYER_ID = 1;
const CONTRACT_PLAYER_CODE = 26001;
const CONTRACT_PLAYER_EVENT_STATS_REVISION = "1";
const CONTRACT_PLAYER_EVENT_TOTAL_POINTS = 42;
const CONTRACT_PLAYER_EVENT_FORM = 4.2;
const CONTRACT_FPL_SQUAD_SIZE = 15;

const RESULT_TYPE_SQL = `
	SELECT
		target.relation_name,
		target.column_name,
		format_type(attribute.atttypid, attribute.atttypmod) AS actual_type
	FROM unnest($1::text[], $2::text[]) AS target(relation_name, column_name)
	LEFT JOIN pg_class relation
		ON relation.oid = to_regclass(target.relation_name)
	LEFT JOIN pg_attribute attribute
		ON attribute.attrelid = relation.oid
		AND attribute.attname = target.column_name
		AND attribute.attnum > 0
		AND NOT attribute.attisdropped
	ORDER BY target.relation_name, target.column_name
`;

export const allowedResultTypes = (assertion: DataSqlContractResultType): readonly string[] =>
	[...new Set([assertion.pgType, ...(assertion.acceptedPgTypes ?? [])])].sort();

const resultTypeAssertions = (): readonly DataSqlContractResultType[] => {
	const assertions = new Map<string, DataSqlContractResultType>();
	for (const probe of DIRECT_DATA_SQL_CONTRACT) {
		for (const assertion of probe.resultTypes ?? []) {
			const key = `${assertion.relation}.${assertion.column}`;
			const previous = assertions.get(key);
			if (
				previous &&
				JSON.stringify(allowedResultTypes(previous)) !==
					JSON.stringify(allowedResultTypes(assertion))
			) {
				throw new Error(
					`Conflicting direct SQL result type contract for ${key}: ${allowedResultTypes(previous).join(", ")} vs ${allowedResultTypes(assertion).join(", ")}`
				);
			}
			assertions.set(key, assertion);
		}
	}
	return [...assertions.values()].sort((left, right) =>
		`${left.relation}.${left.column}`.localeCompare(`${right.relation}.${right.column}`)
	);
};

const validateResultTypes = async (database: QueryExecutor): Promise<void> => {
	const assertions = resultTypeAssertions();
	if (assertions.length === 0) return;
	const result = await database.query<ResultTypeRow>(RESULT_TYPE_SQL, [
		assertions.map((assertion) => assertion.relation),
		assertions.map((assertion) => assertion.column),
	]);
	const actualByKey = new Map(
		result.rows.map((row) => [`${row.relation_name}.${row.column_name}`, row.actual_type])
	);
	for (const assertion of assertions) {
		const key = `${assertion.relation}.${assertion.column}`;
		const actualType = actualByKey.get(key) ?? null;
		const expectedTypes = allowedResultTypes(assertion);
		if (!actualType || !expectedTypes.includes(actualType)) {
			throw new Error(
				`Data candidate result type contract is unavailable: ${key} expected ${expectedTypes.join(" or ")}, got ${actualType ?? "missing"}`
			);
		}
	}
};

export const validateDirectDataSqlContract = async (database: QueryExecutor): Promise<number> => {
	try {
		await validateResultTypes(database);
	} catch (cause) {
		const detail = cause instanceof Error ? `: ${cause.message}` : "";
		throw new Error(`Data candidate result type contract is unavailable${detail}`, { cause });
	}
	const names = new Set<string>();
	for (const probe of DIRECT_DATA_SQL_CONTRACT) {
		if (names.has(probe.name)) throw new Error(`Duplicate direct SQL contract name: ${probe.name}`);
		names.add(probe.name);
		try {
			await database.query(`EXPLAIN (FORMAT JSON, COSTS OFF) ${probe.sql}`, probe.values);
			if (probe.runtime) {
				const result = await database.query(probe.sql, probe.values);
				if (result.rows.length === 0) {
					throw new Error("runtime reader role cannot see the Data-owned authority fixture row");
				}
				if (probe.runtime === "must-return-publication") {
					const publication = result.rows
						.map((row) => parseSnapshotPublicationRow(row))
						.find((candidate) => candidate !== null);
					if (!publication || publication.eventId <= 0 || publication.revision.trim() === "") {
						throw new Error(
							"runtime reader role returned an active My FPL publication that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-briefing") {
					const metadataResult = await database.query(BRIEFING_ACTIVE_METADATA_SQL, ["week"]);
					const activeRow = metadataResult.rows[0] as { publication_id?: unknown } | undefined;
					const metadata =
						activeRow && typeof activeRow.publication_id === "string"
							? parseBriefingActiveMetadata(activeRow, activeRow.publication_id)
							: null;
					const locale =
						probe.values[1] === "en" || probe.values[1] === "zh-CN" ? probe.values[1] : null;
					const parsed =
						metadata && locale ? parseBriefingFallbackRow(result.rows[0], locale, metadata) : null;
					if (!parsed || !metadata || parsed.publicationId !== metadata.publication_id) {
						throw new Error(
							"runtime reader role returned a Briefing payload that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-briefing-metadata") {
					const activeRow = result.rows[0] as { publication_id?: unknown };
					const metadata =
						typeof activeRow.publication_id === "string"
							? parseBriefingActiveMetadata(activeRow, activeRow.publication_id)
							: null;
					if (!metadata) {
						throw new Error(
							"runtime reader role returned active Briefing metadata that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-core") {
					const core = parseCoreFallbackRow(result.rows[0], CONTRACT_SEASON_CODE);
					if (!core) {
						throw new Error(
							"runtime reader role returned a Core fallback row that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-competition-aggregate") {
					const aggregate = parseCompetitionAggregatePayload(
						(result.rows[0] as { payload?: unknown }).payload,
						CONTRACT_ENTRY_ID
					);
					if (!aggregate || aggregate.eventId !== Number(probe.values[1])) {
						throw new Error(
							"runtime reader role returned an aggregate payload that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-price-change") {
					const board = parsePriceChangeContractRow(result.rows[0]);
					if (!board) {
						throw new Error(
							"runtime reader role returned a price-change publication that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-trends-personal") {
					const personalRows = result.rows.filter(
						(row) => (row as { capability?: unknown }).capability === "PERSONAL_EXPOSURE"
					);
					const elementIds = new Set(
						personalRows.map((row) => Number((row as { element_id?: unknown }).element_id))
					);
					const pickPositions = new Set(
						personalRows.map((row) => Number((row as { pick_position?: unknown }).pick_position))
					);
					if (
						personalRows.length !== CONTRACT_FPL_SQUAD_SIZE ||
						elementIds.size !== CONTRACT_FPL_SQUAD_SIZE ||
						pickPositions.size !== CONTRACT_FPL_SQUAD_SIZE ||
						personalRows.some((row) => {
							const selection = row as {
								element_id?: unknown;
								player_name?: unknown;
								team_short_name?: unknown;
								pick_position?: unknown;
							};
							return (
								!Number.isInteger(Number(selection.element_id)) ||
								Number(selection.element_id) <= 0 ||
								typeof selection.player_name !== "string" ||
								selection.player_name.trim() === "" ||
								typeof selection.team_short_name !== "string" ||
								selection.team_short_name.trim() === "" ||
								!Number.isInteger(Number(selection.pick_position)) ||
								Number(selection.pick_position) < 1 ||
								Number(selection.pick_position) > CONTRACT_FPL_SQUAD_SIZE
							);
						})
					) {
						throw new Error(
							"runtime reader role cannot see a valid personal Trends selection fixture"
						);
					}
				}
				if (probe.runtime === "must-return-board") {
					const board = parseCompetitionBoardProbe(result.rows[0], Number(probe.values[1]));
					if (!board) {
						throw new Error(
							"runtime reader role returned a competition board payload that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-season-path") {
					const payload = (result.rows[0] as { payload?: unknown }).payload;
					const rawPoints =
						isRecord(payload) && isRecord(payload.seasonPaths)
							? payload.seasonPaths[String(CONTRACT_ENTRY_ID)]
							: isRecord(payload)
								? payload.seasonPath
								: null;
					const points = parseCompetitionSeasonPathPoints(rawPoints);
					if (!points) {
						throw new Error(
							"runtime reader role returned a season-path payload that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-live") {
					const live = parseLiveFallbackRow(
						result.rows[0] as LiveFallbackRow,
						Number(probe.values[1]),
						CONTRACT_SEASON_CODE
					);
					if (!live) {
						throw new Error(
							"runtime reader role returned a live publication that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-market") {
					const marketRows = (result.rows[0] as { market_rows?: unknown }).market_rows;
					if (!Array.isArray(marketRows) || marketRows.length === 0) {
						throw new Error("runtime reader role cannot see a non-empty market snapshot fixture");
					}
					const pulse = buildMarketPulse(
						marketRows as MarketSnapshotRow[],
						Number(probe.values[1])
					);
					if (!pulse.coverage.latestDate || pulse.mostSelected.length === 0) {
						throw new Error(
							"runtime reader role returned a market payload that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-player-state-revision") {
					const row = result.rows[0] as {
						revision?: unknown;
						method_version?: unknown;
						source_updated_at?: unknown;
						refreshed_at?: unknown;
					};
					if (
						!Number.isSafeInteger(Number(row.revision)) ||
						Number(row.revision) <= 0 ||
						typeof row.method_version !== "string" ||
						row.method_version.trim() === "" ||
						!isValidTimestamp(row.source_updated_at) ||
						!isValidTimestamp(row.refreshed_at)
					) {
						throw new Error(
							"runtime reader role returned an invalid Player State dataset revision row"
						);
					}
				}
				if (probe.runtime === "must-return-historical-team") {
					const requestedPlayers = Array.isArray(probe.values[1]) ? probe.values[1] : [];
					const expectedPlayerCode = Number(requestedPlayers[0]);
					const hasExpectedMapping = result.rows.some((row) => {
						const mapping = row as { player_code?: unknown; team_id?: unknown };
						return (
							Number(mapping.player_code) === expectedPlayerCode &&
							Number.isInteger(Number(mapping.team_id)) &&
							Number(mapping.team_id) > 0
						);
					});
					if (!hasExpectedMapping) {
						throw new Error(
							"runtime reader role cannot see the expected historical-team mapping fixture"
						);
					}
				}
				if (probe.runtime === "must-return-setup-status") {
					const row = result.rows[0] as {
						setup_status?: unknown;
						setup_phase?: unknown;
						setup_progress_updated_at?: unknown;
						standings_ready_at?: unknown;
						insights_ready_at?: unknown;
					};
					if (
						typeof row.setup_status !== "string" ||
						row.setup_status.trim() === "" ||
						typeof row.setup_phase !== "string" ||
						row.setup_phase.trim() === "" ||
						(row.setup_progress_updated_at !== null &&
							!isValidTimestamp(row.setup_progress_updated_at)) ||
						(row.standings_ready_at !== null && !isValidTimestamp(row.standings_ready_at)) ||
						(row.insights_ready_at !== null && !isValidTimestamp(row.insights_ready_at))
					) {
						throw new Error("runtime reader role returned an invalid tournament setup-status row");
					}
				}
				if (probe.runtime === "must-return-snapshot-entry") {
					const snapshotEntry = result.rows[0] as { payload?: unknown };
					if (!parseSnapshotEntryPayload(snapshotEntry.payload)) {
						throw new Error(
							"runtime reader role returned a snapshot entry payload that the production decoder rejects"
						);
					}
				}
				if (probe.runtime === "must-return-tournament") {
					const tournament = result.rows[0] as { tournament_id?: unknown };
					const expectedTournamentId = Number(probe.values[2]);
					if (
						tournament.tournament_id === null ||
						tournament.tournament_id === undefined ||
						Number(tournament.tournament_id) !== expectedTournamentId
					) {
						throw new Error(
							`runtime reader role returned the wrong tournament membership row (expected ${expectedTournamentId})`
						);
					}
				}
				if (probe.runtime === "must-return-selection-row") {
					const selection = result.rows[0] as {
						element_id?: unknown;
						player_name?: unknown;
						team_short_name?: unknown;
					};
					if (
						!Number.isInteger(Number(selection.element_id)) ||
						Number(selection.element_id) <= 0 ||
						typeof selection.player_name !== "string" ||
						selection.player_name.trim() === "" ||
						typeof selection.team_short_name !== "string" ||
						selection.team_short_name.trim() === ""
					) {
						throw new Error("runtime reader role cannot see a non-null public selection row");
					}
				}
				if (probe.runtime === "must-return-player-picker") {
					const expectedRevision = String(probe.values[13] ?? CONTRACT_PLAYER_EVENT_STATS_REVISION);
					const expectedRow = result.rows.find((row) => {
						const parsed = parsePlayerPickerRow(row);
						const candidate = row as {
							event_stats_present?: unknown;
							event_stats_revision?: unknown;
						};
						return (
							parsed?.id === CONTRACT_PLAYER_ID &&
							parsed.totalPoints === CONTRACT_PLAYER_EVENT_TOTAL_POINTS &&
							parsed.form === CONTRACT_PLAYER_EVENT_FORM &&
							candidate.event_stats_present === true &&
							candidate.event_stats_revision === expectedRevision
						);
					});
					if (!expectedRow) {
						throw new Error(
							"runtime reader role returned a picker row without the pinned event-stat sentinel"
						);
					}
				}
				if (probe.runtime === "must-return-player-state-row") {
					const requestedPlayerCode = Array.isArray(probe.values[0])
						? Number(probe.values[0][0])
						: CONTRACT_PLAYER_CODE;
					const row = result.rows
						.map((candidate) => parsePlayerStateSeasonRow(candidate))
						.find(
							(candidate) =>
								candidate !== null &&
								candidate.player_code === requestedPlayerCode &&
								candidate.season_id === 2026 &&
								candidate.season_code === CONTRACT_SEASON_CODE &&
								candidate.element_id === CONTRACT_PLAYER_ID
						);
					if (!row) {
						throw new Error(
							"runtime reader role returned a Player State season row that the production decoder rejects"
						);
					}
				}
			}
		} catch (cause) {
			throw new Error(
				`Data candidate direct SQL contract is unavailable: ${probe.name}${
					probe.runtime ? " (runtime visibility)" : ""
				}`,
				{ cause }
			);
		}
	}
	return names.size;
};
