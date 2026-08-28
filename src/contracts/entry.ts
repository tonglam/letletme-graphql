/**
 * Stable read-side Entry value object shared by infrastructure and domain
 * adapters. Keeping this contract below both layers prevents an FPL client
 * from importing a domain repository merely for its return type.
 */
export type Entry = {
	id: number;
	entryName: string;
	playerName: string;
	region: string | null;
	startedEvent: number | null;
	overallPoints: number | null;
	overallRank: number | null;
	bank: number | null;
	teamValue: number | null;
	totalTransfers: number | null;
	lastEventId: number | null;
	lastOverallPoints: number | null;
	lastOverallRank: number | null;
	lastTeamValue: number | null;
	lastBank: number | null;
};
