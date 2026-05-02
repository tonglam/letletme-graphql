#!/usr/bin/env bun

/**
 * Initialize the season:current key in Redis.
 * Usage: bun run scripts/init-season.ts [season]
 * Defaults to "2526" if no season is provided.
 */

import { connectRedis } from "../src/infra/redis";

const SEASON = process.argv[2] ?? "2526";

async function main() {
	const redis = await connectRedis();
	await redis.set("season:current", SEASON);
	console.log(`Set season:current = ${SEASON}`);
	await redis.quit();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
