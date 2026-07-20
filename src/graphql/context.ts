import type { SupabaseClient } from "@supabase/supabase-js";
import type Redis from "ioredis";
import type { AuthUser } from "../infra/principal";
import type { Logger } from "../infra/logger";
import type { Principal } from "../infra/principal";
import type { Player } from "../domains/players/repository";

export type GraphQLContext = {
	supabase: SupabaseClient;
	redis: Redis;
	logger: Logger;
	principal?: Principal;
	user?: AuthUser; // Authenticated user (web or mobile)
	/** Set by batched queries (e.g. `liveScores`) so `LivePerformance.player` avoids per-row fetches. */
	playersByIdPreload?: Map<number, Player | null>;
};
