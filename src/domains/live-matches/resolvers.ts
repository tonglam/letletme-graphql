import type { GraphQLResolveInfo } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import { parentSelectionRequestsField } from "../../graphql/selection-set";
import { playersService } from "../players/service";
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

type LiveMatchPlayerPriceMap = ReadonlyMap<number, number | null>;

const liveMatchPlayerIds = (read: LiveMatchdayRead): number[] => [
	...new Set(
		(read.detail?.fixtures ?? []).flatMap((fixture) =>
			fixture.players.map((player) => player.id).filter((id) => Number.isSafeInteger(id) && id > 0)
		)
	),
];

/**
 * Live Matches V2 owns scores and stats, while current price remains a Core
 * publication field. Enrich only when selected and fail soft if Core is not
 * available, so a price outage cannot take down the live match board.
 */
const loadPlayerPrices = async (
	context: GraphQLContext,
	read: LiveMatchdayRead
): Promise<LiveMatchPlayerPriceMap> => {
	const ids = liveMatchPlayerIds(read);
	if (ids.length === 0) return new Map();

	const prices = new Map<number, number | null>();
	const preload = context.playersByIdPreload;
	const missingIds: number[] = [];
	for (const id of ids) {
		const player = preload?.get(id);
		if (preload?.has(id)) {
			prices.set(id, player?.price ?? null);
		} else {
			missingIds.push(id);
		}
	}
	if (missingIds.length === 0) return prices;

	try {
		const players = await playersService.getPlayersByIds(context, missingIds);
		for (const id of missingIds) prices.set(id, null);
		for (const player of players) prices.set(player.id, player.price);
		const nextPreload = new Map(context.playersByIdPreload ?? []);
		for (const id of missingIds) if (!nextPreload.has(id)) nextPreload.set(id, null);
		for (const player of players) nextPreload.set(player.id, player);
		context.playersByIdPreload = nextPreload;
	} catch (error) {
		for (const id of missingIds) prices.set(id, null);
		context.logger.warn(
			{ err: error, eventId: read.desk?.publication.eventId, playerCount: missingIds.length },
			"Live Matches V2 player price enrichment unavailable"
		);
	}
	return prices;
};

const toPlayer = (
	player: MatchDetailCandidate["fixtures"][number]["players"][number],
	prices: LiveMatchPlayerPriceMap
) => ({
	id: player.id,
	webName: player.webName,
	position: positionName(player.position),
	teamId: player.teamId,
	price: prices.get(player.id) ?? null,
	totalPoints: player.totalPoints,
	stats: player.stats,
});

const toMatches = (
	desk: MatchDeskCandidate,
	detail: MatchDetailCandidate | null,
	prices: LiveMatchPlayerPriceMap
) => {
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
		players: (details.get(fixture.fixtureId)?.players ?? []).map((player) =>
			toPlayer(player, prices)
		),
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

const toResult = (read: LiveMatchdayRead, prices: LiveMatchPlayerPriceMap = new Map()) => {
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
				reasonCodes: finalCheckpointPending
					? ["FINAL_CHECKPOINT_PENDING"]
					: read.detail
						? read.detail.servedFrom === "REDIS_CURRENT"
							? []
							: [detailServedFromReason(read.detail.servedFrom)]
						: [detailDeliveryState === "PENDING" ? "DETAIL_PENDING" : "DETAIL_UNAVAILABLE"],
			},
			matches: toMatches(read.desk, read.detail, prices),
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
			const read = await readLiveMatchday(context, args.eventId ?? undefined);
			const prices = parentSelectionRequestsField(info, "price")
				? await loadPlayerPrices(context, read)
				: new Map<number, number | null>();
			return toResult(read, prices);
		},
	},
};
