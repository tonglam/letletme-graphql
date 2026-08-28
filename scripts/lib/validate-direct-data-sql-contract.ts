import type { DataSqlContractProbe } from "../../src/contracts/data-sql-contract";
import { MY_FPL_DATA_SQL_CONTRACT } from "../../src/domains/my-fpl/repository";
import { PLAYER_STATE_DATA_SQL_CONTRACT } from "../../src/domains/player-state/repository";
import { PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/public-league-trends/repository";
import { TRENDS_DATA_SQL_CONTRACT } from "../../src/domains/trends/repository";
import { BRIEFING_DATA_SQL_CONTRACT } from "../../src/infra/content-publication";
import type { QueryExecutor } from "../../src/infra/database";

export const DIRECT_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	...BRIEFING_DATA_SQL_CONTRACT,
	...MY_FPL_DATA_SQL_CONTRACT,
	...PLAYER_STATE_DATA_SQL_CONTRACT,
	...PUBLIC_LEAGUE_TRENDS_DATA_SQL_CONTRACT,
	...TRENDS_DATA_SQL_CONTRACT,
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
