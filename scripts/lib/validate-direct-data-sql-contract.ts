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
	parseSnapshotEntryPayload,
} from "../../src/domains/my-fpl/repository";
import { PLAYER_DETAIL_DATA_SQL_CONTRACT } from "../../src/domains/player-detail/repository";
import { PLAYER_VALUES_DATA_SQL_CONTRACT } from "../../src/domains/player-values/repository";
import { PLAYERS_DATA_SQL_CONTRACT } from "../../src/domains/players/repository";
import { PLAYER_STATE_DATA_SQL_CONTRACT } from "../../src/domains/player-state/repository";
import { PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/public-league-trends/repository";
import { TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/trends/repository";
import {
	BRIEFING_DATA_SQL_CONTRACT,
	parseBriefingWeekPayload,
} from "../../src/infra/content-publication";
import {
	DATA_SNAPSHOT_DATA_SQL_CONTRACT,
	parseCoreFallbackRow,
} from "../../src/infra/data-snapshot";
import type { QueryExecutor } from "../../src/infra/database";
import {
	PRICE_CHANGE_DATA_SQL_CONTRACT,
	parsePublicationBoard,
} from "../../src/infra/price-change-predictions-client";
import { parseDataPublicationManifest } from "../../src/infra/data-publication";

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

const CONTRACT_SEASON_CODE = "2627";
const CONTRACT_ENTRY_ID = 1;

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
				if (probe.runtime === "must-return-briefing") {
					const payload = (result.rows[0] as { payload?: unknown }).payload;
					const parsed = parseBriefingWeekPayload(payload, "en");
					if (
						!parsed ||
						parsed.publicationId !== String(probe.values[0]) ||
						parsed.locale !== String(probe.values[1])
					) {
						throw new Error(
							"runtime reader role returned a Briefing payload that the production decoder rejects"
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
					const row = result.rows[0] as {
						publication_id?: unknown;
						revision?: unknown;
						manifest?: unknown;
						items?: unknown;
					};
					const rawManifest =
						typeof row.manifest === "string" ? row.manifest : JSON.stringify(row.manifest);
					const manifest = rawManifest ? parseDataPublicationManifest(rawManifest) : null;
					const items = isRecord(row.items) ? row.items : null;
					const context = items && isRecord(items.context) ? items.context : null;
					const now =
						context && typeof context.fetchedAt === "string"
							? new Date(context.fetchedAt)
							: new Date();
					const board =
						manifest &&
						items &&
						typeof row.publication_id === "string" &&
						Number(row.revision) === manifest.revision &&
						manifest.publicationId === row.publication_id &&
						Number.isFinite(now.getTime())
							? parsePublicationBoard({ manifest, items }, now)
							: null;
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
					if (
						personalRows.length === 0 ||
						personalRows.some((row) => {
							const selection = row as {
								element_id?: unknown;
								player_name?: unknown;
								team_short_name?: unknown;
							};
							return (
								!Number.isInteger(Number(selection.element_id)) ||
								Number(selection.element_id) <= 0 ||
								typeof selection.player_name !== "string" ||
								selection.player_name.trim() === "" ||
								typeof selection.team_short_name !== "string" ||
								selection.team_short_name.trim() === ""
							);
						})
					) {
						throw new Error(
							"runtime reader role cannot see a valid personal Trends selection fixture"
						);
					}
				}
				if (probe.runtime === "must-return-board") {
					const board = result.rows[0] as {
						field_size?: unknown;
						viewer_row?: unknown;
					};
					if (
						typeof board.field_size !== "number" ||
						!Number.isInteger(board.field_size) ||
						board.field_size <= 0 ||
						board.viewer_row === null ||
						board.viewer_row === undefined
					) {
						throw new Error(
							"runtime reader role cannot see a positive competition board field or viewer row"
						);
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
