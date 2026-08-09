import type Redis from "ioredis";
import type { AuthUser } from "../infra/principal";
import type { Logger } from "../infra/logger";
import type { Principal } from "../infra/principal";
import type { QueryExecutor } from "../infra/database";
import type { CurrentSeason } from "../infra/season";
import type { V3ReadClient } from "../infra/v3-read-client";
import type { Player } from "../domains/players/repository";

export type GraphQLContext = {
	data: V3ReadClient;
	database: QueryExecutor;
	currentSeason: CurrentSeason;
	/** Core Data publication selected once for this GraphQL request. */
	dataRevision?: string;
	redis: Redis;
	logger: Logger;
	principal?: Principal;
	user?: AuthUser; // Authenticated user (web or mobile)
	/** Set by batched queries (e.g. `liveScores`) so `LivePerformance.player` avoids per-row fetches. */
	playersByIdPreload?: Map<number, Player | null>;
	/** Event/player keyed percentages preloaded by batched live-explanation roots. */
	liveSelectedByPreload?: Map<string, number | null>;
};
