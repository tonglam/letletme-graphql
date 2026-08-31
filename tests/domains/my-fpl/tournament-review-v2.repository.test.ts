import { describe, expect, it } from "bun:test";
import {
	MY_TOURNAMENT_REVIEW_CATALOG_SQL,
	MY_TOURNAMENT_REVIEW_HEAD_SQL,
	MY_TOURNAMENT_REVIEW_PUBLICATION_SQL,
	MY_TOURNAMENT_REVIEW_SEASON_SQL,
	MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL,
	MY_TOURNAMENT_REVIEW_STATUS_SQL,
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
			grossPointsTotal: 55,
			grossPointsAverage: 55,
			netPointsTotal: 51,
			seasonGrossPointsTotal: 100,
			seasonGrossPointsAverage: 100,
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
		source_min_checked_at: "2026-08-20T00:00:01.000Z",
		source_max_checked_at: "2026-08-20T00:00:02.000Z",
		expected_subject_count: 1,
		ready_subject_count: 1,
		not_applicable_subject_count: 0,
		row_count: 1,
		content_sha256: postgresJsonbContentHash(payload),
		published_at: "2026-08-20T00:00:03.000Z",
		payload,
		obligation_state: "READY",
		active_revision: 8,
		...overrides,
	};
	// The Gameweek metadata query returns the same immutable head identity plus
	// its single-snapshot obligation state. Keeping these fields on the shared
	// fixture lets publication and metadata mocks exercise the exact same row.
	row.obligation_state ??= "READY";
	row.active_revision ??= row.revision;
	if (!("content_sha256" in overrides)) {
		row.content_sha256 = postgresJsonbContentHash(row.payload);
	}
	return row;
};

const h2hPublicationRow = (overrides: Record<string, unknown> = {}) =>
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
		...overrides,
	});

