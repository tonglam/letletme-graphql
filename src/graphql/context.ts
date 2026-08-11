import type Redis from "ioredis";
import type { AuthUser } from "../infra/principal";
import type { Logger } from "../infra/logger";
import type { Principal } from "../infra/principal";
import type { QueryExecutor } from "../infra/database";
import type { CurrentSeason } from "../infra/season";
import type { ReadModelClient } from "../infra/read-model-client";
import type { Player } from "../domains/players/repository";
import type { RequestTiming } from "../http/request-timing";

export type GraphQLContext = {
	data: ReadModelClient;
	database: QueryExecutor;
	currentSeason: CurrentSeason;
	/** Core Data publication selected once for this GraphQL request. */
	dataRevision?: string;
	redis: Redis;
	logger: Logger;
	/** Opaque request correlation identifier; never derived from user identity. */
	requestId?: string;
	/** Named GraphQL operation only; variables and query text are never logged. */
	operationName?: string;
	/** Request-local low-cardinality stage timings. */
	requestTiming?: RequestTiming;
	/** Stable identity shared by Apollo's shallow context clone for request-local memoization. */
	requestScope?: object;
	/** Whether the latest Core snapshot lookup reused the request-pinned promise. */
	coreSnapshotMemoStatus?: "hit" | "miss";
	principal?: Principal;
	user?: AuthUser; // Authenticated Web or Mini Program user
	/** Set by batched queries (e.g. `liveScores`) so `LivePerformance.player` avoids per-row fetches. */
	playersByIdPreload?: Map<number, Player | null>;
	/** Event/player keyed percentages preloaded by batched live-explanation roots. */
	liveSelectedByPreload?: Map<string, number | null>;
};
