import { createHash } from "node:crypto";
import type { GraphQLContext } from "../../graphql/context";
import { stableStringify } from "../../infra/stringify";
import { calcLivePointsForEntriesV2 } from "../entry-live/v2-service";

type LivePublicationState =
	| "PRE_DEADLINE"
	| "PICKS_WAIT"
	| "PICKS_PROBE"
	| "PICKS_SYNC"
	| "LIVE_ACTIVE"
	| "BETWEEN_FIXTURES"
	| "DAY_SETTLING"
	| "GW_REVIEW"
	| "FINALIZED";

const h2hState = (state: LivePublicationState): "scheduled" | "live" | "settled" => {
	if (state === "LIVE_ACTIVE" || state === "BETWEEN_FIXTURES") return "live";
	if (state === "DAY_SETTLING" || state === "GW_REVIEW" || state === "FINALIZED") return "settled";
	return "scheduled";
};
export type EventLiveH2HScoreBatch = {
	scores: ReadonlyMap<number, number>;
	inputRevisions: ReadonlyMap<number, string>;
	sourceCheckedAtByEntry: ReadonlyMap<number, string>;
	revision: string;
	sourceCheckedAt: string;
	state: "scheduled" | "live" | "settled";
	/** Shared source identity used when several bounded chunks form one round. */
	livePublicationId?: string | null;
	scoreCoreRevision?: string | null;
};

const loadEventLiveH2HScoreBatch = async (
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[]
): Promise<EventLiveH2HScoreBatch | null> => {
	if (entryIds.length === 0 || entryIds.length > 500) return null;
	// H2H is a consumer of the same V2 Redis publication. It must not call Data,
	// FPL, or a manager materializer from a request path.
	const result = await calcLivePointsForEntriesV2(context, eventId, [...entryIds]);
	if (result.errors.length > 0 || result.results.size !== entryIds.length) return null;

	const scores = new Map<number, number>();
	let livePublicationId: string | null = null;
	let scoreCoreRevision: string | null = null;
	let sourceCheckedAt: string | null = null;
	let state: EventLiveH2HScoreBatch["state"] | null = null;
	const inputRevisions = new Map<number, string>();
	const sourceCheckedAtByEntry = new Map<number, string>();
	for (const entryId of entryIds) {
		const row = result.results.get(entryId);
		const liveProvenance = row?.snapshot;
		if (
			!row ||
			row.availability !== "READY" ||
			(row.score.source !== "FPL_EVENT_LIVE" && row.score.source !== "FPL_FINAL_RESULT") ||
			typeof row.score.netEventPoints !== "number" ||
			!liveProvenance ||
			typeof row.score.revisions.input !== "string" ||
			row.score.revisions.input.trim().length === 0 ||
			typeof liveProvenance.revisions.publicationId !== "string" ||
			liveProvenance.revisions.publicationId.length === 0 ||
			typeof liveProvenance.revisions.scoreCore !== "string" ||
			liveProvenance.revisions.scoreCore.length === 0 ||
			typeof liveProvenance.times.sourceCheckedAt !== "string"
		) {
			return null;
		}
		if (
			(livePublicationId !== null &&
				livePublicationId !== liveProvenance.revisions.publicationId) ||
			(scoreCoreRevision !== null && scoreCoreRevision !== liveProvenance.revisions.scoreCore) ||
			(state !== null && state !== h2hState(liveProvenance.state as LivePublicationState))
		) {
			return null;
		}
		const normalizedLiveCheckedAt = liveProvenance.times.sourceCheckedAt;
		livePublicationId = liveProvenance.revisions.publicationId;
		scoreCoreRevision = liveProvenance.revisions.scoreCore;
		if (
			sourceCheckedAt === null ||
			Date.parse(normalizedLiveCheckedAt) < Date.parse(sourceCheckedAt)
		) {
			sourceCheckedAt = normalizedLiveCheckedAt;
		}
		state = h2hState(liveProvenance.state as LivePublicationState);
		scores.set(entryId, row.score.netEventPoints);
		inputRevisions.set(entryId, row.score.revisions.input);
		sourceCheckedAtByEntry.set(entryId, normalizedLiveCheckedAt);
	}
	if (!scoreCoreRevision || !sourceCheckedAt || !state) return null;
	const orderedInputRevisions = [...inputRevisions]
		.sort(([left], [right]) => left - right)
		.map(([entryId, revision]) => ({ entryId, revision }));
	const revisionHash = createHash("sha256")
		.update(
			stableStringify({
				eventId,
				livePublicationId,
				scoreCoreRevision,
				inputRevisions: orderedInputRevisions,
			}),
			"utf8"
		)
		.digest("hex")
		.slice(0, 24);
	return {
		scores,
		inputRevisions,
		sourceCheckedAtByEntry,
		revision: `event-live-h2h:${eventId}:${revisionHash}`,
		sourceCheckedAt,
		state,
		livePublicationId,
		scoreCoreRevision,
	};
};

