import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { MY_TOURNAMENT_REVIEW_CATALOG_SQL } from "../../../src/domains/my-fpl/tournament-review-v2.repository";

const fixtureUrl = process.env.CATALOG_FIXTURE_URL;
describe.skipIf(!fixtureUrl)("previous ready publication PostgreSQL selection", () => {
	let pool: Pool;
	const marker = "SELECT review_head.event_id::integer AS previous_ready_event_id";
	const start = MY_TOURNAMENT_REVIEW_CATALOG_SQL.indexOf(marker);
	const end = MY_TOURNAMENT_REVIEW_CATALOG_SQL.indexOf(") previous_ready ON true", start);
	const branch = MY_TOURNAMENT_REVIEW_CATALOG_SQL.slice(start, end);
	const query = `SELECT previous_ready_event_id FROM (SELECT 2026 AS season_id, 1 AS tournament_id) tournament CROSS JOIN (SELECT $1::integer AS latest_finalized_event_id) finalized LEFT JOIN LATERAL (${branch}) previous_ready ON true`;
	const headStart = MY_TOURNAMENT_REVIEW_CATALOG_SQL.indexOf(
		"SELECT publication.event_id AS latest_ready_event_id"
	);
	const headEnd = MY_TOURNAMENT_REVIEW_CATALOG_SQL.indexOf(") head ON true", headStart);
	const phaseQueryFor = (format: "POINTS" | "H2H" | "KNOCKOUT") => {
		const alias = { POINTS: "points_phase", H2H: "h2h_phase", KNOCKOUT: "knockout_phase" }[format];
		const phaseEnd = MY_TOURNAMENT_REVIEW_CATALOG_SQL.indexOf(`) ${alias} ON true`);
		const phaseStart = MY_TOURNAMENT_REVIEW_CATALOG_SQL.lastIndexOf(
			"LEFT JOIN LATERAL (\n\t\tSELECT CASE",
			phaseEnd
		);
		if (phaseStart < 0 || phaseEnd < phaseStart) throw new Error("Phase SQL branch missing");
		return `SELECT ${alias}.state FROM
		(SELECT 2026 AS season_id, 1 AS tournament_id, '${format === "H2H" ? "battle_races" : "points_races"}' AS group_mode,
		 1 AS group_started_event_id, $1::integer AS group_ended_event_id,
		 'knockout' AS knockout_mode, 1 AS knockout_started_event_id,
		 $1::integer AS knockout_ended_event_id) tournament
		LEFT JOIN LATERAL (${MY_TOURNAMENT_REVIEW_CATALOG_SQL.slice(headStart, headEnd)}) head ON true
		${MY_TOURNAMENT_REVIEW_CATALOG_SQL.slice(phaseStart, phaseEnd)} ) ${alias} ON true`;
	};
	const phaseQuery = phaseQueryFor("POINTS");
	beforeAll(() => {
		const url = new URL(fixtureUrl!);
		if (url.hostname !== "127.0.0.1" || url.pathname !== "/catalog_regression")
			throw new Error("Requires task-owned loopback catalog_regression database");
		if (start < 0 || end < start) throw new Error("Previous-ready SQL branch missing");
		pool = new Pool({ connectionString: fixtureUrl, max: 1 });
	});
	afterAll(async () => {
		await pool?.end();
	});
	beforeEach(async () => {
		await pool.query(
			"TRUNCATE competition.tournament_review_heads, competition.tournament_review_obligations, competition.tournament_review_publications, competition.tournament_review_publication_chunks, fpl.events"
		);
		const row = {
			entryId: 1,
			entryName: "Fixture XI",
			playerName: "Fixture",
			applicable: true,
			groupId: 1,
			rank: 1,
			grossPoints: 55,
			transferCost: 4,
			netPoints: 51,
			tournamentScore: 55,
			seasonGrossPoints: 100,
			seasonNetPoints: 96,
		};
		for (const event of [1, 2, 3, 4]) {
			await pool.query("INSERT INTO fpl.events VALUES(2026,$1,true,true,'2026-08-20T00:00:00Z')", [
				event,
			]);
			for (const section of ["POINTS_STANDINGS", "POINTS_TRAJECTORIES"])
				await pool.query(
					"INSERT INTO competition.tournament_review_publication_chunks SELECT 2026,1,$1,1,$2,0,1,$3::jsonb,encode(extensions.digest(convert_to(($3::jsonb)::text,'UTF8'),'sha256'),'hex')",
					[event, section, JSON.stringify([row])]
				);
			const sections = (
				await pool.query<{ sections: unknown }>(
					"SELECT jsonb_agg(jsonb_build_object('sectionKey',section_key,'chunkCount',1,'itemCount',1,'chunkHashes',jsonb_build_array(chunk_sha256),'chunkItemCounts',jsonb_build_array(1)) ORDER BY section_key) AS sections FROM competition.tournament_review_publication_chunks WHERE event_id=$1",
					[event]
				)
			).rows[0].sections;
			const payload = {
				schemaVersion: "my-tournament-review-v2.1",
				metricVersion: "settled-review-v2",
				format: "POINTS",
				points: {
					headline: "gross",
					grossPointsTotal: 55,
					grossPointsAverage: 55,
					netPointsTotal: 51,
					seasonGrossPointsTotal: 100,
					seasonGrossPointsAverage: 100,
					seasonNetPointsTotal: 96,
				},
				manifest: { sectionCount: 2, chunkCount: 2, sections },
			};
			await pool.query(
				"INSERT INTO competition.tournament_review_publications SELECT 2026,1,$1,1,encode(extensions.digest(convert_to(extensions.strip_review_operational_metadata($2::jsonb)::text || E'\\n' || (SELECT string_agg(chunk_sha256,E'\\n' ORDER BY section_key,chunk_index) FROM competition.tournament_review_publication_chunks WHERE event_id=$1),'UTF8'),'sha256'),'hex'),'POINTS','my-tournament-review-v2.1','settled-review-v2',$2::jsonb,1,1,0,1,'2026-08-20T00:00:00Z','2026-08-20T00:00:01Z','2026-08-20T00:00:02Z','2026-08-20T00:00:03Z'",
				[event, JSON.stringify(payload)]
			);
			await pool.query(
				"INSERT INTO competition.tournament_review_heads SELECT season_id,tournament_id,event_id,revision,content_sha256 FROM competition.tournament_review_publications WHERE event_id=$1",
				[event]
			);
			await pool.query(
				"INSERT INTO competition.tournament_review_obligations VALUES(2026,1,$1,'POINTS','READY',1)",
				[event]
			);
		}
	});
	const selected = async (boundary: number | null) =>
		(await pool.query<{ previous_ready_event_id: number | null }>(query, [boundary])).rows[0]
			.previous_ready_event_id;
	it("selects the highest coherent event strictly before the boundary", async () => {
		expect(await selected(4)).toBe(3);
		expect(await selected(3)).toBe(2);
		expect(await selected(1)).toBeNull();
		expect(await selected(null)).toBe(4);
	});
	it("skips corrupted latest history and keeps an earlier valid publication", async () => {
		await pool.query(
			"UPDATE competition.tournament_review_publication_chunks SET chunk_sha256=repeat('0',64) WHERE event_id=3"
		);
		expect(await selected(4)).toBe(2);
	});
	it("returns null when all historical obligations are unready", async () => {
		await pool.query(
			"UPDATE competition.tournament_review_obligations SET state='WAITING_SOURCE' WHERE event_id<4"
		);
		expect(await selected(4)).toBeNull();
	});
	it("skips a mismatched revision", async () => {
		await pool.query(
			"UPDATE competition.tournament_review_obligations SET ready_revision=2 WHERE event_id=3"
		);
		expect(await selected(4)).toBe(2);
	});
	it("reuses an identical validated head without executing phase publication validation again", async () => {
		expect((await pool.query<{ state: string }>(phaseQuery, [4])).rows[0].state).toBe("READY");
		const result = await pool.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
			`EXPLAIN (ANALYZE, FORMAT JSON) ${phaseQuery}`,
			[4]
		);
		const phaseLoops: number[] = [];
		const visit = (node: Record<string, unknown>) => {
			if (node.Alias === "phase_publication") phaseLoops.push(Number(node["Actual Loops"]));
			for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
		};
		visit(result.rows[0]["QUERY PLAN"][0].Plan);
		expect(phaseLoops.length).toBeGreaterThan(0);
		expect(phaseLoops.every((loops) => loops === 0)).toBe(true);
	});
	it("validates an older phase instead of borrowing a different event head", async () => {
		expect((await pool.query<{ state: string }>(phaseQuery, [3])).rows[0].state).toBe("READY");
		await pool.query(
			"UPDATE competition.tournament_review_publication_chunks SET chunk_sha256=repeat('0',64) WHERE event_id=3"
		);
		expect((await pool.query<{ state: string }>(phaseQuery, [3])).rows[0].state).toBe("DEGRADED");
	});
	it("does not reuse an older valid head for a corrupt or revision-mismatched latest phase", async () => {
		await pool.query(
			"UPDATE competition.tournament_review_obligations SET ready_revision=2 WHERE event_id=4"
		);
		expect((await pool.query<{ state: string }>(phaseQuery, [4])).rows[0].state).toBe("DEGRADED");
		await pool.query(
			"UPDATE competition.tournament_review_obligations SET ready_revision=1 WHERE event_id=4"
		);
		await pool.query(
			"UPDATE competition.tournament_review_publication_chunks SET chunk_sha256=repeat('0',64) WHERE event_id=4"
		);
		expect((await pool.query<{ state: string }>(phaseQuery, [4])).rows[0].state).toBe("DEGRADED");
	});
	it("keeps missing and unready heads fail closed", async () => {
		await pool.query("DELETE FROM competition.tournament_review_heads");
		expect((await pool.query<{ state: string }>(phaseQuery, [4])).rows[0].state).toBe("DEGRADED");
		await pool.query("UPDATE competition.tournament_review_obligations SET state='WAITING_SOURCE'");
		expect((await pool.query<{ state: string }>(phaseQuery, [4])).rows[0].state).toBe(
			"WAITING_SOURCE"
		);
	});
	it("keeps an unstarted phase distinct from an available catalog head", async () => {
		expect((await pool.query<{ state: string }>(phaseQuery, [0])).rows[0].state).toBe(
			"NOT_STARTED"
		);
	});
	for (const format of ["H2H", "KNOCKOUT"] as const) {
		it(`reuses a coherent ${format} head and rejects it after chunk corruption`, async () => {
			const sections: Record<string, unknown[]> =
				format === "H2H"
					? {
							H2H_STANDINGS: [
								{
									groupId: 1,
									entryId: 1,
									entryName: "Fixture XI",
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
							H2H_FIXTURES: [
								{
									matchId: "4-1",
									groupId: 1,
									isBye: true,
									home: {
										entryId: 1,
										entryName: "Fixture XI",
										isAverage: false,
										netPoints: 42,
										matchPoints: null,
										rank: 1,
									},
									away: null,
								},
							],
						}
					: {
							KNOCKOUT_BRACKET: [
								{
									matchId: 1,
									playAgainstId: 2,
									round: 1,
									name: "Final",
									winnerEntryId: null,
									home: {
										entryId: 1,
										entryName: "Fixture XI",
										grossPoints: null,
										transferCost: null,
										netPoints: null,
										goalsScored: null,
										goalsConceded: null,
									},
									away: {
										entryId: 2,
										entryName: "Second XI",
										grossPoints: null,
										transferCost: null,
										netPoints: null,
										goalsScored: null,
										goalsConceded: null,
									},
								},
							],
						};
			await pool.query(
				"DELETE FROM competition.tournament_review_publication_chunks WHERE event_id=4"
			);
			for (const [key, rows] of Object.entries(sections)) {
				await pool.query(
					"INSERT INTO competition.tournament_review_publication_chunks SELECT 2026,1,4,1,$1,0,1,$2::jsonb,encode(extensions.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex')",
					[key, JSON.stringify(rows)]
				);
			}
			const descriptors = (
				await pool.query<{ sections: unknown }>(
					"SELECT jsonb_agg(jsonb_build_object('sectionKey',section_key,'chunkCount',1,'itemCount',1,'chunkHashes',jsonb_build_array(chunk_sha256),'chunkItemCounts',jsonb_build_array(1)) ORDER BY section_key) AS sections FROM competition.tournament_review_publication_chunks WHERE event_id=4"
				)
			).rows[0].sections;
			const payload = {
				schemaVersion: "my-tournament-review-v2.1",
				metricVersion: "settled-review-v2",
				format,
				...(format === "H2H" ? { h2h: {} } : { knockout: {} }),
				manifest: {
					sectionCount: Object.keys(sections).length,
					chunkCount: Object.keys(sections).length,
					sections: descriptors,
				},
			};
			await pool.query(
				"UPDATE competition.tournament_review_publications SET format=$1,payload=$2::jsonb,expected_subject_count=2,ready_subject_count=$3,not_applicable_subject_count=$4,content_sha256=encode(extensions.digest(convert_to(extensions.strip_review_operational_metadata($2::jsonb)::text || E'\\n' || (SELECT string_agg(chunk_sha256,E'\\n' ORDER BY section_key,chunk_index) FROM competition.tournament_review_publication_chunks WHERE event_id=4),'UTF8'),'sha256'),'hex') WHERE event_id=4",
				[format, JSON.stringify(payload), format === "H2H" ? 1 : 2, format === "H2H" ? 1 : 0]
			);
			await pool.query(
				"UPDATE competition.tournament_review_heads SET content_sha256=(SELECT content_sha256 FROM competition.tournament_review_publications WHERE event_id=4) WHERE event_id=4"
			);
			await pool.query(
				"UPDATE competition.tournament_review_obligations SET format=$1 WHERE event_id=4",
				[format]
			);
			const sql = phaseQueryFor(format);
			expect((await pool.query<{ state: string }>(sql, [4])).rows[0].state).toBe("READY");
			const result = await pool.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
				`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
				[4]
			);
			const phaseLoops: number[] = [];
			const visit = (node: Record<string, unknown>) => {
				if (node.Alias === "phase_publication") phaseLoops.push(Number(node["Actual Loops"]));
				for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
			};
			visit(result.rows[0]["QUERY PLAN"][0].Plan);
			expect(phaseLoops.length).toBeGreaterThan(0);
			expect(phaseLoops.every((loops) => loops === 0)).toBe(true);
			await pool.query(
				"UPDATE competition.tournament_review_publication_chunks SET chunk_sha256=repeat('0',64) WHERE event_id=4"
			);
			expect((await pool.query<{ state: string }>(sql, [4])).rows[0].state).toBe("DEGRADED");
		});
		it(`does not reuse a POINTS head for a ${format} phase at the same event`, async () => {
			await pool.query(
				"INSERT INTO competition.tournament_review_obligations VALUES(2026,1,4,$1,'READY',1)",
				[format]
			);
			expect((await pool.query<{ state: string }>(phaseQueryFor(format), [4])).rows[0].state).toBe(
				"DEGRADED"
			);
		});
	}
});
