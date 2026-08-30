import type { GraphQLContext } from "../../graphql/context";
import {
	readLiveMatchday,
	type LiveMatchdayRead,
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

const detailFixtureMap = (
	detail: MatchDetailCandidate | null
): Map<number, MatchDetailCandidate["fixtures"][number]> =>
	new Map((detail?.fixtures ?? []).map((fixture) => [fixture.fixtureId, fixture]));

const detailState = (
	desk: MatchDeskCandidate,
	detail: MatchDetailCandidate | null,
	final: boolean
): "FRESH" | "STALE" | "DEGRADED" | "FINAL" | "PENDING" => {
	if (!detail)
		return desk.fixtures.some(
			(fixture) => fixture.started || fixture.finished || fixture.minutes > 0
		)
			? "DEGRADED"
			: "PENDING";
	if (final) return "FINAL";
	if (desk.publication.state === "FINALIZED" || detail.publication.finalized === true)
		return "DEGRADED";
	if (detail.servedFrom !== "REDIS_CURRENT" || isPast(detail.publication.staleAt))
		return "DEGRADED";
	return "FRESH";
};

const deliveryState = (
	desk: MatchDeskCandidate,
	detail: MatchDetailCandidate | null,
	final: boolean
): "FRESH" | "STALE" | "DEGRADED" | "FINAL" => {
	if (final) return "FINAL";
	if (desk.publication.state === "FINALIZED" || detail?.publication.finalized === true)
		return "DEGRADED";
	if (desk.servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	const detailRequired = desk.fixtures.some(
		(fixture) => fixture.started || fixture.finished || fixture.minutes > 0
	);
	if (
		detailRequired &&
		(!detail || detail.servedFrom !== "REDIS_CURRENT" || isPast(detail.publication.staleAt))
	)
		return "DEGRADED";
	if (isPast(desk.publication.staleAt)) return "STALE";
	if (detail && (detail.servedFrom !== "REDIS_CURRENT" || isPast(detail.publication.staleAt)))
		return "DEGRADED";
	return "FRESH";
};

const finalPublication = (read: LiveMatchdayRead): boolean =>
	read.desk?.publication.state === "FINALIZED" &&
	read.desk.publication.checkpointedAt !== null &&
	read.detail?.publication.finalized === true &&
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
	totalPoints: player.totalPoints,
	stats: player.stats,
});

const toMatches = (desk: MatchDeskCandidate, detail: MatchDetailCandidate | null) => {
	const details = detailFixtureMap(detail);
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
		players: (details.get(fixture.fixtureId)?.players ?? []).map(toPlayer),
	}));
};

const toUnavailable = (read: LiveMatchdayRead) => {
	const reasonCodes = ["DESK_UNAVAILABLE"];
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

const toResult = (read: LiveMatchdayRead) => {
	if (!read.desk) return toUnavailable(read);
	const final = finalPublication(read);
	const finalCheckpointPending =
		!final &&
		(read.desk.publication.state === "FINALIZED" || read.detail?.publication.finalized === true);
	const state = deliveryState(read.desk, read.detail, final);
	const detailDeliveryState = detailState(read.desk, read.detail, final);
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
	return {
		availability: "READY",
		delivery: {
			state,
			servedFrom: read.desk.servedFrom,
			reasonCodes: [...new Set(reasonCodes)],
		},
		snapshot: {
			season: read.season,
			eventId: read.eventId,
			nextEventId: null,
			state: read.desk.publication.state,
			revisions: toRevisionVector(read),
			times: toTimes(read),
			detailDelivery: {
				state: detailDeliveryState,
				servedFrom: read.detail?.servedFrom ?? null,
				reasonCodes: finalCheckpointPending
					? ["FINAL_CHECKPOINT_PENDING"]
					: read.detail
						? read.detail.servedFrom === "REDIS_CURRENT"
							? []
							: [servedFromReason(read.detail.servedFrom)]
						: [detailDeliveryState === "PENDING" ? "DETAIL_PENDING" : "DETAIL_UNAVAILABLE"],
			},
			matches: toMatches(read.desk, read.detail),
		},
	};
};

export const liveMatchesResolvers = {
	Query: {
		liveMatchday: async (
			_parent: unknown,
			args: { eventId?: number | null },
			context: GraphQLContext
		) => toResult(await readLiveMatchday(context, args.eventId ?? undefined)),
	},
};
