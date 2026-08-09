#!/usr/bin/env bun

/**
 * Initialize the Season:active key in Redis.
 * Usage: bun run scripts/init-season.ts [season]
 * Refuses to guess: the caller must provide a four-digit season code.
 */

import { connectRedis } from "../src/infra/redis";
import { ACTIVE_SEASON_KEY, parseSeason } from "../src/infra/season";

const season = parseSeason(process.argv[2] ?? null);

if (!season) {
	throw new Error("Usage: bun run scripts/init-season.ts <four-digit-season>, for example 2526");
}

async function main(activeSeason: string): Promise<void> {
	const redis = await connectRedis();
	await redis.set(ACTIVE_SEASON_KEY, activeSeason);
	console.log(`Set ${ACTIVE_SEASON_KEY} = ${activeSeason}`);
	await redis.quit();
}

main(season).catch((err) => {
	console.error(err);
	process.exit(1);
});
