import type { DataSqlContractProbe } from "../../src/contracts/data-sql-contract";
import { ENTRIES_DATA_SQL_CONTRACT } from "../../src/domains/entries/repository";
import { GAMEWEEK_DATA_SQL_CONTRACT } from "../../src/domains/gameweek/service";
import { HOME_MARKET_DATA_SQL_CONTRACT } from "../../src/domains/home/market-repository";
import { HOME_DATA_SQL_CONTRACT } from "../../src/domains/home/repository";
import { MARKET_DATA_SQL_CONTRACT } from "../../src/domains/market/repository";
import { MY_FPL_DATA_SQL_CONTRACT } from "../../src/domains/my-fpl/repository";
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

export const validateDirectDataSqlContract = async (database: QueryExecutor): Promise<number> => {
	const names = new Set<string>();
	for (const probe of DIRECT_DATA_SQL_CONTRACT) {
		if (names.has(probe.name)) throw new Error(`Duplicate direct SQL contract name: ${probe.name}`);
		names.add(probe.name);
		try {
			await database.query(`EXPLAIN (FORMAT JSON, COSTS OFF) ${probe.sql}`, probe.values);
		} catch (cause) {
			throw new Error(`Data candidate direct SQL contract is unavailable: ${probe.name}`, {
				cause,
			});
		}
	}
	return names.size;
};
