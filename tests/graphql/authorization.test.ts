import { describe, expect, it } from "bun:test";
import {
	authorizeGraphQLRequest,
	isGraphQLRootFieldClassified,
} from "../../src/graphql/authorization";
import { schema } from "../../src/graphql/schema";
import type { Principal } from "../../src/infra/principal";

const logger = {
	warn: (): void => {},
} as never;

const data = {
	read: (table: string) => {
		const filters = new Map<string, unknown>();
		const chain = {
			select: () => chain,
			eq: (column: string, value: unknown) => {
				filters.set(column, value);
				return chain;
			},
			limit: async () => {
				if (
					table === "competition.tournament_entries" &&
					filters.get("tournament_id") === 7 &&
					filters.get("entry_id") === 123
				) {
					return { data: [{ entry_id: 123 }], error: null };
				}
				if (
					table === "competition.entry_leagues_with_tournament" &&
					filters.get("tournament_id") === 3 &&
					filters.get("entry_id") === 123
				) {
					return { data: [{ tournament_id: 3 }], error: null };
				}
				if (
					table === "competition.tournaments" &&
					(filters.get("id") === 7 || filters.get("id") === 8) &&
					filters.get("admin_entry_id") === 123
				) {
					return { data: [{ admin_entry_id: 123 }], error: null };
				}
				return { data: [], error: null };
			},
		};
		return chain;
	},
} as never;

const websitePrincipal: Principal = {
	userId: "user-1",
	source: "website",
	fplEntryId: 123,
	fplEntryVerifiedAt: "2026-07-18T00:00:00.000Z",
};

const unverifiedWebsitePrincipal: Principal = {
	...websitePrincipal,
	fplEntryVerifiedAt: null,
};

const miniViewerPrincipal: Principal = {
	userId: "mini-account-1",
	source: "wechat_miniprogram",
	viewerEntryId: 123,
	fplEntryId: null,
	fplEntryVerifiedAt: null,
};

const miniBoundDifferentViewerPrincipal: Principal = {
	...miniViewerPrincipal,
	fplEntryId: 456,
	fplEntryVerifiedAt: "2026-08-21T00:00:00.000Z",
};

const platformAdminPrincipal: Principal = {
	userId: "platform-admin",
	source: "website",
	fplEntryId: 6953,
	fplEntryVerifiedAt: "2026-08-21T00:00:00.000Z",
	platformAdmin: true,
};

const authorize = (
	query: string,
	variables?: Record<string, unknown>,
	principal?: Principal | null
) =>
	authorizeGraphQLRequest({
		body: { query, variables },
		principal,
		data,
		logger,
	});

