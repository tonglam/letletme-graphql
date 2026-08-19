import type { Entry } from "../domains/entries/repository";

const FPL_ENTRY_URL = "https://fantasy.premierleague.com/api/entry";
const FPL_ENTRY_TIMEOUT_MS = 4_000;
const FPL_USER_AGENT = "letletme-graphql/1.0.0 (+https://github.com/tonglam/letletme-graphql)";

type FplEntrySummary = {
	id: number;
	name: string;
	player_first_name: string;
	player_last_name: string;
	player_region_name?: string | null;
	started_event?: number | null;
	summary_overall_points?: number | null;
	summary_overall_rank?: number | null;
	bank?: number | null;
	value?: number | null;
	last_deadline_bank?: number | null;
	last_deadline_value?: number | null;
	last_deadline_total_transfers?: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asFiniteNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const asOptionalString = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

const parseFplEntrySummary = (value: unknown, entryId: number): FplEntrySummary | null => {
	if (!isRecord(value)) return null;
	const id = asFiniteNumber(value.id);
	const name = asOptionalString(value.name);
	const firstName = asOptionalString(value.player_first_name);
	const lastName = asOptionalString(value.player_last_name);
	if (id !== entryId || !name || firstName === null || lastName === null) {
		return null;
	}
	return {
		id,
		name,
		player_first_name: firstName,
		player_last_name: lastName,
		player_region_name: asOptionalString(value.player_region_name),
		started_event: asFiniteNumber(value.started_event),
		summary_overall_points: asFiniteNumber(value.summary_overall_points),
		summary_overall_rank: asFiniteNumber(value.summary_overall_rank),
		bank: asFiniteNumber(value.bank),
		value: asFiniteNumber(value.value),
		last_deadline_bank: asFiniteNumber(value.last_deadline_bank),
		last_deadline_value: asFiniteNumber(value.last_deadline_value),
		last_deadline_total_transfers: asFiniteNumber(value.last_deadline_total_transfers),
	};
};

export const mapFplEntrySummaryToEntry = (summary: FplEntrySummary): Entry => ({
	id: summary.id,
	entryName: summary.name,
	playerName: `${summary.player_first_name} ${summary.player_last_name}`.trim(),
	region: summary.player_region_name ?? null,
	startedEvent: summary.started_event ?? null,
	overallPoints: summary.summary_overall_points ?? null,
	overallRank: summary.summary_overall_rank ?? null,
	bank: summary.last_deadline_bank ?? summary.bank ?? null,
	teamValue: summary.last_deadline_value ?? summary.value ?? null,
	totalTransfers: summary.last_deadline_total_transfers ?? null,
	lastEventId: null,
	lastOverallPoints: null,
	lastOverallRank: null,
	lastTeamValue: null,
	lastBank: null,
});

export async function lookupFplEntry(entryId: number): Promise<Entry | null> {
	if (!Number.isSafeInteger(entryId) || entryId <= 0) {
		return null;
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FPL_ENTRY_TIMEOUT_MS);
	try {
		const response = await fetch(`${FPL_ENTRY_URL}/${entryId}/`, {
			method: "GET",
			headers: { Accept: "application/json", "User-Agent": FPL_USER_AGENT },
			signal: controller.signal,
		});
		if (!response.ok) {
			return null;
		}
		const parsed = parseFplEntrySummary(await response.json(), entryId);
		return parsed ? mapFplEntrySummaryToEntry(parsed) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}
