import { Kind, type GraphQLResolveInfo, type SelectionSetNode, type ValueNode } from "graphql";

import type { GraphQLContext } from "../../graphql/context";
import { metrics } from "../../infra/metrics";
import {
	readLiveMatchday,
	type LiveMatchdayRead,
	type LiveMatchReadMode,
	type MatchDeskCandidate,
	type MatchDetailCandidate,
} from "./repository";

const positionName = (position: number): "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD" => {
	switch (position) {
		case 1:
			return "GOALKEEPER";
		case 2:
			return "DEFENDER";
		case 4:
			return "FORWARD";
		default:
			return "MIDFIELDER";
	}
};

const isPast = (value: string | null): boolean => value !== null && Date.parse(value) <= Date.now();

const latestTime = (...values: readonly (string | null)[]): string => {
	const valid = values.filter(
		(value): value is string => value !== null && Number.isFinite(Date.parse(value))
	);
	return (
		valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ??
		new Date(0).toISOString()
	);
};

const nextTime = (...values: readonly (string | null)[]): string | null => {
	const valid = values.filter(
		(value): value is string => value !== null && Number.isFinite(Date.parse(value))
	);
	return valid.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
};

const servedFromReason = (servedFrom: string): string => {
	switch (servedFrom) {
		case "REDIS_PREVIOUS":
			return "DESK_PREVIOUS";
		case "PROCESS_LKG":
			return "PROCESS_LKG";
		case "POSTGRES_CHECKPOINT":
			return "POSTGRES_CHECKPOINT";
		default:
			return "REDIS_CURRENT";
	}
};

const detailServedFromReason = (servedFrom: string): string => {
	switch (servedFrom) {
		case "REDIS_PREVIOUS":
			return "DETAIL_PREVIOUS";
		case "PROCESS_LKG":
			return "PROCESS_LKG";
		case "POSTGRES_CHECKPOINT":
			return "POSTGRES_CHECKPOINT";
		default:
			return "REDIS_CURRENT";
	}
};

const detailFixtureMap = (
	detail: MatchDetailCandidate | null
): Map<number, MatchDetailCandidate["fixtures"][number]> =>
	new Map((detail?.fixtures ?? []).map((fixture) => [fixture.fixtureId, fixture]));

export const deskHasStartedActivity = (desk: MatchDeskCandidate): boolean => {
	if (desk.payloadLoaded === false)
		return (desk.fixtureCoverage?.startedFixtureIds.length ?? 0) > 0;
	return desk.fixtures.some(
		(fixture) =>
			fixture.started || fixture.finished || fixture.finishedProvisional || fixture.minutes > 0
	);
};

