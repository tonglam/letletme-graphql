import type { GraphQLContext } from "../../graphql/context";
import { getCurrentSeason } from "../../infra/season";

const parseBonusValue = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
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
	eventId: number,
): Promise<Map<number, number>> {
	if (!Number.isFinite(eventId) || eventId <= 0) {
		return new Map();
	}

	const season = await getCurrentSeason(context);
	const hashKey = `LiveBonus:${season}:${eventId}`;
	const hashEntries = await context.redis.hgetall(hashKey);
	const bonusByPlayerId = new Map<number, number>();

	for (const teamBonusRaw of Object.values(hashEntries)) {
		const teamBonus = parseTeamBonus(teamBonusRaw);
		if (!teamBonus) continue;

		for (const [elementIdRaw, bonusRaw] of Object.entries(teamBonus)) {
			const elementId = Number.parseInt(elementIdRaw, 10);
			const bonus = parseBonusValue(bonusRaw);
			if (Number.isInteger(elementId) && elementId > 0 && bonus !== null) {
				bonusByPlayerId.set(elementId, bonus);
			}
		}
	}

	return bonusByPlayerId;
}