export const chunkH2HEntryIds = (entryIds: readonly number[], size = 500): number[][] => {
	if (!Number.isSafeInteger(size) || size < 1 || size > 500) {
		throw new Error("H2H entry chunk size must be an integer between 1 and 500");
	}
	const chunks: number[][] = [];
	for (let index = 0; index < entryIds.length; index += size) {
		chunks.push([...entryIds.slice(index, index + size)]);
	}
	return chunks;
};

/** Load one coherent event-live source across all active tournaments. */
export const loadEventLiveH2HScoreBatches = async (
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[]
): Promise<EventLiveH2HScoreBatch | null> => {
	const uniqueEntryIds = [...new Set(entryIds)].sort((left, right) => left - right);
	if (uniqueEntryIds.length === 0) return null;
	const chunks = chunkH2HEntryIds(uniqueEntryIds);
	const batches: Array<EventLiveH2HScoreBatch | null> = new Array<EventLiveH2HScoreBatch | null>(
		chunks.length
	).fill(null);
	let nextChunk = 0;
	const worker = async (): Promise<void> => {
		while (nextChunk < chunks.length) {
			const chunkIndex = nextChunk;
			nextChunk += 1;
			const chunk = chunks[chunkIndex]!;
			batches[chunkIndex] = await loadEventLiveH2HScoreBatch(context, eventId, chunk).catch(
				(error) => {
					context.logger.warn(
						{ eventId, chunkIndex, chunkSize: chunk.length, err: error },
						"Event-live H2H score chunk unavailable"
					);
					return null;
				}
			);
		}
	};
	await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, () => worker()));
	if (batches.some((batch) => batch === null)) return null;
	const completeBatches = batches as EventLiveH2HScoreBatch[];
	const first = completeBatches[0];
	if (!first) return null;
	for (const batch of completeBatches.slice(1)) {
		if (
			batch.state !== first.state ||
			batch.livePublicationId !== first.livePublicationId ||
			batch.scoreCoreRevision !== first.scoreCoreRevision
		) {
			context.logger.warn(
				{
					eventId,
					expectedScoreCoreRevision: first.scoreCoreRevision,
					observedScoreCoreRevision: batch.scoreCoreRevision,
				},
				"Event-live H2H score chunks observed mixed publication metadata"
			);
			return null;
		}
	}
	const scores = new Map<number, number>();
	const inputRevisions = new Map<number, string>();
	const sourceCheckedAtByEntry = new Map<number, string>();
	for (const batch of completeBatches) {
		for (const [entryId, score] of batch.scores) scores.set(entryId, score);
		for (const [entryId, revision] of batch.inputRevisions) {
			inputRevisions.set(entryId, revision);
		}
		for (const [entryId, sourceCheckedAt] of batch.sourceCheckedAtByEntry) {
			sourceCheckedAtByEntry.set(entryId, sourceCheckedAt);
		}
	}
	const sourceCheckedAt = completeBatches
		.map((batch) => batch.sourceCheckedAt)
		.sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
	const revisionHash = createHash("sha256")
		.update(
			stableStringify({
				eventId,
				livePublicationId: first.livePublicationId,
				scoreCoreRevision: first.scoreCoreRevision,
				chunks: completeBatches.map((batch) => batch.revision),
			})
		)
		.digest("hex")
		.slice(0, 24);
	return {
		scores,
		inputRevisions,
		sourceCheckedAtByEntry,
		revision: `event-live-h2h:${eventId}:${revisionHash}`,
		sourceCheckedAt,
		state: first.state,
		livePublicationId: first.livePublicationId,
		scoreCoreRevision: first.scoreCoreRevision,
	};
};
