import { createHash } from "node:crypto";
import type { GraphQLContext } from "../../graphql/context";
import { getCoreDataSnapshot } from "../../infra/data-snapshot";
import { stableStringify } from "../../infra/stringify";
import { entryLiveBatchService } from "../entry-live/batch-service";
import { isTraceableOfficialManagerScore } from "../entry-live/manager-score";

const normalizeLiveCheckedAt = (value: string | Date | null | undefined): string | null => {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export type EventLiveH2HScoreBatch = {
	scores: ReadonlyMap<number, number>;
	managerRevisions: ReadonlyMap<number, string>;
	checkedAtByEntry: ReadonlyMap<number, string>;
	revision: string;
	checkedAt: string;
	state: "scheduled" | "live" | "settled";
	/** Shared source identity used when several bounded chunks form one round. */
	livePublicationId?: string | null;
	snapshotRevision?: string | null;
};

const loadEventLiveH2HScoreBatch = async (
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[]
): Promise<EventLiveH2HScoreBatch | null> => {
	if (entryIds.length === 0 || entryIds.length > 500) return null;
	// H2H overlay reads are cache-only: pin the Core publication before
	// scoring, and never trigger per-entry provider fetches from this path.
	if (!context.dataRevision) await getCoreDataSnapshot(context);
	const result = await entryLiveBatchService.calcLivePointsForEntries(
		context,
		eventId,
		[...entryIds],
		{ managerReadMode: "CACHE_ONLY" }
	);
	if (result.errors.length > 0 || result.results.size !== entryIds.length) return null;

	const scores = new Map<number, number>();
	let livePublicationId: string | null = null;
	let snapshotRevision: string | null = null;
	let checkedAt: string | null = null;
	let state: EventLiveH2HScoreBatch["state"] | null = null;
	const managerRevisions = new Map<number, string>();
	const checkedAtByEntry = new Map<number, string>();
	for (const entryId of entryIds) {
		const row = result.results.get(entryId);
		const liveProvenance = row?.score.provenance;
		if (
			!row ||
			!isTraceableOfficialManagerScore(row.score) ||
			row.score.source !== "FPL_EVENT_LIVE" ||
			typeof row.score.netEventPoints !== "number" ||
			typeof row.score.revision !== "string" ||
			row.score.revision.trim().length === 0 ||
			!row.snapshot ||
			!liveProvenance ||
			liveProvenance.scoreSource !== "FPL_EVENT_LIVE" ||
			liveProvenance.livePublicationId === null ||
			liveProvenance.liveRevision === null ||
			liveProvenance.liveCheckedAt === null ||
			row.snapshot.revision !== liveProvenance.liveRevision ||
			row.snapshot.publicationId !== liveProvenance.livePublicationId
		) {
			return null;
		}
		if (
			(livePublicationId !== null && livePublicationId !== liveProvenance.livePublicationId) ||
			(snapshotRevision !== null && snapshotRevision !== liveProvenance.liveRevision) ||
			(state !== null && state !== row.snapshot.state)
		) {
			return null;
		}
		const normalizedLiveCheckedAt = normalizeLiveCheckedAt(liveProvenance.liveCheckedAt);
		if (normalizedLiveCheckedAt === null) return null;
		livePublicationId = liveProvenance.livePublicationId;
		snapshotRevision = liveProvenance.liveRevision;
		if (checkedAt === null || Date.parse(normalizedLiveCheckedAt) < Date.parse(checkedAt)) {
			checkedAt = normalizedLiveCheckedAt;
		}
		state = row.snapshot.state;
		scores.set(entryId, row.score.netEventPoints);
		managerRevisions.set(entryId, row.score.revision);
		checkedAtByEntry.set(entryId, normalizedLiveCheckedAt);
	}
	if (!snapshotRevision || !checkedAt || !state) return null;
	const orderedManagerRevisions = [...managerRevisions]
		.sort(([left], [right]) => left - right)
		.map(([entryId, revision]) => ({ entryId, revision }));
	const revisionHash = createHash("sha256")
		.update(
			stableStringify({
				eventId,
				livePublicationId,
				snapshotRevision,
				managerRevisions: orderedManagerRevisions,
			}),
			"utf8"
		)
		.digest("hex")
		.slice(0, 24);
	return {
		scores,
		managerRevisions,
		checkedAtByEntry,
		revision: `event-live-h2h:${eventId}:${revisionHash}`,
		checkedAt,
		state,
		livePublicationId,
		snapshotRevision,
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
			batch.snapshotRevision !== first.snapshotRevision
		) {
			context.logger.warn(
				{
					eventId,
					expectedRevision: first.snapshotRevision,
					observedRevision: batch.snapshotRevision,
				},
				"Event-live H2H score chunks observed mixed publication metadata"
			);
			return null;
		}
	}
	const scores = new Map<number, number>();
	const managerRevisions = new Map<number, string>();
	const checkedAtByEntry = new Map<number, string>();
	for (const batch of completeBatches) {
		for (const [entryId, score] of batch.scores) scores.set(entryId, score);
		for (const [entryId, revision] of batch.managerRevisions) {
			managerRevisions.set(entryId, revision);
		}
		for (const [entryId, checkedAt] of batch.checkedAtByEntry) {
			checkedAtByEntry.set(entryId, checkedAt);
		}
	}
	const checkedAt = completeBatches
		.map((batch) => batch.checkedAt)
		.sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
	const revisionHash = createHash("sha256")
		.update(
			stableStringify({
				eventId,
				livePublicationId: first.livePublicationId,
				snapshotRevision: first.snapshotRevision,
				chunks: completeBatches.map((batch) => batch.revision),
			})
		)
		.digest("hex")
		.slice(0, 24);
	return {
		scores,
		managerRevisions,
		checkedAtByEntry,
		revision: `event-live-h2h:${eventId}:${revisionHash}`,
		checkedAt,
		state: first.state,
		livePublicationId: first.livePublicationId,
		snapshotRevision: first.snapshotRevision,
	};
};