const knockoutPublicationRow = (overrides: Record<string, unknown> = {}) =>
	publicationRow({
		format: "KNOCKOUT",
		expected_subject_count: 2,
		ready_subject_count: 2,
		not_applicable_subject_count: 0,
		row_count: 1,
		payload: {
			schemaVersion: "my-tournament-review-v2",
			metricVersion: "descriptive-v1",
			format: "KNOCKOUT",
			knockout: {
				matches: [
					{
						round: 1,
						name: "Round 1",
						matchId: 101,
						playAgainstId: 102,
						home: {
							entryId: 6953,
							entryName: "Example XI",
							grossPoints: null,
							transferCost: null,
							netPoints: null,
							goalsScored: null,
							goalsConceded: null,
						},
						away: {
							entryId: 6954,
							entryName: "Second XI",
							grossPoints: null,
							transferCost: null,
							netPoints: null,
							goalsScored: null,
							goalsConceded: null,
						},
						winnerEntryId: null,
					},
				],
			},
		},
		...overrides,
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

const seasonMetadataRow = (
	row: Record<string, unknown>,
	finalizedEventIds: number[],
	state: string = "READY"
) => ({
	event_id: row.event_id ?? null,
	revision: row.revision ?? null,
	format: row.format ?? null,
	content_sha256: row.content_sha256 ?? null,
	event_data_checked_at: row.event_data_checked_at ?? null,
	published_at: row.published_at ?? null,
	obligation_format: row.format ?? "POINTS",
	obligation_state: state,
	finalized_event_ids: finalizedEventIds,
});

describe("My Tournament Review V2 repository", () => {
	it("keeps the catalog on the current event checkpoint and bounds ALL reads", () => {
		expect(MY_TOURNAMENT_REVIEW_CATALOG_SQL).toContain(
			"publication.event_data_checked_at = head_event.data_checked_at"
		);
		expect(MY_TOURNAMENT_REVIEW_CATALOG_SQL).toContain("tournament.setup_status = 'ready'");
		expect(MY_TOURNAMENT_REVIEW_CATALOG_SQL).toContain("LIMIT 500");
		expect(MY_TOURNAMENT_REVIEW_CATALOG_SQL).toContain(
			"head_obligation.ready_revision = review_head.revision"
		);
	});

	it("reads a publication through the captured immutable identity", () => {
		expect(MY_TOURNAMENT_REVIEW_PUBLICATION_SQL).toContain("publication.revision = $4::bigint");
		expect(MY_TOURNAMENT_REVIEW_PUBLICATION_SQL).toContain("publication.content_sha256 = $5::text");
		expect(MY_TOURNAMENT_REVIEW_CATALOG_SQL).toContain(
			"head_obligation.format = publication.format"
		);
		expect(MY_TOURNAMENT_REVIEW_HEAD_SQL).toContain("obligation.format = publication.format");
		expect(MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL).toContain("finalized_event_ids");
		expect(MY_TOURNAMENT_REVIEW_SEASON_SQL).toContain("publication.content_sha256 = $6::text");
	});

	it("only reports a status head when its publication and event checkpoint are coherent", () => {
		expect(MY_TOURNAMENT_REVIEW_STATUS_SQL).toContain(
			"JOIN competition.tournament_review_publications publication"
		);
		expect(MY_TOURNAMENT_REVIEW_STATUS_SQL).toContain("WITH latest_finalized AS");
		expect(MY_TOURNAMENT_REVIEW_STATUS_SQL).toContain("latest_finalized.latest_finalized_event_id");
		expect(MY_TOURNAMENT_REVIEW_STATUS_SQL).toContain(
			"publication.content_sha256 = review_head.content_sha256"
		);
		expect(MY_TOURNAMENT_REVIEW_STATUS_SQL).toContain(
			"publication.event_data_checked_at = event.data_checked_at"
		);
		expect(MY_TOURNAMENT_REVIEW_STATUS_SQL).toContain("publication.format = obligation.format");
		expect(MY_TOURNAMENT_REVIEW_STATUS_SQL).toContain(
			"obligation.ready_revision = review_head.revision"
		);
	});

	it("reads status rows and finalized checkpoint from one database snapshot", async () => {
		let queries = 0;
		let observedSql = "";
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				queries += 1;
				observedSql = String(query);
				return {
					rows: [
						{
							event_id: 4,
							format: "POINTS",
							state: "READY",
							next_attempt_at: null,
							execution_attempts: 1,
							source_rechecks: 0,
							degraded_at: null,
							revision: 8,
							published_at: "2026-08-20T00:00:03.000Z",
							latest_finalized_event_id: 4,
						},
					],
				};
			},
		});
		const result = await createMyTournamentReviewRepository().loadStatus(context, 6953);
		expect(queries).toBe(1);
		expect(observedSql).toBe(MY_TOURNAMENT_REVIEW_STATUS_SQL);
		expect(result).toMatchObject({ latestFinalizedEventId: 4, latestAvailableEventId: 4 });
		expect(result.events).toHaveLength(1);
	});

	it("preserves a finalized checkpoint when no obligation row exists", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						event_id: null,
						format: null,
						state: null,
						next_attempt_at: null,
						execution_attempts: null,
						source_rechecks: null,
						degraded_at: null,
						revision: null,
						published_at: null,
						latest_finalized_event_id: 4,
					},
				],
			}),
		});
		const result = await createMyTournamentReviewRepository().loadStatus(context, 6953);
		expect(result).toMatchObject({ latestFinalizedEventId: 4, latestAvailableEventId: null });
		expect(result.events).toEqual([]);
	});

	it("keeps a pre-finalization obligation visible while it is waiting for source data", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						event_id: 5,
						format: "POINTS",
						state: "WAITING_SOURCE",
						next_attempt_at: "2026-08-21T00:00:00.000Z",
						execution_attempts: 1,
						source_rechecks: 1,
						degraded_at: null,
						revision: null,
						published_at: null,
						latest_finalized_event_id: 4,
					},
				],
			}),
		});
		const result = await createMyTournamentReviewRepository().loadStatus(context, 6953);
		expect(result.latestFinalizedEventId).toBe(4);
		expect(result.latestAvailableEventId).toBeNull();
		expect(result.events).toMatchObject([
			{ eventId: 5, state: "WAITING_SOURCE", revision: null, publishedAt: null },
		]);
	});

	it("rejects a READY obligation that is beyond the finalized checkpoint", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						event_id: 5,
						format: "POINTS",
						state: "READY",
						next_attempt_at: null,
						execution_attempts: 1,
						source_rechecks: 0,
						degraded_at: null,
						revision: 8,
						published_at: "2026-08-20T00:00:03.000Z",
						latest_finalized_event_id: 4,
					},
				],
			}),
		});
		await expect(
			createMyTournamentReviewRepository().loadStatus(context, 6953)
		).rejects.toMatchObject({
			message: "Review status contains a READY event beyond the finalized window",
			extensions: { code: "DATA_INTEGRITY_ERROR" },
		});
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

	it("invalidates the catalog cache when the finalized scope advances", async () => {
		const redis = new TestRedis();
		let current = catalogRow({ latest_available_event_id: 4, latest_state: "READY" });
		let queries = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				queries += 1;
				return { rows: [current] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		const ready = await repository.loadCatalog(context, "ACCESSIBLE");
		expect(ready.tournaments[0]).toMatchObject({ state: "READY", latestFinalizedEventId: 4 });

		current = catalogRow({
			latest_finalized_event_id: 5,
			latest_available_event_id: 4,
			latest_state: "PENDING",
		});
		const pending = await repository.loadCatalog(context, "ACCESSIBLE");
		expect(pending.tournaments[0]).toMatchObject({ state: "PENDING", latestFinalizedEventId: 5 });
		expect(queries).toBe(2);
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

	it("fails closed when READY points to an older finalized-event head", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [catalogRow({ latest_state: "READY" })] }),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(repository.loadCatalog(context, "ACCESSIBLE")).rejects.toMatchObject({
			extensions: { code: "DATA_INTEGRITY_ERROR" },
		});
	});

	it("keeps a pending obligation visible when its publication is not ready", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query) === MY_TOURNAMENT_REVIEW_HEAD_SQL) {
					return {
						rows: [
							{
								event_id: null,
								revision: null,
								format: null,
								content_sha256: null,
								event_data_checked_at: null,
								published_at: null,
								obligation_state: "WAITING_SOURCE",
								active_revision: null,
							},
						],
					};
				}
				throw new Error(`unexpected query: ${String(query)}`);
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

	it("rejects a revision pin that no longer matches the active head", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => {
				return {
					rows: [
						{
							event_id: null,
							revision: null,
							format: null,
							content_sha256: null,
							event_data_checked_at: null,
							published_at: null,
							obligation_state: "READY",
							active_revision: 8,
						},
					],
				};
			},
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4, revision: "7" })
		).rejects.toMatchObject({
			message: "Review revision does not match the active publication head",
			extensions: { code: "BAD_USER_INPUT" },
		});
	});

	it("does not pair a missing Gameweek head with a READY obligation from another snapshot", async () => {
		let metadataReads = 0;
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				metadataReads += 1;
				if (String(query) !== MY_TOURNAMENT_REVIEW_HEAD_SQL) {
					throw new Error(`unexpected query: ${String(query)}`);
				}
				return {
					rows: [
						{
							event_id: null,
							revision: null,
							format: null,
							content_sha256: null,
							event_data_checked_at: null,
							published_at: null,
							obligation_state: "READY",
							active_revision: null,
						},
					],
				};
			},
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({
			extensions: { code: "DATA_INTEGRITY_ERROR" },
		});
		expect(metadataReads).toBe(1);
	});

	it("keeps Season pending while the latest finalized scope is being rebuilt", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query) === MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					return {
						rows: [
							seasonMetadataRow(
								{
									event_id: 4,
									revision: null,
									format: null,
									content_sha256: null,
									event_data_checked_at: null,
									published_at: null,
								},
								[4],
								"PENDING"
							),
						],
					};
				}
				throw new Error(`unexpected query: ${String(query)}`);
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
			finalizedEventIds: [4],
		});
	});

	it("does not report a complete Season when an earlier finalized event has a hole", async () => {
		const latest = publicationRow({ event_id: 4, revision: 8 });
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query) !== MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					throw new Error(`unexpected query: ${String(query)}`);
				}
				return {
					rows: [
						seasonMetadataRow(latest, [3, 4]),
						seasonMetadataRow(
							{
								event_id: 3,
								revision: null,
								format: null,
								content_sha256: null,
								event_data_checked_at: null,
								published_at: null,
							},
							[3, 4],
							"WAITING_SOURCE"
						),
					],
				};
			},
		});
		const result = await createMyTournamentReviewRepository().loadSeasonReview(context, {
			tournamentId: 6953,
			throughEventId: 4,
		});
		expect(result).toMatchObject({
			state: "WAITING_SOURCE",
			latestEventId: null,
			finalizedEventIds: [3, 4],
		});
	});

	it("fails closed when any missing finalized Season event still claims READY", async () => {
		const latest = publicationRow({ event_id: 4, revision: 8 });
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query) !== MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					throw new Error(`unexpected query: ${String(query)}`);
				}
				return {
					rows: [
						seasonMetadataRow(latest, [3, 4]),
						seasonMetadataRow(
							{
								event_id: 3,
								revision: null,
								format: null,
								content_sha256: null,
								event_data_checked_at: null,
								published_at: null,
							},
							[3, 4],
							"READY"
						),
					],
				};
			},
		});
		await expect(
			createMyTournamentReviewRepository().loadSeasonReview(context, {
				tournamentId: 6953,
				throughEventId: 4,
			})
		).rejects.toMatchObject({
			extensions: { code: "DATA_INTEGRITY_ERROR" },
		});
	});

	it("fails closed when a newer READY obligation has no matching Season head", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query) === MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					const older = publicationRow({ event_id: 3, revision: 7 });
					return {
						rows: [
							seasonMetadataRow(
								{
									event_id: 4,
									revision: null,
									format: null,
									content_sha256: null,
									event_data_checked_at: null,
									published_at: null,
								},
								[3, 4],
								"READY"
							),
							seasonMetadataRow(older, [3, 4], "READY"),
						],
					};
				}
				throw new Error(`unexpected query: ${String(query)}`);
			},
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadSeasonReview(context, { tournamentId: 6953, throughEventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
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
			grossPointsTotal: 55,
			netPointsTotal: 51,
		});
		expect(result.points?.rows[0]).toMatchObject({
			grossPoints: 55,
			transferCost: 4,
			netPoints: 51,
		});
		expect(redis.setCalls[0]?.[2]).toBe("EX");
		expect(redis.setCalls[0]?.[3]).toBe(300);
	});

	it("reads the observed Gameweek publication even if the active head advances", async () => {
		const observed = publicationRow({ revision: 8 });
		let activeRevision = 8;
		let publicationValues: unknown[] | undefined;
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown, values: unknown) => {
				const sql = String(query);
				if (sql === MY_TOURNAMENT_REVIEW_HEAD_SQL) {
					activeRevision = 9;
					return {
						rows: [
							{
								event_id: 4,
								revision: 8,
								format: "POINTS",
								content_sha256: observed.content_sha256,
								event_data_checked_at: observed.event_data_checked_at,
								published_at: observed.published_at,
							},
						],
					};
				}
				if (sql === MY_TOURNAMENT_REVIEW_PUBLICATION_SQL) {
					publicationValues = values as unknown[];
					return { rows: [observed] };
				}
				throw new Error(`unexpected query: ${sql}`);
			},
		});
		const result = await createMyTournamentReviewRepository().loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
		});
		expect(activeRevision).toBe(9);
		expect(publicationValues?.slice(-2)).toEqual(["8", observed.content_sha256]);
		expect(result.state).toBe("READY");
		expect(result.points?.grossPointsTotal).toBe(55);
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

	it("fails closed when the source span starts before the event checkpoint", async () => {
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					publicationRow({
						source_min_checked_at: "2026-08-19T23:59:59.000Z",
					}),
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("rejects duplicate H2H match identities even when row counts match", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		h2h.matches = [matches[0], { ...matches[0] }];
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						...base,
						row_count: 2,
						payload,
						content_sha256: postgresJsonbContentHash(payload),
					},
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

	it("fails closed when an optional points metric is a numeric string", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		points.rows = [
			{
				...((points.rows as Array<Record<string, unknown>>)[0] ?? {}),
				applicable: false,
				groupId: null,
				rank: null,
				grossPoints: "55",
				transferCost: null,
				netPoints: null,
				tournamentScore: null,
				seasonGrossPoints: null,
				seasonNetPoints: null,
				eventRank: null,
				overallPoints: null,
				overallRank: null,
			},
		];
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						...base,
						expected_subject_count: 1,
						ready_subject_count: 0,
						not_applicable_subject_count: 1,
						payload,
						content_sha256: postgresJsonbContentHash(payload),
					},
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when points rows duplicate an entry or omit the expected roster", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		points.rows = [
			...((points.rows as Array<Record<string, unknown>>) ?? []),
			{ ...((points.rows as Array<Record<string, unknown>>)[0] ?? {}) },
		];
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						...base,
						row_count: 2,
						expected_subject_count: 2,
						ready_subject_count: 2,
						payload,
						content_sha256: postgresJsonbContentHash(payload),
					},
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

	it("fails closed when a points aggregate exceeds the GraphQL Int range", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		points.grossPointsTotal = 2147483648;
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [{ ...base, payload, content_sha256: postgresJsonbContentHash(payload) }],
			}),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when points aggregates disagree with applicable rows", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		points.grossPointsTotal = 54;
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

	it("fails closed when a non-bye H2H side has no settled score", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		matches[0] = {
			...matches[0],
			isBye: false,
			home: {
				...(matches[0]?.home as Record<string, unknown>),
				netPoints: null,
				matchPoints: null,
			},
			away: {
				entryId: 6954,
				entryName: "Second XI",
				isAverage: false,
				grossPoints: 40,
				transferCost: 0,
				netPoints: 38,
				matchPoints: 0,
				rank: 2,
			},
		};
		const standings = h2h.standings as Array<Record<string, unknown>>;
		standings.push({
			...standings[0],
			entryId: 6954,
			entryName: "Second XI",
			rank: 2,
			won: 0,
			lost: 1,
			matchPoints: 0,
			pointsFor: 38,
			pointsAgainst: 42,
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						...base,
						expected_subject_count: 2,
						ready_subject_count: 2,
						not_applicable_subject_count: 0,
						payload,
						content_sha256: postgresJsonbContentHash(payload),
					},
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when a bye is represented by an Average Team", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		matches[0] = {
			...matches[0],
			home: {
				entryId: null,
				entryName: "Average Team",
				isAverage: true,
				netPoints: 38,
				matchPoints: 0,
				rank: null,
			},
			away: null,
			isBye: true,
		};
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

	it("fails closed when an H2H match participant is absent from standings", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		matches[0] = {
			...matches[0],
			home: {
				entryId: 6954,
				entryName: "Other XI",
				isAverage: false,
				netPoints: 42,
				matchPoints: 3,
				rank: 1,
			},
		};
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

	it("fails closed when an H2H standing has no fixture side", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const standings = h2h.standings as Array<Record<string, unknown>>;
		standings.push({
			...standings[0],
			entryId: 6954,
			entryName: "Unmatched XI",
			rank: 2,
			matchPoints: 0,
			pointsFor: 0,
			pointsAgainst: 0,
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({
				rows: [
					{
						...base,
						expected_subject_count: 3,
						ready_subject_count: 2,
						not_applicable_subject_count: 1,
						payload,
						content_sha256: postgresJsonbContentHash(payload),
					},
				],
			}),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when a non-bye H2H match pairs an entry with itself", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		const home = matches[0]!.home;
		matches[0] = { ...matches[0], isBye: false, away: structuredClone(home) };
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

	it("fails closed when a non-bye H2H match pairs two Average Teams", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		const average = {
			entryId: null,
			entryName: "Average Team",
			isAverage: true,
			netPoints: 38,
			matchPoints: 0,
			rank: null,
		};
		matches[0] = { ...matches[0], isBye: false, home: average, away: { ...average } };
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

	it("fails closed when knockout matches repeat a match identity", async () => {
		const match = {
			round: 1,
			name: "Round 1",
			matchId: 101,
			playAgainstId: 102,
			home: { entryId: 6953, entryName: "Example XI" },
			away: { entryId: 6954, entryName: "Second XI" },
			winnerEntryId: null,
		};
		const payload = {
			schemaVersion: "my-tournament-review-v2",
			metricVersion: "descriptive-v1",
			format: "KNOCKOUT",
			knockout: { matches: [match, { ...match }] },
		};
		const row = publicationRow({
			format: "KNOCKOUT",
			expected_subject_count: 2,
			ready_subject_count: 2,
			row_count: 2,
			payload,
			content_sha256: postgresJsonbContentHash(payload),
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when distinct knockout entry coverage exceeds subject metadata", async () => {
		const base = knockoutPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const knockout = payload.knockout as Record<string, unknown>;
		const matches = knockout.matches as Array<Record<string, unknown>>;
		matches.push({
			...matches[0],
			matchId: 102,
			playAgainstId: 103,
			away: {
				...(matches[0]!.away as Record<string, unknown>),
				entryId: 6955,
				entryName: "Third XI",
			},
		});
		const row = {
			...base,
			row_count: 2,
			payload,
			content_sha256: postgresJsonbContentHash(payload),
		};
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when a knockout match pairs an entry with itself", async () => {
		const match = {
			round: 1,
			name: "Round 1",
			matchId: 101,
			playAgainstId: 102,
			home: { entryId: 6953, entryName: "Example XI" },
			away: { entryId: 6953, entryName: "Example XI" },
			winnerEntryId: 6953,
		};
		const payload = {
			schemaVersion: "my-tournament-review-v2",
			metricVersion: "descriptive-v1",
			format: "KNOCKOUT",
			knockout: { matches: [match] },
		};
		const row = publicationRow({
			format: "KNOCKOUT",
			expected_subject_count: 1,
			ready_subject_count: 1,
			row_count: 1,
			payload,
			content_sha256: postgresJsonbContentHash(payload),
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when a knockout side reports negative goals", async () => {
		const base = knockoutPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const matches = (payload.knockout as Record<string, unknown>).matches as Array<
			Record<string, unknown>
		>;
		(matches[0]!.home as Record<string, unknown>).goalsScored = -1;
		const row = { ...base, payload, content_sha256: postgresJsonbContentHash(payload) };
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("rejects a cached knockout side whose goals are negative", async () => {
		const redis = new TestRedis();
		let databaseReads = 0;
		const publication = knockoutPublicationRow();
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [publication] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		await repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 });
		const cacheKey = [...redis.values.keys()][0];
		expect(cacheKey).toBeDefined();
		const cached = JSON.parse(redis.values.get(cacheKey!)!) as {
			knockout: { matches: Array<{ home: { goalsScored: number | null } }> };
		};
		cached.knockout.matches[0]!.home.goalsScored = -1;
		redis.values.set(cacheKey!, JSON.stringify(cached));

		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
		});
		expect(result.knockout?.matches[0]?.home?.goalsScored).toBeNull();
		expect(databaseReads).toBe(4);
	});

	it("fails closed when a non-bye H2H side reports negative match points", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const matches = (payload.h2h as Record<string, unknown>).matches as Array<
			Record<string, unknown>
		>;
		const match = matches[0]!;
		match.isBye = false;
		match.away = {
			entryId: 6954,
			entryName: "Second XI",
			isAverage: false,
			netPoints: 38,
			matchPoints: 0,
			rank: 2,
		};
		(match.home as Record<string, unknown>).matchPoints = -1;
		const row = { ...base, payload, content_sha256: postgresJsonbContentHash(payload) };
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("rejects a cached H2H side whose match points are negative", async () => {
		const redis = new TestRedis();
		const publication = h2hPublicationRow();
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [publication] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		await repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 });
		const cacheKey = [...redis.values.keys()][0];
		expect(cacheKey).toBeDefined();
		const cached = JSON.parse(redis.values.get(cacheKey!)!) as {
			h2h: { matches: Array<{ home: { matchPoints: number | null } }> };
		};
		cached.h2h.matches[0]!.home.matchPoints = -1;
		redis.values.set(cacheKey!, JSON.stringify(cached));
		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
		});
		expect(result.h2h?.matches[0]?.home?.matchPoints).toBe(3);
		expect(databaseReads).toBe(4);
	});

	it("fails closed when a required H2H standing metric is null", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const standings = h2h.standings as Array<Record<string, unknown>>;
		standings[0] = { ...standings[0], played: null };
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

	it("continues paging while H2H standings outnumber matches", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const h2h = payload.h2h as Record<string, unknown>;
		const matches = h2h.matches as Array<Record<string, unknown>>;
		matches[0] = {
			...matches[0],
			isBye: false,
			away: {
				entryId: 6954,
				entryName: "Second XI",
				isAverage: false,
				grossPoints: 40,
				transferCost: 0,
				netPoints: 38,
				matchPoints: 0,
				rank: 2,
			},
		};
		const standings = h2h.standings as Array<Record<string, unknown>>;
		standings[0] = {
			...standings[0],
			pointsAgainst: 38,
		};
		standings.push({
			...standings[0],
			entryId: 6954,
			entryName: "Second XI",
			rank: 2,
			won: 0,
			lost: 1,
			matchPoints: 0,
			pointsFor: 38,
			pointsAgainst: 42,
		});
		const row = {
			...base,
			expected_subject_count: 2,
			ready_subject_count: 2,
			not_applicable_subject_count: 0,
			payload,
			content_sha256: postgresJsonbContentHash(payload),
		};
		let publicationReads = 0;
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query) === MY_TOURNAMENT_REVIEW_PUBLICATION_SQL) publicationReads += 1;
				return { rows: [row] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		const firstPage = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 1,
		});
		expect(firstPage.h2h?.matches).toHaveLength(1);
		expect(firstPage.h2h?.standings).toHaveLength(1);
		expect(firstPage.h2h?.hasNextPage).toBe(true);
		expect(firstPage.h2h?.nextCursor).toBe(
			"eyJvZmZzZXQiOjEsInJldmlzaW9uIjoiOCIsInNjb3BlIjoiWzIwMjYsNjk1Myw0LFwiSDJIXCIsXCJIMkhcIl0ifQ"
		);

		const secondPage = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 1,
			after: firstPage.h2h?.nextCursor,
		});
		expect(secondPage.h2h?.matches).toHaveLength(0);
		expect(secondPage.h2h?.standings).toHaveLength(1);
		expect(secondPage.h2h?.hasNextPage).toBe(false);
		expect(secondPage.h2h?.nextCursor).toBeNull();
		const cachedSecondPage = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 1,
			after: firstPage.h2h?.nextCursor,
		});
		expect(cachedSecondPage.h2h?.matches).toHaveLength(0);
		expect(cachedSecondPage.h2h?.standings).toHaveLength(1);
		expect(publicationReads).toBe(2);
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
		latestPoints.grossPointsTotal = 100;
		latestPoints.grossPointsAverage = 50;
		latestPoints.netPointsTotal = 94;
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
				const sql = String(query);
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					return {
						rows: [seasonMetadataRow(latest, [3, 4]), seasonMetadataRow(older, [3, 4])],
					};
				}
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_SQL) return { rows: [latest] };
				throw new Error(`unexpected query: ${sql}`);
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
		expect(result.points?.nextCursor).toBe(
			"eyJvZmZzZXQiOjEsInJldmlzaW9uIjoiOCIsInNjb3BlIjoiWzIwMjYsNjk1Myw0LFwiUE9JTlRTXCIsXCJTRUFTT05fUE9JTlRTXCJdIn0"
		);
	});

	it("fails closed when the Season payload advances after the observed head", async () => {
		const observed = publicationRow({ event_id: 4, revision: 8 });
		const advanced = publicationRow({ event_id: 4, revision: 9 });
		let seasonArgs: unknown[] | undefined;
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown, values: unknown) => {
				const sql = String(query);
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_SQL) {
					seasonArgs = values as unknown[];
					return { rows: [advanced] };
				}
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					return { rows: [seasonMetadataRow(observed, [4])] };
				}
				return { rows: [observed] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		await expect(
			repository.loadSeasonReview(context, { tournamentId: 6953, throughEventId: 4 })
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
		expect(seasonArgs?.slice(-3)).toEqual([4, "8", observed.content_sha256]);
	});

	it("uses cumulative transfer cost for Season rows", async () => {
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
		latestPoints.grossPointsTotal = 100;
		latestPoints.grossPointsAverage = 50;
		latestPoints.netPointsTotal = 94;
		latestPoints.seasonGrossPointsTotal = 190;
		latestPoints.seasonGrossPointsAverage = 95;
		latestPoints.seasonNetPointsTotal = 182;
		const latest = publicationRow({
			payload: latestPayload,
			row_count: 2,
			expected_subject_count: 2,
			ready_subject_count: 2,
			content_sha256: postgresJsonbContentHash(latestPayload),
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				const sql = String(query);
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					return { rows: [seasonMetadataRow(latest, [4])] };
				}
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_SQL) return { rows: [latest] };
				throw new Error(`unexpected query: ${sql}`);
			},
		});
		const result = await createMyTournamentReviewRepository().loadSeasonReview(context, {
			tournamentId: 6953,
			throughEventId: 4,
			first: 2,
		});
		expect(result.points?.rows.map((row) => row.transferCost)).toEqual([4, 4]);
	});

	it("fails closed when an invalid cumulative cost is beyond the first Season page", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		const rows = points.rows as Array<Record<string, unknown>>;
		rows.push({
			...rows[0],
			entryId: 6954,
			entryName: "Second XI",
			playerName: "Second Manager",
			grossPoints: 45,
			transferCost: 2,
			netPoints: 43,
			seasonGrossPoints: 90,
			seasonNetPoints: 95,
		});
		points.grossPointsTotal = 100;
		points.grossPointsAverage = 50;
		points.netPointsTotal = 94;
		points.seasonGrossPointsTotal = 190;
		points.seasonGrossPointsAverage = 95;
		points.seasonNetPointsTotal = 191;
		const latest = publicationRow({
			payload,
			row_count: 2,
			expected_subject_count: 2,
			ready_subject_count: 2,
			content_sha256: postgresJsonbContentHash(payload),
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				const sql = String(query);
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					return { rows: [seasonMetadataRow(latest, [4])] };
				}
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_SQL) return { rows: [latest] };
				throw new Error(`unexpected query: ${sql}`);
			},
		});
		await expect(
			createMyTournamentReviewRepository().loadSeasonReview(context, {
				tournamentId: 6953,
				throughEventId: 4,
				first: 1,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("accepts H2H pages whose independent match and standings slices are ordered differently", async () => {
		const matches = [
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
				away: {
					entryId: 6954,
					entryName: "Second XI",
					isAverage: false,
					netPoints: 38,
					matchPoints: 0,
					rank: 2,
				},
				isBye: false,
			},
			{
				matchId: "4-2",
				groupId: 1,
				home: {
					entryId: 6955,
					entryName: "Third XI",
					isAverage: false,
					netPoints: 30,
					matchPoints: 3,
					rank: 1,
				},
				away: {
					entryId: 6956,
					entryName: "Fourth XI",
					isAverage: false,
					netPoints: 20,
					matchPoints: 0,
					rank: 2,
				},
				isBye: false,
			},
		];
		const standing = (
			entryId: number,
			entryName: string,
			rank: number,
			pointsFor: number,
			pointsAgainst: number,
			won: number
		) => ({
			groupId: 1,
			entryId,
			entryName,
			rank,
			played: 1,
			won,
			drawn: 0,
			lost: won ? 0 : 1,
			matchPoints: won ? 3 : 0,
			pointsFor,
			pointsAgainst,
		});
		const payload = {
			schemaVersion: "my-tournament-review-v2",
			metricVersion: "descriptive-v1",
			format: "H2H",
			h2h: {
				matches,
				standings: [
					standing(6955, "Third XI", 1, 30, 20, 1),
					standing(6956, "Fourth XI", 2, 20, 30, 0),
					standing(6953, "Example XI", 1, 42, 38, 1),
					standing(6954, "Second XI", 2, 38, 42, 0),
				],
			},
		};
		const row = h2hPublicationRow();
		const publication = {
			...row,
			row_count: 2,
			expected_subject_count: 4,
			ready_subject_count: 4,
			not_applicable_subject_count: 0,
			payload,
			content_sha256: postgresJsonbContentHash(payload),
		};
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [publication] }),
		});
		const result = await createMyTournamentReviewRepository().loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 1,
		});
		expect(result.h2h?.matches[0]?.home?.entryId).toBe(6953);
		expect(result.h2h?.standings[0]?.entryId).toBe(6955);
	});

	it("rejects a review cursor from a different publication scope", async () => {
		const payload = structuredClone(publicationRow().payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		const rows = points.rows as Array<Record<string, unknown>>;
		rows.push({
			...rows[0],
			entryId: 6954,
			entryName: "Second XI",
			playerName: "Second Manager",
			groupId: 1,
			rank: 2,
			grossPoints: 40,
			transferCost: 0,
			netPoints: 40,
			seasonGrossPoints: 40,
			seasonNetPoints: 40,
		});
		points.grossPointsTotal = 95;
		points.grossPointsAverage = 47.5;
		points.netPointsTotal = 91;
		points.seasonGrossPointsTotal = 140;
		points.seasonGrossPointsAverage = 70;
		points.seasonNetPointsTotal = 136;
		const row = publicationRow({
			payload,
			row_count: 2,
			expected_subject_count: 2,
			ready_subject_count: 2,
			content_sha256: postgresJsonbContentHash(payload),
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				if (String(query) === MY_TOURNAMENT_REVIEW_HEAD_SQL) {
					return { rows: [publicationRow()] };
				}
				return { rows: [row] };
			},
		});
		const firstPage = await createMyTournamentReviewRepository().loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
			first: 1,
		});
		const decoded = JSON.parse(
			Buffer.from(firstPage.points!.nextCursor!, "base64url").toString("utf8")
		) as Record<string, unknown>;
		decoded.scope = '[2026,6953,5,"POINTS","GAMEWEEK_POINTS"]';
		const wrongScopeCursor = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
				first: 1,
				after: wrongScopeCursor,
			})
		).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
	});

	it("honors the Season default page size when first is explicitly null", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		const rows = Array.from({ length: 60 }, (_, index) => ({
			...(points.rows as Array<Record<string, unknown>>)[0],
			entryId: 7000 + index,
			entryName: `XI ${index + 1}`,
			playerName: `Manager ${index + 1}`,
			rank: index + 1,
			grossPoints: 1,
			transferCost: 0,
			netPoints: 1,
			seasonGrossPoints: 1,
			seasonNetPoints: 1,
		}));
		points.rows = rows;
		points.grossPointsTotal = 60;
		points.grossPointsAverage = 1;
		points.netPointsTotal = 60;
		points.seasonGrossPointsTotal = 60;
		points.seasonGrossPointsAverage = 1;
		points.seasonNetPointsTotal = 60;
		const latest = {
			...base,
			payload,
			row_count: 60,
			expected_subject_count: 60,
			ready_subject_count: 60,
			content_sha256: postgresJsonbContentHash(payload),
		};
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async (query: unknown) => {
				const sql = String(query);
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_HEAD_SQL) {
					return { rows: [seasonMetadataRow(latest, [4])] };
				}
				if (sql === MY_TOURNAMENT_REVIEW_SEASON_SQL) return { rows: [latest] };
				throw new Error(`unexpected query: ${sql}`);
			},
		});
		const result = await createMyTournamentReviewRepository().loadSeasonReview(context, {
			tournamentId: 6953,
			throughEventId: 4,
			first: null,
		});
		expect(result.points?.rows).toHaveLength(60);
		expect(result.points?.hasNextPage).toBe(false);
	});

	it("fails closed when H2H outcome counts do not add up to played", async () => {
		const base = h2hPublicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const standings = (payload.h2h as Record<string, unknown>).standings as Array<
			Record<string, unknown>
		>;
		standings[0] = { ...standings[0], played: 1, won: 1, drawn: 0, lost: 1 };
		const row = { ...base, payload, content_sha256: postgresJsonbContentHash(payload) };
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when a completed knockout fixture has unsettled score metrics", async () => {
		const payload = {
			schemaVersion: "my-tournament-review-v2",
			metricVersion: "descriptive-v1",
			format: "KNOCKOUT",
			knockout: {
				matches: [
					{
						round: 1,
						name: "Round 1",
						matchId: 101,
						playAgainstId: 102,
						home: {
							entryId: 6953,
							entryName: "Example XI",
							netPoints: null,
							goalsScored: null,
							goalsConceded: null,
						},
						away: {
							entryId: 6954,
							entryName: "Second XI",
							netPoints: 10,
							goalsScored: 1,
							goalsConceded: 0,
						},
						winnerEntryId: 6954,
					},
				],
			},
		};
		const row = publicationRow({
			format: "KNOCKOUT",
			payload,
			row_count: 1,
			expected_subject_count: 2,
			ready_subject_count: 2,
			content_sha256: postgresJsonbContentHash(payload),
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when an H2H entry appears in multiple matches", async () => {
		const payload = {
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
							netPoints: 40,
							matchPoints: 3,
							rank: 1,
						},
						away: {
							entryId: 6954,
							entryName: "Second XI",
							isAverage: false,
							netPoints: 30,
							matchPoints: 0,
							rank: 2,
						},
						isBye: false,
					},
					{
						matchId: "4-2",
						groupId: 1,
						home: {
							entryId: 6953,
							entryName: "Example XI",
							isAverage: false,
							netPoints: 40,
							matchPoints: 3,
							rank: 1,
						},
						away: {
							entryId: 6955,
							entryName: "Third XI",
							isAverage: false,
							netPoints: 20,
							matchPoints: 0,
							rank: 2,
						},
						isBye: false,
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
						pointsFor: 40,
						pointsAgainst: 30,
					},
					{
						groupId: 1,
						entryId: 6954,
						entryName: "Second XI",
						rank: 2,
						played: 1,
						won: 0,
						drawn: 0,
						lost: 1,
						matchPoints: 0,
						pointsFor: 30,
						pointsAgainst: 40,
					},
					{
						groupId: 1,
						entryId: 6955,
						entryName: "Third XI",
						rank: 3,
						played: 1,
						won: 0,
						drawn: 0,
						lost: 1,
						matchPoints: 0,
						pointsFor: 20,
						pointsAgainst: 40,
					},
				],
			},
		};
		const row = h2hPublicationRow({
			payload,
			row_count: 2,
			expected_subject_count: 3,
			ready_subject_count: 3,
			not_applicable_subject_count: 0,
			content_sha256: postgresJsonbContentHash(payload),
		});
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when an applicable points row has a non-positive group or rank", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		(points.rows as Array<Record<string, unknown>>)[0]!.groupId = 0;
		const row = { ...base, payload, content_sha256: postgresJsonbContentHash(payload) };
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [row] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("fails closed when applicable points do not reconcile gross, cost, and net", async () => {
		const base = publicationRow();
		const payload = structuredClone(base.payload) as Record<string, unknown>;
		const points = payload.points as Record<string, unknown>;
		const row = (points.rows as Array<Record<string, unknown>>)[0]!;
		row.transferCost = 2;
		row.netPoints = 55;
		points.netPointsTotal = 55;
		const publication = {
			...base,
			payload,
			content_sha256: postgresJsonbContentHash(payload),
		};
		const context = buildSnapshotContext(new TestRedis(), {
			databaseQuery: async () => ({ rows: [publication] }),
		});
		await expect(
			createMyTournamentReviewRepository().loadGameweekReview(context, {
				tournamentId: 6953,
				eventId: 4,
			})
		).rejects.toMatchObject({ extensions: { code: "DATA_INTEGRITY_ERROR" } });
	});

	it("rejects a cached points row whose gross, cost, and net do not reconcile", async () => {
		const redis = new TestRedis();
		let databaseReads = 0;
		const publication = publicationRow();
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [publication] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		await repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 });
		const cacheKey = [...redis.values.keys()][0];
		expect(cacheKey).toBeDefined();
		const cached = JSON.parse(redis.values.get(cacheKey!)!) as {
			points: { rows: Array<{ transferCost: number; netPoints: number }> };
		};
		cached.points.rows[0].transferCost = 2;
		cached.points.rows[0].netPoints = 55;
		redis.values.set(cacheKey!, JSON.stringify(cached));

		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
		});
		expect(databaseReads).toBe(4);
		expect(result.points?.rows[0]?.netPoints).toBe(51);
	});

	it("rejects a cached points aggregate outside the GraphQL Int range", async () => {
		const redis = new TestRedis();
		let databaseReads = 0;
		const publication = publicationRow();
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [publication] };
			},
		});
		const repository = createMyTournamentReviewRepository();
		await repository.loadGameweekReview(context, { tournamentId: 6953, eventId: 4 });
		const cacheKey = [...redis.values.keys()][0];
		expect(cacheKey).toBeDefined();
		const cached = JSON.parse(redis.values.get(cacheKey!)!) as {
			points: { grossPointsTotal: number };
		};
		cached.points.grossPointsTotal = 2147483648;
		redis.values.set(cacheKey!, JSON.stringify(cached));

		const result = await repository.loadGameweekReview(context, {
			tournamentId: 6953,
			eventId: 4,
		});
		expect(result.points?.grossPointsTotal).toBe(55);
		expect(databaseReads).toBe(4);
	});
});
