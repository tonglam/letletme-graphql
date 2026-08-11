import type { PlayerStateCoverage, PlayerStateProviderRevision } from "./types";

export const PLAYER_STATE_FRESHNESS_STALE_SECONDS = 36 * 60 * 60;

export type ProviderLinkRow = {
	status: string;
	rule_id: string;
	left_entity_id: string | null;
	evidence: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const confirmedPlayerLinkSeasons = (evidence: unknown): string[] => {
	if (!isRecord(evidence) || !Array.isArray(evidence.confirmedSeasons)) return [];
	return evidence.confirmedSeasons.filter(
		(value): value is string => typeof value === "string" && /^\d{4}$/.test(value)
	);
};

export function resolvePlayerStateMappingStatus(
	link: ProviderLinkRow | null,
	season: string
): PlayerStateCoverage["mappingStatus"] {
	if (!link) return "UNAVAILABLE";
	if (link.status === "quarantined") return "QUARANTINED";
	if (link.status === "ambiguous") return "AMBIGUOUS";
	if (
		(link.status === "auto_verified" || link.status === "manual_verified") &&
		link.left_entity_id !== null &&
		confirmedPlayerLinkSeasons(link.evidence).includes(season)
	) {
		return "VERIFIED";
	}
	return "UNVERIFIED";
}

const freshness = (timestamp: string | null): number | null =>
	timestamp === null ? null : Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));

export const buildPlayerStateProviderRevision = (input: {
	provider: PlayerStateProviderRevision["provider"];
	scope: PlayerStateProviderRevision["scope"];
	season: string;
	revision: string | null;
	asOf: string | null;
	available: boolean;
}): PlayerStateProviderRevision => {
	const age = freshness(input.asOf);
	return {
		...input,
		freshnessSeconds: age,
		stale:
			input.available &&
			input.scope === "CURRENT" &&
			(age === null || age > PLAYER_STATE_FRESHNESS_STALE_SECONDS),
	};
};
