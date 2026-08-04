import type { GraphQLContext } from "../../graphql/context";
import { env } from "../../infra/env";
import { getCurrentSeason } from "../../infra/season";
import { metrics } from "../../infra/metrics";
import { isLiveSnapshotDatabaseFallback, loadLiveSnapshotMeta } from "./snapshot-meta";

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
	if (isLiveSnapshotDatabaseFallback(context, eventId)) {
		return new Map();
	}

	const season = await getCurrentSeason(context);
	const hashKey = `${env.LIVE_POINTS_V2 ? "LiveBonusV2" : "LiveBonus"}:${season}:${eventId}`;
	let hashEntries: Record<string, string>;
	try {
		const [entries, meta] = await Promise.all([
			context.redis.hgetall(hashKey),
			loadLiveSnapshotMeta(context, eventId, { season }),
		]);
		hashEntries = entries;
		if (meta && Object.keys(hashEntries).length !== meta.bonusTeamCount) {
			context.logger.warn(
				{
					hashKey,
					revision: meta.revision,
					expectedCount: meta.bonusTeamCount,
					actualCount: Object.keys(hashEntries).length,
				},
				"Incomplete live bonus revision; preserving official aggregate bonus"
			);
			return new Map();
		}
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
	const teamByPlayerId = new Map<number, number>();
	let malformed = false;

	for (const [teamIdRaw, teamBonusRaw] of Object.entries(hashEntries)) {
		const teamId = /^\d+$/.test(teamIdRaw) ? Number(teamIdRaw) : Number.NaN;
		const teamBonus = parseTeamBonus(teamBonusRaw);
		if (!Number.isInteger(teamId) || teamId <= 0 || teamIdRaw !== String(teamId) || !teamBonus) {
			malformed = true;
			continue;
		}

		for (const [elementIdRaw, bonusRaw] of Object.entries(teamBonus)) {
			const elementId = /^\d+$/.test(elementIdRaw) ? Number(elementIdRaw) : Number.NaN;
			const bonus = parseBonusValue(bonusRaw);
			if (
				Number.isInteger(elementId) &&
				elementId > 0 &&
				elementIdRaw === String(elementId) &&
				bonus !== null &&
				bonus >= 0 &&
				!teamByPlayerId.has(elementId)
			) {
				bonusByPlayerId.set(elementId, bonus);
				teamByPlayerId.set(elementId, teamId);
			} else {
				malformed = true;
			}
		}
	}
	if (!malformed && teamByPlayerId.size > 0) {
		const playerIds = [...teamByPlayerId.keys()];
		try {
			const playerRows = await context.redis.hmget(`Player:${season}`, ...playerIds.map(String));
			for (const [index, elementId] of playerIds.entries()) {
				const raw = playerRows[index];
				if (!raw) {
					malformed = true;
					break;
				}
				const parsed = JSON.parse(raw) as unknown;
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					malformed = true;
					break;
				}
				const row = parsed as Record<string, unknown>;
				const playerTeamId = parseBonusValue(row.teamId ?? row.team_id);
				if (playerTeamId !== teamByPlayerId.get(elementId)) {
					malformed = true;
					break;
				}
			}
		} catch (error) {
			metrics.cacheRepositoryEvents.labels("live_bonus", "identity_unavailable").inc();
			context.logger.warn(
				{ err: error, hashKey },
				"Live bonus player identity unavailable; preserving official aggregate bonus"
			);
			return new Map();
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
