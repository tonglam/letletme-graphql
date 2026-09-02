import type Redis from "ioredis";
import type { AuthUser } from "../infra/principal";
import type { Logger } from "../infra/logger";
import type { Principal } from "../infra/principal";
import type { QueryExecutor } from "../infra/database";
import type { CurrentSeason } from "../infra/season";
import type { ReadModelClient } from "../infra/read-model-client";
import type { Player } from "../domains/players/repository";
import type { RequestTiming } from "../http/request-timing";

export type LiveMatchExecutionObservation = Readonly<{
	view: "HEAD" | "DESK" | "FULL";
	state: "FRESH" | "STALE" | "DEGRADED" | "FINAL" | "PENDING" | "UNAVAILABLE";
	servedFrom: string;
	/** The earliest non-final stale boundary from the owner response, in epoch milliseconds. */
	shareUntilMs: number | null;
}>;

export type GraphQLContext = {
	data: ReadModelClient;
	database: QueryExecutor;
	currentSeason: CurrentSeason;
	/** Refreshes the mutable current-season lifecycle before state reads. */
	refreshCurrentSeason?: () => Promise<CurrentSeason>;
	/** Core Data publication selected once for this GraphQL request. */
	dataRevision?: string;
	redis: Redis;
	logger: Logger;
	/** Opaque request correlation identifier; never derived from user identity. */
	requestId?: string;
	/** Named GraphQL operation only; variables and query text are never logged. */
	operationName?: string;
	/** Controlled manifest symbols selected by this request, committed after variable coercion. */
	deprecatedSymbols?: readonly string[];
	/** Per-field ownership for deprecated symbols, used to avoid counting unreachable selections. */
	deprecatedSymbolOwners?: Readonly<Record<string, readonly string[]>>;
	/** Deprecated symbols selected outside any field occurrence, such as operation directives. */
	deprecatedSymbolGlobalSymbols?: readonly string[];
	/** Request-local low-cardinality stage timings. */
	requestTiming?: RequestTiming;
	/** Stable identity shared by Apollo's shallow context clone for request-local memoization. */
	requestScope?: object;
	/** Tournament memberships freshly proven before resolver/cache access in this request. */
	authorizedTournamentMemberships?: Set<number>;
	/** Whether the latest Core snapshot lookup reused the request-pinned promise. */
	coreSnapshotMemoStatus?: "hit" | "miss";
	/** Whether this request acquired the full Core publication. */
	fullCoreLoaded?: boolean;
	principal?: Principal;
	user?: AuthUser; // Authenticated Web or Mini Program user
	/** Set by batched queries (e.g. `liveScores`) so `LivePerformance.player` avoids per-row fetches. */
	playersByIdPreload?: Map<number, Player | null>;
	/** Event/player keyed percentages preloaded by batched live-explanation roots. */
	liveSelectedByPreload?: Map<string, number | null>;
};
