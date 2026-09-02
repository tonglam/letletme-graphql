import { GraphQLError } from "graphql";

import type { GraphQLContext } from "../../graphql/context";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import { GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID } from "../../contracts/data-fixture-identities";
import {
	hasPlatformAdminAccess,
	hasVerifiedEntry,
	viewerEntryIdForPrincipal,
} from "../../graphql/authorization";

type AccessRow = {
	member: boolean;
	admin_entry_id: number | null;
};

/**
 * This is a cold/membership-change fallback only.  A warm live request is
 * authorized from the V2 publication roster before reaching this query, so a
 * Data API outage cannot turn an already-published board into a 403.
 */
const LIVE_TOURNAMENT_ACCESS_SQL = `
	SELECT
		tournament.admin_entry_id,
		(
			EXISTS (
				SELECT 1
				FROM competition.tournament_entries membership
				WHERE membership.season_id = $1
					AND membership.tournament_id = tournament.tournament_id
					AND membership.entry_id = $3
			) OR EXISTS (
				SELECT 1
				FROM competition.entry_leagues tracked
				JOIN LATERAL (
					SELECT candidate.tournament_id
					FROM competition.tournaments candidate
					WHERE candidate.season_id = tracked.season_id
						AND candidate.league_id = tracked.league_id
						AND candidate.league_type = tracked.league_type
					ORDER BY candidate.tournament_id
					LIMIT 1
				) tracked_tournament ON TRUE
				WHERE tracked.season_id = $1
					AND tracked_tournament.tournament_id = tournament.tournament_id
					AND tracked.entry_id = $3
			)
		) AS member
	FROM competition.tournaments tournament
	WHERE tournament.season_id = $1
		AND tournament.tournament_id = $2
	LIMIT 1
`;

/** Planner and reader-role contract for the cold tournament access fallback. */
export const LIVE_TOURNAMENT_ACCESS_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "live-tournament-access-v2.cold-fallback",
		sql: LIVE_TOURNAMENT_ACCESS_SQL,
		values: [2026, GRAPHQL_DATA_CONTRACT_TOURNAMENT_ID, 1],
		runtime: "must-return-row",
	},
];

const forbidden = (): GraphQLError =>
	new GraphQLError("Tournament access denied", { extensions: { code: "FORBIDDEN" } });

const unavailable = (): GraphQLError =>
	new GraphQLError("Live tournament authorization is temporarily unavailable", {
		extensions: { code: "LIVE_LEAGUE_ACCESS_UNAVAILABLE" },
	});

/**
 * `publicationMembership` is true/false when the immutable live publication
 * carried a complete roster.  It is null when no complete publication exists
 * yet, in which case the direct read is required to distinguish a legitimate
 * MISSING state from an unauthorized request.
 */
export const assertLiveTournamentAccessV2 = async (
	context: GraphQLContext,
	tournamentId: number,
	entryId: number,
	publicationMembership: boolean | null
): Promise<void> => {
	const principal = context.principal;
	const viewerEntryId = principal ? viewerEntryIdForPrincipal(principal) : null;
	if (!principal || !viewerEntryId || viewerEntryId !== entryId) throw forbidden();
	if (hasPlatformAdminAccess(principal) || publicationMembership === true) return;

	const managedEntryId = hasVerifiedEntry(principal) ? principal.fplEntryId : null;
	try {
		const result = await context.database.query<AccessRow>(LIVE_TOURNAMENT_ACCESS_SQL, [
			context.currentSeason.seasonId,
			tournamentId,
			entryId,
		]);
		const row = result.rows[0];
		if (row?.member === true || (managedEntryId !== null && row?.admin_entry_id === managedEntryId))
			return;
	} catch (error) {
		context.logger.warn(
			{ err: error, tournamentId },
			"Live tournament authorization fallback unavailable"
		);
		throw unavailable();
	}
	throw forbidden();
};