const detailState = (
	desk: MatchDeskCandidate,
	detail: MatchDetailCandidate | null,
	final: boolean,
	mode: LiveMatchReadMode
): "FRESH" | "STALE" | "DEGRADED" | "FINAL" | "PENDING" => {
	if (!detail) return deskHasStartedActivity(desk) ? "DEGRADED" : "PENDING";
	if (final) return "FINAL";
	if (desk.publication.state === "FINALIZED" || detail.publication.finalized === true)
		return "DEGRADED";
	if (detail.servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	if (isPast(detail.publication.staleAt)) return "DEGRADED";
	// HEAD and DESK validate the detail manifest and compact item metadata. The
	// metadata is useful for revision observation, but it must never be
	// advertised as a complete player payload without a FULL body SHA check.
	if (mode !== "FULL" && detail.payloadLoaded === false)
		return deskHasStartedActivity(desk) ? "DEGRADED" : "PENDING";
	return "FRESH";
};

const deliveryState = (
	desk: MatchDeskCandidate,
	detail: MatchDetailCandidate | null,
	final: boolean,
	mode: LiveMatchReadMode
): "FRESH" | "STALE" | "DEGRADED" | "FINAL" => {
	if (final) return "FINAL";
	if (desk.publication.state === "FINALIZED" || detail?.publication.finalized === true)
		return "DEGRADED";
	if (desk.servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	const detailRequired = deskHasStartedActivity(desk);
	if (detailRequired && (!detail || detail.servedFrom !== "REDIS_CURRENT")) return "DEGRADED";
	if (isPast(desk.publication.staleAt)) return "STALE";
	if (detail && detail.servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	if (detail && isPast(detail.publication.staleAt))
		return mode === "FULL" || detailRequired ? "DEGRADED" : "STALE";
	if (detailRequired && detail?.payloadLoaded === false) return "DEGRADED";
	return "FRESH";
};

const finalPublication = (read: LiveMatchdayRead): boolean =>
	read.desk?.publication.state === "FINALIZED" &&
	read.desk.publication.checkpointedAt !== null &&
	read.detail?.publication.finalized === true &&
	read.detail.payloadLoaded !== false &&
	read.detail.publication.checkpointedAt !== null &&
	read.detail.publication.observedDeskGeneration === read.desk.publication.generation &&
	read.detail.publication.fixtureIdentityRevision ===
		read.desk.publication.revisions.fixtureIdentity.revision;

const toRevisionVector = (read: LiveMatchdayRead) => {
	const desk = read.desk;
	const detail = read.detail;
	return {
		deskPublicationId: desk?.publication.publicationId ?? "unavailable",
		deskGeneration: desk?.publication.generation ?? 0,
		lifecycle: desk?.publication.revisions.lifecycle.revision ?? "unavailable",
		fixtureIdentity: desk?.publication.revisions.fixtureIdentity.revision ?? "unavailable",
		scoreState: desk?.publication.revisions.scoreState.revision ?? "unavailable",
		detailPublicationId: detail?.publication.publicationId ?? null,
		detailGeneration: detail?.publication.generation ?? null,
		playerDetail: detail?.publication.detail.revision ?? null,
	};
};

const toTimes = (read: LiveMatchdayRead) => {
	const desk = read.desk?.publication ?? null;
	const detail = read.detail?.publication ?? null;
	return {
		deskSourceCheckedAt: desk?.sourceCheckedAt ?? new Date(0).toISOString(),
		deskContentUpdatedAt: desk
			? latestTime(
					desk.revisions.lifecycle.contentUpdatedAt,
					desk.revisions.fixtureIdentity.contentUpdatedAt,
					desk.revisions.scoreState.contentUpdatedAt
				)
			: new Date(0).toISOString(),
		deskPublishedAt: desk?.publishedAt ?? new Date(0).toISOString(),
		deskStaleAt: desk?.staleAt ?? null,
		detailSourceCheckedAt: detail?.sourceCheckedAt ?? null,
		detailContentUpdatedAt: detail?.detail.contentUpdatedAt ?? null,
		detailPublishedAt: detail?.publishedAt ?? null,
		detailStaleAt: detail?.staleAt ?? null,
		servedAt: new Date().toISOString(),
		nextRefreshAt: nextTime(desk?.expectedNextCheckAt ?? null, detail?.expectedNextCheckAt ?? null),
	};
};

const toPlayer = (player: MatchDetailCandidate["fixtures"][number]["players"][number]) => ({
	id: player.id,
	webName: player.webName,
	position: positionName(player.position),
	teamId: player.teamId,
	price: player.price,
	totalPoints: player.totalPoints,
	stats: player.stats,
});

const toMatches = (
	desk: MatchDeskCandidate,
	detail: MatchDetailCandidate | null,
	mode: LiveMatchReadMode
) => {
	if (mode === "HEAD") return [];
	const includePlayers = mode === "FULL";
	const details: Map<number, MatchDetailCandidate["fixtures"][number]> = includePlayers
		? detailFixtureMap(detail)
		: new Map<number, MatchDetailCandidate["fixtures"][number]>();
	return desk.fixtures.map((fixture) => ({
		fixtureId: fixture.fixtureId,
		eventId: fixture.eventId,
		homeTeamId: fixture.homeTeamId,
		homeTeamName: fixture.homeTeamName,
		homeTeamShortName: fixture.homeTeamShortName,
		awayTeamId: fixture.awayTeamId,
		awayTeamName: fixture.awayTeamName,
		awayTeamShortName: fixture.awayTeamShortName,
		homeScore: fixture.homeScore,
		awayScore: fixture.awayScore,
		kickoffTime: fixture.kickoffTime,
		minutes: fixture.minutes,
		started: fixture.started,
		finished: fixture.finished,
		finishedProvisional: fixture.finishedProvisional,
		players: includePlayers ? (details.get(fixture.fixtureId)?.players ?? []).map(toPlayer) : [],
	}));
};

const toUnavailable = (read: LiveMatchdayRead) => {
	const reasonCodes = read.invalidEventId
		? ["INVALID_EVENT_ID"]
		: read.eventId === null && !read.redisReadFailed && !read.postgresReadFailed
			? ["NO_ACTIVE_EVENT"]
			: ["DESK_UNAVAILABLE"];
	if (read.redisReadFailed) reasonCodes.push("REDIS_READ_FAILED");
	if (read.postgresReadFailed) reasonCodes.push("POSTGRES_CHECKPOINT_UNAVAILABLE");
	return {
		availability: "UNAVAILABLE",
		delivery: {
			state: "UNAVAILABLE",
			servedFrom: null,
			reasonCodes,
		},
		snapshot: null,
	};
};

const resolveBooleanValue = (
	value: ValueNode | undefined,
	variableValues: GraphQLResolveInfo["variableValues"]
): boolean | null => {
	if (!value) return null;
	if (value.kind === Kind.BOOLEAN) return value.value;
	if (value.kind !== Kind.VARIABLE) return null;
	const resolved = variableValues[value.name.value];
	return typeof resolved === "boolean" ? resolved : null;
};

const directiveExcludesSelection = (
	directives:
		| readonly {
				name: { value: string };
				arguments?: readonly { name: { value: string }; value: ValueNode }[];
		  }[]
		| undefined,
	variableValues: GraphQLResolveInfo["variableValues"]
): boolean =>
	(directives ?? []).some((directive) => {
		const condition = directive.arguments?.find((argument) => argument.name.value === "if")?.value;
		const resolved = resolveBooleanValue(condition, variableValues);
		if (resolved === null) return false;
		if (directive.name.value === "skip") return resolved;
		if (directive.name.value === "include") return !resolved;
		return false;
	});

/**
 * Determine the smallest safe publication read from the actual selection
 * tree. Operation names are client-controlled and aliases do not identify the
 * schema field, so this deliberately walks field names and fragments.
 */
export const liveMatchReadModeFromInfo = (info: GraphQLResolveInfo): LiveMatchReadMode => {
	let selectedMatches = false;
	let selectedPlayers = false;
	const visitedFragments = new Set<string>();

	const visit = (
		selectionSet: SelectionSetNode | undefined,
		stage: "root" | "snapshot" | "matches"
	): void => {
		if (!selectionSet) return;
		for (const selection of selectionSet.selections) {
			if (directiveExcludesSelection(selection.directives, info.variableValues)) continue;
			if (selection.kind === Kind.FRAGMENT_SPREAD) {
				const key = `${stage}:${selection.name.value}`;
				if (visitedFragments.has(key)) continue;
				visitedFragments.add(key);
				visit(info.fragments[selection.name.value]?.selectionSet, stage);
				continue;
			}
			if (selection.kind === Kind.INLINE_FRAGMENT) {
				visit(selection.selectionSet, stage);
				continue;
			}
			const fieldName = selection.name.value;
			if (stage === "root" && fieldName === "snapshot") {
				visit(selection.selectionSet, "snapshot");
			} else if (stage === "snapshot" && fieldName === "matches") {
				selectedMatches = true;
				visit(selection.selectionSet, "matches");
			} else if (stage === "matches" && fieldName === "players") {
				selectedPlayers = true;
			}
		}
	};

	for (const fieldNode of info.fieldNodes) visit(fieldNode.selectionSet, "root");
	if (selectedPlayers) return "FULL";
	if (selectedMatches) return "DESK";
	return "HEAD";
};

const liveMatchServedFrom = (read: LiveMatchdayRead): string =>
	read.desk?.servedFrom ?? "UNAVAILABLE";

const liveMatchRedisRoundtripOutcome = (read: LiveMatchdayRead): "none" | "single" | "fallback" => {
	if (read.redisRoundtrips === 0) return "none";
	return read.redisRoundtrips === 1 ? "single" : "fallback";
};

const observeLiveMatchRead = (
	mode: LiveMatchReadMode,
	read: LiveMatchdayRead,
	response: ReturnType<typeof toResult>,
	readDurationMs: number
): void => {
	const source = liveMatchServedFrom(read);
	metrics.liveMatchReadDurationSeconds.labels(mode, source).observe(readDurationMs / 1000);
	metrics.liveMatchRedisRoundtripsTotal.labels(mode, liveMatchRedisRoundtripOutcome(read)).inc();
	metrics.liveMatchDeliveryTotal
		.labels(mode, response.delivery.state, response.delivery.servedFrom ?? "UNAVAILABLE")
		.inc();
	if (read.desk && read.desk.servedFrom !== "REDIS_CURRENT") {
		metrics.liveMatchFallbackTotal.labels("desk", read.desk.servedFrom).inc();
	}
	if (read.detail && read.detail.servedFrom !== "REDIS_CURRENT") {
		metrics.liveMatchFallbackTotal.labels("detail", read.detail.servedFrom).inc();
	}
	// GraphQL serializes the response after the resolver returns. Avoid a second
	// full allocation on the hot FULL path; small metadata reads are measured
	// exactly, while full payloads are sampled for an operational estimate.
	if (mode !== "FULL" || Math.random() < 0.01) {
		const encodedResponse = JSON.stringify(response);
		metrics.liveMatchPayloadBytes
			.labels(mode, "resolver")
			.observe(Buffer.byteLength(encodedResponse, "utf8"));
	}
};

const toResult = (read: LiveMatchdayRead) => {
	if (!read.desk) return toUnavailable(read);
	const mode = read.readMode ?? "FULL";
	const final = finalPublication(read);
	const finalCheckpointPending =
		!final &&
		(read.desk.publication.state === "FINALIZED" || read.detail?.publication.finalized === true);
	const state = deliveryState(read.desk, read.detail, final, mode);
	const detailDeliveryState = detailState(read.desk, read.detail, final, mode);
	const reasonCodes = [servedFromReason(read.desk.servedFrom)];
	if (read.redisReadFailed) reasonCodes.push("REDIS_READ_FAILED");
	if (read.postgresReadFailed) reasonCodes.push("POSTGRES_CHECKPOINT_UNAVAILABLE");
	if (state === "STALE") reasonCodes.push("DESK_STALE");
	if (state === "DEGRADED") reasonCodes.push("DETAIL_OR_DESK_DEGRADED");
	if (finalCheckpointPending) reasonCodes.push("FINAL_CHECKPOINT_PENDING");
	if (read.detail && read.detail.servedFrom !== "REDIS_CURRENT")
		reasonCodes.push("DETAIL_FALLBACK");
	if (!read.detail)
		reasonCodes.push(detailDeliveryState === "PENDING" ? "DETAIL_PENDING" : "DETAIL_UNAVAILABLE");
	const detailReasonCodes = finalCheckpointPending
		? ["FINAL_CHECKPOINT_PENDING"]
		: read.detail
			? [
					...(read.detail.servedFrom === "REDIS_CURRENT"
						? []
						: [detailServedFromReason(read.detail.servedFrom)]),
					...(mode !== "FULL" &&
					read.detail.payloadLoaded === false &&
					detailDeliveryState === "DEGRADED"
						? ["DETAIL_METADATA_ONLY"]
						: []),
				].filter((reason): reason is string => reason !== undefined)
			: [detailDeliveryState === "PENDING" ? "DETAIL_PENDING" : "DETAIL_UNAVAILABLE"];
	return {
		availability: "READY",
		delivery: {
			state,
			servedFrom: read.desk.servedFrom,
			reasonCodes: [...new Set(reasonCodes)],
		},
		snapshot: {
			season: read.season,
			// A non-null snapshot is always anchored by a validated desk
			// publication; use that authority instead of the nullable lookup
			// hint carried by the repository result.
			eventId: read.desk.publication.eventId,
			state: read.desk.publication.state,
			revisions: toRevisionVector(read),
			times: toTimes(read),
			detailDelivery: {
				state: detailDeliveryState,
				servedFrom: read.detail?.servedFrom ?? null,
				reasonCodes: [...new Set(detailReasonCodes)],
			},
			matches: toMatches(read.desk, read.detail, mode),
		},
	};
};

export const liveMatchesResolvers = {
	Query: {
		liveMatchday: async (
			_parent: unknown,
			args: { eventId?: number | null },
			context: GraphQLContext,
			info: GraphQLResolveInfo
		) => {
			const mode = liveMatchReadModeFromInfo(info);
			const startedAt = performance.now();
			const read = await readLiveMatchday(context, args.eventId ?? undefined, mode);
			const response = toResult(read);
			observeLiveMatchRead(mode, read, response, performance.now() - startedAt);
			return response;
		},
	},
};
