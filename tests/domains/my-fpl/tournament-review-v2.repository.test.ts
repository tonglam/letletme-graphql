import { describe, expect, it } from "bun:test";
import {
	MY_TOURNAMENT_REVIEW_PUBLICATION_SQL,
	MY_TOURNAMENT_REVIEW_SEASON_SQL,
	createMyTournamentReviewRepository,
	postgresJsonbContentHash,
} from "../../../src/domains/my-fpl/tournament-review-v2.repository";
import { buildSnapshotContext, TestRedis } from "../../helpers/data-publication";

const publicationRow = (overrides: Record<string, unknown> = {}) => {
	const payload = {
		schemaVersion: "my-tournament-review-v2",
		metricVersion: "descriptive-v1",
		format: "POINTS",
		points: {
			headline: "gross",
			grossPointsTotal: 100,
			grossPointsAverage: 50,
			netPointsTotal: 96,
			seasonGrossPointsTotal: 100,
			seasonGrossPointsAverage: 50,
			seasonNetPointsTotal: 96,
			rows: [
				{
					entryId: 6953,
					entryName: "Example XI",
					playerName: "Example Manager",
					applicable: true,
					groupId: 1,
					rank: 1,
					seasonGrossPoints: 100,
					seasonNetPoints: 96,
					grossPoints: 55,
					transferCost: 4,
					netPoints: 51,
				},
			],
		},
	};
	const row = {
		season_id: 2026,
		tournament_id: 6953,
		event_id: 4,
		revision: 8,
		format: "POINTS",
		schema_version: "my-tournament-review-v2",
		metric_version: "descriptive-v1",
		event_data_checked_at: "2026-08-20T00:00:00.000Z",
		source_min_checked_at: "2026-08-19T23:59:59.000Z",
		source_max_checked_at: "2026-08-20T00:00:02.000Z",
		expected_subject_count: 1,
		ready_subject_count: 1,
		not_applicable_subject_count: 0,
		row_count: 1,
		content_sha256: postgresJsonbContentHash(payload),
		published_at: "2026-08-20T00:00:03.000Z",
		payload,
		...overrides,
	};
	if (!("content_sha256" in overrides)) {
		row.content_sha256 = postgresJsonbContentHash(row.payload);
	}
	return row;
};

const h2hPublicationRow = () =>
	publicationRow({
		format: "H2H",
		expected_subject_count: 2,
		ready_subject_count: 1,
		not_applicable_subject_count: 1,
		row_count: 1,
		payload: {
			schemaVersion: "my-tournament-review-v2",
			metricVersion: "descriptive-v1",
			format: "H2H",
			h2h: {
				matches: [
					{
						matchId: "4-1",
						groupId: 1,
						home: {
							entryId: 6953,
							entryName: "Example XI",
							isAverage: false,
							netPoints: 42,
							matchPoints: 3,
							rank: 1,
						},
						away: null,
						isBye: true,
					},
				],
				standings: [
					{
						groupId: 1,
						entryId: 6953,
						entryName: "Example XI",
						rank: 1,
						played: 1,
						won: 1,
						drawn: 0,
						lost: 0,
						matchPoints: 3,
						pointsFor: 42,
						pointsAgainst: 0,
					},
				],
			},
		},
	});

const catalogRow = (overrides: Record<string, unknown> = {}) => ({
	tournament_id: 6953,
	name: "Example Tournament",
	creator: "Example Manager",
	league_id: 6953,
	league_type: "classic",
	total_team_num: 2,
	latest_finalized_event_id: 4,
	latest_available_event_id: 3,
	latest_revision: 8,
	latest_format: "POINTS",
	latest_state: "PENDING",
	published_at: "2026-08-20T00:00:03.000Z",
	...overrides,
});

