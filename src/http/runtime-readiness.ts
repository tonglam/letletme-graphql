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
	forceSeasonRefresh = true
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
	if (!result.ok) logger.warn({ checks: result.checks }, "Health readiness degraded");
	return {
		ok: result.ok,
		body: JSON.stringify({
			status: result.ok ? "ok" : "degraded",
			revision: env.APP_REVISION,
			checks: result.checks,
		}),
	};
};
