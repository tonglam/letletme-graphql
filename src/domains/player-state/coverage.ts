import type {
	PlayerStateAnalysisStatus,
	PlayerStateDataStatus,
	PlayerStateMappingStatus,
	PlayerStateProviderScope,
	PlayerStateSourceCoverage,
} from "./types";
import { isPlainRecord as isRecord } from "../../contracts/guards";

export const PLAYER_STATE_FRESHNESS_STALE_SECONDS = 36 * 60 * 60;

export type ProviderLinkRow = {
	status: string;
	rule_id: string;
	left_entity_id: string | null;
	evidence: unknown;
};

export const confirmedPlayerLinkSeasons = (evidence: unknown): string[] => {
	if (!isRecord(evidence) || !Array.isArray(evidence.confirmedSeasons)) return [];
	return evidence.confirmedSeasons.filter(
		(value): value is string => typeof value === "string" && /^\d{4}$/.test(value)
	);
};

export function resolvePlayerStateMappingStatus(
	link: ProviderLinkRow | null,
	season: string
): PlayerStateMappingStatus {
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

export const buildPlayerStateSourceCoverage = (input: {
	provider: PlayerStateSourceCoverage["provider"];
	scope: PlayerStateProviderScope;
	seasons: string[];
	revision: string | null;
	asOf: string | null;
	dataStatus: PlayerStateDataStatus;
	analysisStatus: PlayerStateAnalysisStatus;
	mappingStatus: PlayerStateMappingStatus;
	reasonCodes: string[];
}): PlayerStateSourceCoverage => {
	const age = freshness(input.asOf);
	return {
		provider: input.provider,
		scope: input.scope,
		seasons: input.seasons,
		revision: input.revision,
		asOf: input.asOf,
		dataStatus: input.dataStatus,
		analysisStatus: input.analysisStatus,
		mappingStatus: input.mappingStatus,
		reasonCodes: input.reasonCodes,
		freshnessSeconds: age,
		stale:
			input.dataStatus === "AVAILABLE" &&
			input.scope === "CURRENT" &&
			(age === null || age > PLAYER_STATE_FRESHNESS_STALE_SECONDS),
	};
};

export const sourceCoverage = (input: {
	provider: PlayerStateSourceCoverage["provider"];
	scope: PlayerStateSourceCoverage["scope"];
	seasons: string[];
	dataStatus: PlayerStateDataStatus;
	analysisStatus: PlayerStateAnalysisStatus;
	mappingStatus: PlayerStateMappingStatus;
	reasonCodes: string[];
	revision: string | null;
	asOf: string | null;
}): PlayerStateSourceCoverage => buildPlayerStateSourceCoverage(input);
