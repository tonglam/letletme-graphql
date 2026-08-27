import Redis from "ioredis";
import { env } from "./env";
import { RedisClientRegistry } from "./redis-client-registry";

const createRedisClient = (url: string, role: "primary" | "rate-limit"): Redis =>
	new Redis(url, {
		lazyConnect: true,
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
		enableAutoPipelining: true,
		connectTimeout: 2_000,
		commandTimeout: 2_000,
		connectionName: `letletme-graphql-${role}`,
	});

const redisClients = new RedisClientRegistry<Redis>(
	{ primary: env.REDIS_URL, rateLimit: env.RATE_LIMIT_REDIS_URL },
	createRedisClient
);

export const getRedis = (): Redis => redisClients.getPrimary();

/** Keep security admission isolated from publication and query-cache bursts. */
export const getRateLimitRedis = (): Redis => redisClients.getRateLimit();

const redisInfoValue = (info: string, key: string): string | undefined => {
	const line = info.split("\n").find((entry) => entry.startsWith(`${key}:`));
	return line?.slice(key.length + 1).trim() || undefined;
};

const connectedRedisIdentity = async (redis: Redis): Promise<string> => {
	const [serverInfo, replicationInfo] = await Promise.all([
		redis.info("server"),
		redis.info("replication"),
	]);
	// Replicas of one Redis primary have different run_id values but share the
	// primary's master_replid. Prefer that durable replication identity and use
	// run_id for standalone servers that have not exposed one yet.
	const masterReplId = redisInfoValue(replicationInfo, "master_replid");
	const runId = redisInfoValue(serverInfo, "run_id");
	const identity = masterReplId && masterReplId !== "-" ? `master:${masterReplId}` : runId;
	if (!identity) throw new Error("Redis server identity is unavailable");
	return identity;
};

/**
 * Verify workload isolation against connected Redis servers, not just URL
 * spelling. DNS aliases and different database numbers can still point at
 * the same Redis authority, which would let cache traffic starve admission.
 */
export const assertRedisWorkloadIsolation = async (): Promise<void> => {
	const [primaryIdentity, rateLimitIdentity] = await Promise.all([
		connectedRedisIdentity(getRedis()),
		connectedRedisIdentity(getRateLimitRedis()),
	]);
	if (primaryIdentity === rateLimitIdentity) {
		throw new Error("Primary and rate-limit Redis servers must have different identities");
	}
};

export const connectRedis = async (): Promise<Redis> => {
	const redis = await redisClients.connectAll();
	await assertRedisWorkloadIsolation();
	return redis;
};

export const closeRedis = async (): Promise<void> => redisClients.closeAll();
