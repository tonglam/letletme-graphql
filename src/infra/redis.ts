import Redis from "ioredis";
import { env } from "./env";

let client: Redis | null = null;
let rateLimitClient: Redis | null = null;

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

export const getRedis = (): Redis => {
	if (!client) {
		client = createRedisClient(env.REDIS_URL, "primary");
	}
	return client;
};

/** Keep security admission isolated from publication and query-cache bursts. */
export const getRateLimitRedis = (): Redis => {
	if (!rateLimitClient) {
		rateLimitClient = createRedisClient(env.RATE_LIMIT_REDIS_URL, "rate-limit");
	}
	return rateLimitClient;
};

const connectClient = async (redis: Redis): Promise<void> => {
	if (redis.status === "end" || redis.status === "wait") {
		await redis.connect();
	}
};

const infoValue = (info: string, key: string): string | undefined => {
	const line = info.split("\n").find((candidate) => candidate.startsWith(`${key}:`));
	return line?.slice(key.length + 1).trim() || undefined;
};

const serverIdentity = async (redis: Pick<Redis, "info">): Promise<string> => {
	const [serverInfo, replicationInfo] = await Promise.all([
		redis.info("server"),
		redis.info("replication"),
	]);
	// master_replid is shared by all replicas of one Redis primary, while
	// run_id identifies a standalone server. Comparing the resolved server
	// identity after authentication catches URL aliases and DNS aliases that
	// cannot be detected by comparing the configured hostname strings.
	const masterReplicationId = infoValue(replicationInfo, "master_replid");
	const runId = infoValue(serverInfo, "run_id");
	const identity = masterReplicationId ?? runId;
	if (!identity) {
		throw new Error("Redis server identity is unavailable; refusing shared-endpoint configuration");
	}
	return identity;
};

export const assertRedisIsolation = async (
	primary: Pick<Redis, "info"> = getRedis(),
	rateLimit: Pick<Redis, "info"> = getRateLimitRedis()
): Promise<void> => {
	const [primaryIdentity, rateLimitIdentity] = await Promise.all([
		serverIdentity(primary),
		serverIdentity(rateLimit),
	]);
	if (primaryIdentity === rateLimitIdentity) {
		throw new Error("Primary and rate-limit Redis endpoints resolve to the same Redis server");
	}
};

export const connectRedis = async (): Promise<Redis> => {
	const redis = getRedis();
	await Promise.all([connectClient(redis), connectClient(getRateLimitRedis())]);
	await assertRedisIsolation(redis, getRateLimitRedis());
	return redis;
};

export const closeRedis = async (): Promise<void> => {
	const clients = [client, rateLimitClient].filter((value): value is Redis => value !== null);
	client = null;
	rateLimitClient = null;
	await Promise.all(clients.map((current) => current.quit()));
};
