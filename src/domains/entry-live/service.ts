import type { GraphQLContext } from "../../graphql/context";
import { calcLivePointsByEntryV2, type LiveCalcDataV2 } from "./v2-service";

/**
 * Single-entry Live Points is the canonical V2 projection. It never reaches
 * Data, FPL or a materializer.
 */
export type EntryLive = LiveCalcDataV2;

export const entryLiveService = {
	getEntryLive(context: GraphQLContext, entryId: number, eventId: number): Promise<EntryLive> {
		return calcLivePointsByEntryV2(context, eventId, entryId);
	},
};