describe("authorizeGraphQLRequest", () => {
	it("keeps the executable schema read-only", () => {
		expect(schema.getMutationType()).toBeUndefined();
	});

	it("classifies every field exposed by the executable schema", () => {
		const fields = [
			...Object.keys(schema.getQueryType()?.getFields() ?? {}),
			...Object.keys(schema.getMutationType()?.getFields() ?? {}),
		];
		expect(fields.filter((field) => !isGraphQLRootFieldClassified(field))).toEqual([]);
	});

	it("fails closed for a future root field without a policy", async () => {
		const result = await authorize(`query { futureSensitiveField }`, undefined, websitePrincipal);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(403);
			expect(result.code).toBe("FORBIDDEN");
		}
	});

	it("allows public root fields without a principal", async () => {
		const result = await authorize(`query { homeGameweek(eventId: 1) { transfersState } }`);

		expect(result.ok).toBe(true);
	});

	it("allows public entry name search without a principal", async () => {
		const result = await authorize(
			`query SearchEntries($query: String!) { searchEntries(query: $query) { id entryName playerName } }`,
			{ query: "Who" }
		);

		expect(result.ok).toBe(true);
	});

	it("allows the persisted public entry snapshot without a principal", async () => {
		const result = await authorize(
			`query EntrySnapshot($id: Int!) { entrySnapshot(id: $id) { id entryName playerName } }`,
			{ id: 123 }
		);

		expect(result.ok).toBe(true);
	});

	it("rejects protected root fields without a principal", async () => {
		const result = await authorize(
			`query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { totalPoints } }`,
			{ entryId: 123 }
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(401);
			expect(result.code).toBe("UNAUTHENTICATED");
		}
	});

	it("allows the Home personal desk for a selected Mini Program viewer", async () => {
		expect(await authorize(`query { homePersonalDesk { state } }`)).toMatchObject({
			ok: false,
			status: 401,
			code: "UNAUTHENTICATED",
		});
		expect(
			await authorize(`query { homePersonalDesk { state } }`, undefined, unverifiedWebsitePrincipal)
		).toMatchObject({ ok: false, status: 403, code: "VIEWER_ENTRY_REQUIRED" });
		expect(
			await authorize(`query { homePersonalDesk { state } }`, undefined, websitePrincipal)
		).toEqual({ ok: true });
		expect(
			await authorize(`query { homePersonalDesk { state } }`, undefined, miniViewerPrincipal)
		).toEqual({ ok: true });
	});

	it("derives My FPL Team identity from a verified Web or selected Mini viewer", async () => {
		for (const query of [
			`query { myFplTeamDesk { state } }`,
			`query { myFplTeamGameweek(eventId: 1) { state } }`,
			`query { myFplTeamTransfers { state } }`,
		]) {
			expect(await authorize(query)).toMatchObject({
				ok: false,
				status: 401,
				code: "UNAUTHENTICATED",
			});
			expect(await authorize(query, undefined, unverifiedWebsitePrincipal)).toMatchObject({
				ok: false,
				status: 403,
				code: "VIEWER_ENTRY_REQUIRED",
			});
			expect(await authorize(query, undefined, websitePrincipal)).toEqual({ ok: true });
			expect(await authorize(query, undefined, miniViewerPrincipal)).toEqual({ ok: true });
		}
	});

	it("allows the My FPL competitions desk without a selected tournament", async () => {
		for (const variables of [{}, { tournamentId: null }]) {
			const result = await authorize(
				`query Desk($tournamentId: Int) {
					myFplCompetitionsDesk(tournamentId: $tournamentId) { state }
				}`,
				variables,
				websitePrincipal
			);
			expect(result).toEqual({ ok: true });
		}
	});

	it("checks My FPL tournament membership before protected competition reads", async () => {
		for (const field of [
			"myFplCompetitionsDesk(tournamentId: $tournamentId)",
			"myFplCompetitionBoard(tournamentId: $tournamentId, eventId: 1)",
			"myFplCompetitionSeasonPath(tournamentId: $tournamentId, throughEventId: 1)",
			"myFplCompetitionSetupStatus(tournamentId: $tournamentId)",
		]) {
			const query = `query Read($tournamentId: Int!) { ${field} { __typename } }`;
			expect(await authorize(query, { tournamentId: 7 }, websitePrincipal)).toEqual({
				ok: true,
			});
			expect(await authorize(query, { tournamentId: 7 }, miniViewerPrincipal)).toEqual({
				ok: true,
			});
			expect(await authorize(query, { tournamentId: 9 }, websitePrincipal)).toMatchObject({
				ok: false,
				status: 403,
				code: "FORBIDDEN",
			});
		}
	});

	it("reuses a freshly proven tournament membership across protected roots", async () => {
		let membershipReads = 0;
		const countedData = {
			read: () => {
				const chain = {
					select: () => chain,
					eq: () => chain,
					limit: async () => {
						membershipReads += 1;
						return { data: [{ entry_id: 123 }], error: null };
					},
				};
				return chain;
			},
		} as never;
		const authorizedTournamentMemberships = new Set<number>();
		const result = await authorizeGraphQLRequest({
			body: {
				query: `query Read($tournamentId: Int!) {
					myFplCompetitionBoard(tournamentId: $tournamentId, eventId: 1) { state }
					myFplCompetitionSeasonPath(tournamentId: $tournamentId, throughEventId: 1) { state }
				}`,
				variables: { tournamentId: 7 },
			},
			principal: websitePrincipal,
			data: countedData,
			logger,
			authorizedTournamentMemberships,
		});
		expect(result).toEqual({ ok: true });
		expect(membershipReads).toBe(1);
		expect(authorizedTournamentMemberships.has(7)).toBe(true);
	});

	it("allows own-entry fields for a matching bound entry", async () => {
		const result = await authorize(
			`query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { totalPoints } }`,
			{ entryId: 123 },
			websitePrincipal
		);

		expect(result.ok).toBe(true);
		expect(
			await authorize(
				`query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { totalPoints } }`,
				{ entryId: 123 },
				miniViewerPrincipal
			)
		).toEqual({ ok: true });
		expect(
			await authorize(
				`query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { totalPoints } }`,
				{ entryId: 456 },
				miniViewerPrincipal
			)
		).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
	});

	it("allows public calcLivePointsByEntry pages without a principal", async () => {
		const result = await authorize(
			`query Calc($eventId: Int!, $entryId: Int!) {
        calcLivePointsByEntry(eventId: $eventId, entryId: $entryId) { entry }
      }`,
			{ eventId: 1, entryId: 123 }
		);

		expect(result.ok).toBe(true);
	});

	it("allows calcLivePointsByEntry for a matching bound entry", async () => {
		const result = await authorize(
			`query Calc($eventId: Int!, $entryId: Int!) {
        calcLivePointsByEntry(eventId: $eventId, entryId: $entryId) { entry }
      }`,
			{ eventId: 1, entryId: 123 },
			websitePrincipal
		);

		expect(result.ok).toBe(true);
	});

	it("requires a selected viewer entry before reading an entry-scoped root", async () => {
		const result = await authorize(
			`query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { totalPoints } }`,
			{ entryId: 123 },
			unverifiedWebsitePrincipal
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(403);
			expect(result.code).toBe("VIEWER_ENTRY_REQUIRED");
		}
	});

	it("allows the direct tournament shell for a verified member", async () => {
		const result = await authorize(
			`query Shell($tournamentId: Int!, $entryId: Int!) {
				tournament(tournamentId: $tournamentId, entryId: $entryId) { id }
			}`,
			{ tournamentId: 7, entryId: 123 },
			websitePrincipal
		);
		expect(result.ok).toBe(true);
	});

	it("allows a tracked official-league member who is absent from the frozen roster", async () => {
		const result = await authorize(
			`query Shell($tournamentId: Int!, $entryId: Int!) {
				tournament(tournamentId: $tournamentId, entryId: $entryId) { id }
			}`,
			{ tournamentId: 3, entryId: 123 },
			websitePrincipal
		);
		expect(result).toEqual({ ok: true });
	});

	it("allows a retained administrator to manage after leaving the roster", async () => {
		const result = await authorize(
			`query Managed($tournamentId: Int!, $entryId: Int!) {
				managedTournament(tournamentId: $tournamentId, entryId: $entryId) { id }
			}`,
			{ tournamentId: 7, entryId: 123 },
			websitePrincipal
		);
		expect(result.ok).toBe(true);
	});

	it("allows a retained administrator to inspect participants after leaving the roster", async () => {
		const result = await authorize(
			`query Participants($tournamentId: Int!) {
				tournamentParticipants(tournamentId: $tournamentId) { entryId }
			}`,
			{ tournamentId: 8 },
			websitePrincipal
		);
		expect(result.ok).toBe(true);
	});

	it("requires manageable tournament listings to use the verified FPL identity", async () => {
		const query = `query Managed($entryId: Int!) {
			manageableTournaments(entryId: $entryId) { id }
		}`;
		expect(await authorize(query, { entryId: 123 }, websitePrincipal)).toEqual({ ok: true });
		expect(
			await authorize(query, { entryId: 123 }, miniBoundDifferentViewerPrincipal)
		).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
		expect(await authorize(query, { entryId: 6953 }, platformAdminPrincipal)).toEqual({ ok: true });
	});

	it("rejects participant inspection by a non-member who is not the retained administrator", async () => {
		const result = await authorize(
			`query Participants($tournamentId: Int!) {
				tournamentParticipants(tournamentId: $tournamentId) { entryId }
			}`,
			{ tournamentId: 9 },
			websitePrincipal
		);
		expect(result).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
	});

	it("allows a verified platform administrator across tournament and league gates", async () => {
		for (const [query, variables] of [
			[
				`query Participants($tournamentId: Int!) {
					tournamentParticipants(tournamentId: $tournamentId) { entryId }
				}`,
				{ tournamentId: 9 },
			],
			[
				`query Managed($tournamentId: Int!, $entryId: Int!) {
					managedTournament(tournamentId: $tournamentId, entryId: $entryId) { id }
				}`,
				{ tournamentId: 9, entryId: 6953 },
			],
			[
				`query League($leagueId: Int!, $eventId: Int!) {
					leagueEventResults(leagueId: $leagueId, eventId: $eventId) { entryId }
				}`,
				{ leagueId: 999, eventId: 1 },
			],
		] as const) {
			expect(await authorize(query, variables, platformAdminPrincipal)).toEqual({ ok: true });
		}
	});

	it("does not let a platform administrator impersonate another FPL entry", async () => {
		for (const field of ["managedTournament", "managedTournamentStatus"]) {
			const result = await authorize(
				`query Managed($tournamentId: Int!, $entryId: Int!) {
					${field}(tournamentId: $tournamentId, entryId: $entryId) { __typename }
				}`,
				{ tournamentId: 9, entryId: 123 },
				platformAdminPrincipal
			);
			expect(result).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
		}
	});

	it("rejects managed tournament impersonation", async () => {
		const result = await authorize(
			`query Managed($tournamentId: Int!, $entryId: Int!) {
				managedTournament(tournamentId: $tournamentId, entryId: $entryId) { id }
			}`,
			{ tournamentId: 7, entryId: 999 },
			websitePrincipal
		);
		expect(result.ok).toBe(false);
	});
});
