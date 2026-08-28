import type Redis from "ioredis";
import { connectRedis, getRateLimitRedis, getRedis } from "../src/infra/redis";

const timeoutMs = 15_000;
const clients: Array<[name: string, client: Redis]> = [
	["primary", getRedis()],
	["rate-limit", getRateLimitRedis()],
];

const classifyError = (error: unknown): string => {
	const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	for (const code of [
		"ETIMEDOUT",
		"ECONNREFUSED",
		"ECONNRESET",
		"EHOSTUNREACH",
		"ENETUNREACH",
		"NOAUTH",
		"WRONGPASS",
		"READONLY",
	]) {
		if (message.toUpperCase().includes(code)) return code;
	}
	return error instanceof Error ? error.name : "UnknownError";
};

const closeClient = async (client: Redis): Promise<void> => {
	if (client.status === "ready") {
		try {
			await client.quit();
			return;
		} catch {
			// A failed QUIT must not keep a deployment probe alive.
		}
	}
	client.disconnect(false);
};

let timer: ReturnType<typeof setTimeout> | undefined;
let observedError: unknown;
for (const [, client] of clients) {
	client.on("error", (error) => {
		observedError ??= error;
	});
}

try {
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("ETIMEDOUT")), timeoutMs);
	});
	await Promise.race([connectRedis(), timeout]);
	const pongs = await Promise.race([
		Promise.all(clients.map(async ([name, client]) => [name, await client.ping()] as const)),
		timeout,
	]);
	for (const [name, pong] of pongs) {
		if (pong !== "PONG") throw new Error(`${name} Redis PING returned an unexpected response`);
	}
	console.log(
		JSON.stringify({
			event: "redis_connectivity_check",
			status: "passed",
			clients: pongs.map(([name]) => ({
				name,
				endpoint: name === "primary" ? "primary" : "rate-limit",
			})),
			// connectRedis has already authenticated both clients and compared
			// their resolved Redis server identities. A successful probe therefore
			// proves isolation even when the configured URLs use aliases.
			isolated: true,
		})
	);
} catch (error) {
	console.error(
		JSON.stringify({
			event: "redis_connectivity_check",
			status: "failed",
			reason: classifyError(observedError ?? error),
		})
	);
	process.exitCode = 1;
} finally {
	if (timer) clearTimeout(timer);
	await Promise.all(clients.map(([, client]) => closeClient(client)));
}
