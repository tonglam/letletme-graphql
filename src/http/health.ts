export type HealthCheckStatus = "ok" | "fail";

export type HealthChecks = Readonly<{
	redis: HealthCheckStatus;
	rateLimitRedis: HealthCheckStatus;
	postgres: HealthCheckStatus;
	season: HealthCheckStatus;
}>;

export type HealthResult = Readonly<{
	ok: boolean;
	checks: HealthChecks;
}>;

type Probe = () => Promise<void>;

const HEALTH_PROBE_TIMEOUT_MS = 2_000;

const withTimeout = async (probe: Probe): Promise<boolean> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			probe(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("health probe timed out")),
					HEALTH_PROBE_TIMEOUT_MS
				);
			}),
		]);
		return true;
	} catch {
		return false;
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const runHealthChecks = async ({
	redis,
	rateLimitRedis,
	postgres,
	season,
}: {
	redis: Probe;
	rateLimitRedis: Probe;
	postgres: Probe;
	season: Probe;
}): Promise<HealthResult> => {
	const [redisOk, rateLimitRedisOk, postgresOk, seasonOk] = await Promise.all([
		withTimeout(redis),
		withTimeout(rateLimitRedis),
		withTimeout(postgres),
		withTimeout(season),
	]);
	const checks: HealthChecks = {
		redis: redisOk ? "ok" : "fail",
		rateLimitRedis: rateLimitRedisOk ? "ok" : "fail",
		postgres: postgresOk ? "ok" : "fail",
		season: seasonOk ? "ok" : "fail",
	};
	return { ok: Object.values(checks).every((value) => value === "ok"), checks };
};
