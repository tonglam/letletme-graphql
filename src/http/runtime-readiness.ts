import { database, databaseHealthCheck } from "../infra/database";
import { env } from "../infra/env";
import { logger } from "../infra/logger";
import { getRateLimitRedis, getRedis } from "../infra/redis";
import type { CurrentSeasonProvider } from "../infra/season";
import { runHealthChecks } from "./health";

export type RuntimeReadiness = Readonly<{
	ok: boolean;
	body: string;
}>;

export const checkRuntimeReadiness = async (
	currentSeasonProvider: CurrentSeasonProvider,
	forceSeasonRefresh = false,
	strict = false
): Promise<RuntimeReadiness> => {
	const result = await runHealthChecks({
		redis: async () => {
			if ((await getRedis().ping()) !== "PONG") {
				throw new Error("primary Redis did not answer PONG");
			}
		},
		rateLimitRedis: async () => {
			if ((await getRateLimitRedis().ping()) !== "PONG") {
				throw new Error("rate-limit Redis did not answer PONG");
			}
		},
		postgres: async () => {
			await databaseHealthCheck();
		},
		season: async () => {
			if (forceSeasonRefresh) {
				await currentSeasonProvider.refresh(database, 0);
			} else {
				currentSeasonProvider.get();
			}
		},
	});
	const hotPathReady =
		result.checks.redis === "ok" &&
		result.checks.rateLimitRedis === "ok" &&
		result.checks.season === "ok";
	const ok = strict ? result.ok : hotPathReady;
	if (!ok || !result.ok)
		logger.warn({ checks: result.checks, strict }, "Health readiness degraded");
	return {
		ok,
		body: JSON.stringify({
			status: ok ? (result.ok ? "ok" : "degraded") : "unavailable",
			contractVersion: "live-points-v2",
			deploySha: env.DEPLOY_SHA,
			checks: result.checks,
		}),
	};
};
