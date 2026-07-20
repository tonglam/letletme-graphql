import type { GraphQLContext } from "../../graphql/context";
import { env } from "../../infra/env";
import { getCurrentSeason } from "../../infra/season";
import { metrics } from "../../infra/metrics";

const parseBonusValue = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value;
	}
	if (typeof value === "string") {
		if (!/^\d+$/.test(value)) return null;
		const parsed = Number(value);
		return Number.isInteger(parsed) ? parsed : null;
	}
	return null;
};

const parseTeamBonus = (value: string): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
};

export async function loadLiveBonusByPlayerId(
	context: GraphQLContext,
	eventId: number
): Promise<Map<number, number>> {
	if (!Number.isFinite(eventId) || eventId <= 0) {
		return new Map();
	}

	const season = await getCurrentSeason(context);
	const hashKey = `${env.LIVE_POINTS_V2 ? "LiveBonusV2" : "LiveBonus"}:${season}:${eventId}`;
	let hashEntries: Record<string, string>;
	try {
		hashEntries = await context.redis.hgetall(hashKey);
		metrics.cacheRepositoryEvents.labels("live_bonus", "redis").inc();
	} catch (error) {
		const wrongType = error instanceof Error && error.message.includes("WRONGTYPE");
		metrics.cacheRepositoryEvents
			.labels("live_bonus", wrongType ? "wrong_type" : "fallback_official")
			.inc();
		context.logger.warn(
			{ err: error, hashKey },
			"Live bonus cache unavailable; preserving official aggregate bonus"
		);
		return new Map();
	}
	const bonusByPlayerId = new Map<number, number>();
	let malformed = false;

	for (const teamBonusRaw of Object.values(hashEntries)) {
		const teamBonus = parseTeamBonus(teamBonusRaw);
		if (!teamBonus) {
			malformed = true;
			continue;
		}

		for (const [elementIdRaw, bonusRaw] of Object.entries(teamBonus)) {
			const elementId = /^\d+$/.test(elementIdRaw) ? Number(elementIdRaw) : Number.NaN;
			const bonus = parseBonusValue(bonusRaw);
			if (Number.isInteger(elementId) && elementId > 0 && bonus !== null && bonus >= 0) {
				bonusByPlayerId.set(elementId, bonus);
			} else {
				malformed = true;
			}
		}
	}
	if (malformed) {
		metrics.cacheRepositoryEvents.labels("live_bonus", "malformed").inc();
		context.logger.warn(
			{ hashKey },
			"Malformed live bonus cache; preserving official aggregate bonus"
		);
		return new Map();
	}

	return bonusByPlayerId;
}