describe("My Tournament Review V2 repository", () => {
	it("only reads a publication through its atomic head", () => {
		expect(MY_TOURNAMENT_REVIEW_PUBLICATION_SQL).toContain(
			"JOIN competition.tournament_review_heads head"
		);
		expect(MY_TOURNAMENT_REVIEW_PUBLICATION_SQL).toContain("head.revision = publication.revision");
		expect(MY_TOURNAMENT_REVIEW_PUBLICATION_SQL).toContain(
			"head.content_sha256 = publication.content_sha256"
		);
		expect(MY_TOURNAMENT_REVIEW_SEASON_SQL).toContain(
			"JOIN competition.tournament_review_heads head"
		);
	});

	it("surfaces the latest obligation state when a newer settled event is pending", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [catalogRow()] }),
		});
		const repository = createMyTournamentReviewRepository();
		const result = await repository.loadCatalog(context, "ACCESSIBLE");
		expect(result.tournaments[0]).toMatchObject({
			latestFinalizedEventId: 4,
			latestAvailableEventId: 3,
			state: "PENDING",
		});
	});

	it("fails closed when a catalog claims READY without a product-visible head", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					catalogRow({
						latest_available_event_id: null,
						latest_revision: null,
						latest_format: null,
						published_at: null,
						latest_state: "READY",
					}),
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(repository.loadCatalog(context, "ACCESSIBLE")).rejects.toMatchObject({
			extensions: { code: "DATA_INTEGRITY_ERROR" },
		});
	});

	it("keeps a pending obligation visible when its publication is not ready", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query).includes("FROM competition.tournament_review_publications")) {
					return { rows: [] };
				}
				return { rows: [{ state: "WAITING_SOURCE" }] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
		});
		expect(result).toMatchObject({
			state: "WAITING_SOURCE",
			scope: null,
			points: null,
			h2h: null,
			knockout: null,
		});
	});

	it("keeps Season pending while the latest finalized scope is being rebuilt", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query).includes("FROM competition.tournament_review_publications")) {
					return { rows: [] };
				}
				return { rows: [{ state: "PENDING" }] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		const result = await repository.loadSeasonReview(context, {
			tournamentId: 6953,
			throughEventId: 4,
		});
		expect(result).toMatchObject({
			state: "PENDING",
			latestEventId: null,
			finalizedEventIds: [],
		});
	});

	it("maps gross headline and keeps transfer cost/net separate", async () => {
		const redis = new TestRedis();
		const context = buildSnapshotContext(redis, {
			databaseQuery: async (query: unknown) => {
				if (String(query).includes("FROM competition.tournament_review_publications")) {
					return { rows: [publicationRow()] };
				}
				throw new Error(`unexpected query: ${String(query)}`);
			},
		});
		const repository = createMyTournamentReviewRepository();
		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 10,
		});
		expect(result.state).toBe("READY");
		expect(result.points).toMatchObject({
			headlineMetric: "gross",
			grossPointsTotal: 100,
			netPointsTotal: 96,
		});
		expect(result.points?.rows[0]).toMatchObject({
			grossPoints: 55,
			transferCost: 4,
			netPoints: 51,
		});
		expect(redis.setCalls[0]?.[2]).toBe("EX");
		expect(redis.setCalls[0]?.[3]).toBe(300);
	});

	it("fails closed when a publication violates its integrity metadata", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					publicationRow({
						ready_subject_count: 0,
						content_sha256: "A".repeat(64),
					}),
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when the source span starts after the event checkpoint", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					publicationRow({
						source_min_checked_at: "2026-08-20T00:00:01.000Z",
					}),
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when a publication uses an unsupported metric version", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [publicationRow({ metric_version: "legacy-v1" })],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when a points row has an invalid numeric field", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					publicationRow({
						payload: {
							...publicationRow().payload,
							points: {
								...((publicationRow().payload as Record<string, unknown>).points as Record<
									string,
									unknown
								>),
								rows: [
									{
										...((
											(
												(publicationRow().payload as Record<string, unknown>).points as Record<
													string,
													unknown
												>
											).rows as unknown[]
										)[0] as Record<string, unknown>),
										grossPoints: "not-a-number",
									},
								],
							},
						},
					}),
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when required points aggregates are absent", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		delete points.grossPointsTotal;
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [{ ...base, payload, content_sha256: postgresJsonbContentHash(payload) }],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("keeps later-starting H2H entries out of settled standings", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [h2hPublicationRow()] }),
		});
		const repository = createMyTournamentReviewRepository();
		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 10,
		});
		expect(result.h2h?.standings).toHaveLength(1);
		expect(result.scope).toMatchObject({
			expectedSubjectCount: 2,
			readySubjectCount: 1,
			notApplicableSubjectCount: 1,
		});
	});

	it("preserves an Average Team side and its settled score", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		matches[0] = {
			...matches[0],
			isBye: false,
			away: {
				entryId: null,
				entryName: "Average Team",
				isAverage: true,
				netPoints: 38,
				matchPoints: 0,
				rank: null,
			},
		};
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [{ ...base, payload, content_sha256: postgresJsonbContentHash(payload) }],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 10,
		});
		expect(result.h2h?.matches[0]?.away).toMatchObject({
			entryId: null,
			entryName: "Average Team",
			isAverage: true,
			netPoints: 38,
		});
	});

	it("paginates season payload rows without changing the finalized event window", async () => {
		const latestPayload = structuredClone(publicationRow().payload) as Record<string, unknown>;
		const latestPoints = latestPayload.points as Record<string, unknown>;
		const latestRows = latestPoints.rows as Array<Record<string, unknown>>;
		latestRows.push({
			...latestRows[0],
			entryId: 6954,
			entryName: "Second XI",
			playerName: "Second Manager",
			grossPoints: 45,
			transferCost: 2,
			netPoints: 43,
			seasonGrossPoints: 90,
			seasonNetPoints: 86,
		});
		latestPoints.grossPointsTotal = 190;
		latestPoints.grossPointsAverage = 95;
		latestPoints.netPointsTotal = 182;
		latestPoints.seasonGrossPointsTotal = 190;
		latestPoints.seasonGrossPointsAverage = 95;
		latestPoints.seasonNetPointsTotal = 182;
		const latest = publicationRow({
			event_id: 4,
			payload: latestPayload,
			row_count: 2,
			expected_subject_count: 2,
			ready_subject_count: 2,
			content_sha256: postgresJsonbContentHash(latestPayload),
		});
		const older = publicationRow({ event_id: 3, revision: 7 });
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query).includes("FROM competition.tournament_review_publications")) {
					return { rows: [latest, older] };
				}
				throw new Error(`unexpected query: ${String(query)}`);
			},
		});
		const repository = createMyTournamentReviewRepository();
		const result = await repository.loadSeasonReview(context, {
			tournamentId: 6953,
			throughEventId: 4,
			first: 1,
		});
		expect(result.finalizedEventIds).toEqual([3, 4]);
		expect(result.points?.rows).toHaveLength(1);
		expect(result.points?.hasNextPage).toBe(true);
		expect(result.points?.nextCursor).toBe("MQ");
	});
});
