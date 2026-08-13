import Redis from "ioredis";
import { env } from "./env";

let client: Redis | null = null;
let rateLimitClient: Redis | null = null;

const createRedisClient = (): Redis =>
	new Redis({
		host: env.REDIS_HOST,
		port: env.REDIS_PORT,
		password: env.REDIS_PASSWORD || undefined,
		lazyConnect: true,
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
		enableAutoPipelining: true,
	});

export const getRedis = (): Redis => {
	if (!client) {
		client = createRedisClient();
	}
	return client;
};

/** Keep security admission isolated from publication and query-cache bursts. */
export const getRateLimitRedis = (): Redis => {
	if (!rateLimitClient) {
		rateLimitClient = createRedisClient();
	}
	return rateLimitClient;
};

const connectClient = async (redis: Redis): Promise<void> => {
	if (redis.status === "end" || redis.status === "wait") {
		await redis.connect();
	}
};

export const connectRedis = async (): Promise<Redis> => {
	const redis = getRedis();
	await Promise.all([connectClient(redis), connectClient(getRateLimitRedis())]);
	return redis;
};

export const closeRedis = async (): Promise<void> => {
	const clients = [client, rateLimitClient].filter((value): value is Redis => value !== null);
	client = null;
	rateLimitClient = null;
	await Promise.all(clients.map((current) => current.quit()));
};
