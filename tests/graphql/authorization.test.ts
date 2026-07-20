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

const supabase = {} as never;

const websitePrincipal: Principal = {
	userId: "user-1",
	source: "website",
	provider: "better_auth",
	fplEntryId: 123,
	fplEntryVerifiedAt: "2026-07-18T00:00:00.000Z",
};

const unverifiedWebsitePrincipal: Principal = {
	...websitePrincipal,
	fplEntryVerifiedAt: null,
};

const authorize = (
	query: string,
	variables?: Record<string, unknown>,
	principal?: Principal | null
) =>
	authorizeGraphQLRequest({
		body: { query, variables },
		searchParams: new URLSearchParams(),
		principal,
		supabase,
		logger,
	});

describe("authorizeGraphQLRequest", () => {
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
		const result = await authorize(`query { currentEventInfo { currentEvent } }`);

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

	it("allows own-entry fields for a matching bound entry", async () => {
		const result = await authorize(
			`query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { totalPoints } }`,
			{ entryId: 123 },
			websitePrincipal
		);

		expect(result.ok).toBe(true);
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

	it("rejects a matching entry when the binding is not verified", async () => {
		const result = await authorize(
			`query EntryHistory($entryId: Int!) { entryHistory(entryId: $entryId) { totalPoints } }`,
			{ entryId: 123 },
			unverifiedWebsitePrincipal
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(403);
			expect(result.code).toBe("FORBIDDEN");
		}
	});
});
