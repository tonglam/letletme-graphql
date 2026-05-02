import type { SupabaseClient } from "@supabase/supabase-js";
import type Redis from "ioredis";
import type { AuthUser } from "../infra/auth";
import type { Logger } from "../infra/logger";
import type { Player } from "../domains/players/repository";

export type GraphQLContext = {
	supabase: SupabaseClient;
	redis: Redis;
	logger: Logger;
	user?: AuthUser; // Authenticated user (web or mobile)
	/** Set by batched queries (e.g. `liveScores`) so `LivePerformance.player` avoids per-row fetches. */
	playersByIdPreload?: Map<number, Player | null>;
};
