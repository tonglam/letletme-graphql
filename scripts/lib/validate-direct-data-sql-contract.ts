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
	parseSnapshotEntryPayload,
} from "../../src/domains/my-fpl/repository";
import { PLAYER_DETAIL_DATA_SQL_CONTRACT } from "../../src/domains/player-detail/repository";
import { PLAYER_VALUES_DATA_SQL_CONTRACT } from "../../src/domains/player-values/repository";
import { PLAYERS_DATA_SQL_CONTRACT } from "../../src/domains/players/repository";
import { PLAYER_STATE_DATA_SQL_CONTRACT } from "../../src/domains/player-state/repository";
import { PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/public-league-trends/repository";
import { TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/trends/repository";
import { BRIEFING_DATA_SQL_CONTRACT } from "../../src/infra/content-publication";
import { DATA_SNAPSHOT_DATA_SQL_CONTRACT } from "../../src/infra/data-snapshot";
import type { QueryExecutor } from "../../src/infra/database";
import { PRICE_CHANGE_DATA_SQL_CONTRACT } from "../../src/infra/price-change-predictions-client";

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
