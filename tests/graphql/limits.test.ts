import { describe, expect, it } from "bun:test";
import { getIntrospectionQuery } from "graphql";
import { validateGraphQLRequestLimits } from "../../src/graphql/limits";
import { schema } from "../../src/graphql/schema";

describe("GraphQL request limits", () => {
	it("accepts an ordinary query", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { events { id name } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 1, rootFields: ["events"] });
	});

	it("identifies a fixture-only read before resolver execution", () => {
		const result = validateGraphQLRequestLimits({
			query: "query CoreEventFixtureSchedule { eventFixtures(eventId: 1) { id } }",
		});
		expect(result).toMatchObject({ ok: true, rootFields: ["eventFixtures"] });
	});

	it("charges one bounded gameweek desk root instead of separate live roots", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { gameweekDesk(eventId: 1) { eventId dreamTeam { id } hauls { id } } }",
		});
		expect(result).toMatchObject({ ok: true, rootFields: ["gameweekDesk"], rateLimitCostUnits: 5 });
	});

	it("charges the compact Home public, market, and personal roots", () => {
		expect(
			validateGraphQLRequestLimits({ query: "query { homePersonalDesk { state } }" }, schema)
		).toMatchObject({ ok: true, rootFields: ["homePersonalDesk"], rateLimitCostUnits: 5 });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { homeGameweek(eventId: 1) { transfersState gameweekDesk { eventId } } }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["homeGameweek"], rateLimitCostUnits: 5 });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { homePublicBootstrap { context { revision } fixtures { id } } }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["homePublicBootstrap"], rateLimitCostUnits: 5 });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { homeMarketPulse { mostSelected { playerId } } }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["homeMarketPulse"], rateLimitCostUnits: 5 });
	});

	it("allows standard introspection where Apollo has enabled it", () => {
		const result = validateGraphQLRequestLimits({ query: getIntrospectionQuery() }, schema);
		expect(result).toMatchObject({
			ok: true,
			weightedComplexity: 1,
			rateLimitCostUnits: 1,
		});
	});

	it("charges weighted complexity in ten-point units", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { players(limit: 100) { id } }",
		});
		expect(result).toMatchObject({
			ok: true,
			weightedComplexity: 200,
			rateLimitCostUnits: 20,
		});
	});

	it("charges schema-defaulted list sizes when callers omit the argument", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: "query { players { id } }",
			},
			schema
		);
		expect(result).toMatchObject({
			ok: true,
			weightedComplexity: 100,
			rateLimitCostUnits: 10,
		});
	});

	it("charges effective list defaults when a caller supplies null", () => {
		for (const payload of [
			{ query: "query { players(limit: null) { id } }" },
			{
				query: "query Players($limit: Int) { players(limit: $limit) { id } }",
				variables: { limit: null },
			},
		]) {
			expect(validateGraphQLRequestLimits(payload, schema)).toMatchObject({
				ok: true,
				weightedComplexity: 100,
				rateLimitCostUnits: 10,
			});
		}
	});

	it("charges the repositories' 200-row list maximum", () => {
		expect(
			validateGraphQLRequestLimits({ query: "query { players(limit: 200) { id } }" }, schema)
		).toMatchObject({
			ok: true,
			weightedComplexity: 400,
			rateLimitCostUnits: 40,
		});
	});

	it("accepts the bounded player picker and rejects a roster-sized page", () => {
		const query = `
			query PlayerPicker($limit: Int!) {
				playersForPicker(search: "Gabriel", limit: $limit) {
					items { id webName position team { id name shortName } }
					nextCursor
					totalCount
				}
			}
		`;
		expect(validateGraphQLRequestLimits({ query, variables: { limit: 20 } }, schema)).toMatchObject(
			{
				ok: true,
				weightedComplexity: 220,
				rateLimitCostUnits: 5,
			}
		);
		expect(validateGraphQLRequestLimits({ query, variables: { limit: 100 } }, schema)).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL operation exceeds weighted complexity 600",
		});
	});

	it("keeps the fixed-size Market pulse below the public complexity guard", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query MarketPulse($days: Int = 14) {
						marketPulse(days: $days) {
							coverage {
								requestedDays observedDays firstDate latestDate capturedAt complete stale
							}
							mostSelected { ...MarketPlayerFields }
							ownershipMovers {
								risers { player { ...MarketPlayerFields } previousSelectedByPercent selectedByPercent change }
								fallers { player { ...MarketPlayerFields } previousSelectedByPercent selectedByPercent change }
							}
							transferMovers { player { ...MarketPlayerFields } transfersIn transfersOut netTransfers }
							availabilityUpdates {
								player { ...MarketPlayerFields }
								status previousStatus news newsAdded observedDate
								chanceOfPlayingThisRound chanceOfPlayingNextRound
							}
							availabilityHighlights {
								player { ...MarketPlayerFields }
								status previousStatus news newsAdded observedDate
								chanceOfPlayingThisRound chanceOfPlayingNextRound
							}
							newPlayers { player { ...MarketPlayerFields } firstObservedDate }
							priceChanges {
								player { ...MarketPlayerFields }
								changeDate oldPrice newPrice change direction
							}
						}
					}
					fragment MarketPlayerFields on MarketPlayer {
						playerId playerCode webName teamId teamName teamShortName position price selectedByPercent
					}
				`,
				variables: { days: 14 },
			},
			schema
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);
		expect(result.weightedComplexity).toBeLessThan(600);
	});

	it("sums heavy root floors, including aliases", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { first: liveMatchdayDesk { eventId } second: liveMatchdayDesk { eventId } entryLiveCompetitionsDesk(entryId: 1) { eventId } }",
		});
		expect(result).toMatchObject({ ok: true });
	});

	it("charges each unpaginated tournament participant lookup", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { first: tournamentParticipants(tournamentId: 1) { entryId } second: tournamentParticipants(tournamentId: 2) { entryId } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 60 });
	});

	it("charges tournament reporting roots for their database work", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { tournamentEntryRankingSummary(tournamentId: 1, eventId: 3, entryId: 7) { overallPoints } tournamentSeasonSnapshot(tournamentId: 1, eventId: 3) { asOfEventId } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 40 });
	});

	it("charges official H2H detail and Team Desk roots for their multi-read projections", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { tournamentOfficialH2H(tournamentId: 1, eventId: 3) { eventId } entryOfficialH2HDesk(entryId: 7) { tournamentId } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 60 });
	});

	it("charges every aliased liveScores full-event lookup", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { a: liveScores(eventId: 1) { totalPoints } b: liveScores(eventId: 1) { totalPoints } c: liveScores(eventId: 1) { totalPoints } d: liveScores(eventId: 1) { totalPoints } e: liveScores(eventId: 1) { totalPoints } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 25 });
	});

	it("rejects negative list limits from literals and variables", () => {
		for (const payload of [
			{ query: "query { eventLive(eventId: 1) { topPerformers(limit: -1) { totalPoints } } }" },
			{
				query:
					"query EventLive($limit: Int) { eventLive(eventId: 1) { topPerformers(limit: $limit) { totalPoints } } }",
				variables: { limit: -1 },
			},
		]) {
			expect(validateGraphQLRequestLimits(payload, schema)).toMatchObject({
				ok: false,
				code: "QUERY_TOO_COMPLEX",
				message: "GraphQL list limits must not be negative",
			});
		}
	});

	it("rejects more than five root fields", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { a: events { id } b: events { id } c: events { id } d: events { id } e: events { id } f: events { id } }",
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("rejects alias bombs", () => {
		const aliases = Array.from({ length: 21 }, (_, index) => `a${index}: id`).join(" ");
		const result = validateGraphQLRequestLimits({
			query: `query { events { ${aliases} } }`,
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("rejects weighted entry batches over 500", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query Batch($entryIds: [Int!]!) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { results { entry } } }",
			variables: { entryIds: Array.from({ length: 501 }, (_, index) => index + 1) },
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("accepts the documented 500-entry batch with a normal selection", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query Batch($entryIds: [Int!]!) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }",
			variables: { entryIds: Array.from({ length: 500 }, (_, index) => index + 1) },
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 500 });
	});

	it("accepts and charges the bounded fifteen-player live explain batch", () => {
		const result = validateGraphQLRequestLimits(
			{
				query:
					"query Batch($elementIds: [Int!]!) { eventLiveExplains(eventId: 1, elementIds: $elementIds) { elementId breakdown { fixtureId stats { identifier points } } } }",
				variables: { elementIds: Array.from({ length: 15 }, (_, index) => index + 1) },
			},
			schema
		);
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.message);
		expect(result.rateLimitCostUnits).toBeGreaterThanOrEqual(5);
	});

	it("rejects live explain batches over fifteen players before execution", () => {
		const result = validateGraphQLRequestLimits(
			{
				query:
					"query Batch($elementIds: [Int!]!) { eventLiveExplains(eventId: 1, elementIds: $elementIds) { elementId } }",
				variables: { elementIds: Array.from({ length: 16 }, (_, index) => index + 1) },
			},
			schema
		);
		expect(result).toMatchObject({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL elementIds batch exceeds 15 players",
		});
	});

	it("rejects duplicate entry IDs before execution", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query Batch($entryIds: [Int!]!) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }",
			variables: { entryIds: [7, 7] },
		});
		expect(result).toMatchObject({ ok: false, code: "DUPLICATE_ENTRY_IDS" });
	});

	it("applies variable defaults before enforcing the entry batch cap", () => {
		const ids = Array.from({ length: 501 }, (_, index) => index + 1).join(",");
		const result = validateGraphQLRequestLimits({
			query: `query Batch($entryIds: [Int!]! = [${ids}]) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }`,
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});
});
