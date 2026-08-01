import { afterAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";

const enabled = process.env.RUN_MIGRATION_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

suite("forward migration security", () => {
	afterAll(async () => pool.end());

	test("enables RLS, required indexes, and removes public API grants", async () => {
		const rls = await pool.query<{ relrowsecurity: boolean }>(
			"SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tournament_selection_stats'::regclass"
		);
		expect(rls.rows[0]?.relrowsecurity).toBe(true);

		const indexes = await pool.query<{ indexname: string }>(
			"SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tournament_selection_stats'"
		);
		const names = indexes.rows.map((row) => row.indexname);
		expect(names).toContain("idx_tournament_selection_stats_tournament_event");
		expect(names).toContain("idx_tournament_selection_stats_pick_count");

		for (const role of ["anon", "authenticated"]) {
			const grants = await pool.query<{ allowed: boolean }>(
				"SELECT has_table_privilege($1, 'public.tournament_selection_stats', 'SELECT,INSERT,UPDATE,DELETE') AS allowed",
				[role]
			);
			expect(grants.rows[0]?.allowed).toBe(false);
		}

		const functions = [
			"get_players_for_picker(integer,integer)",
			"get_captain_counts(integer,text,integer)",
			"get_pick_aggregation(integer,integer[])",
			"get_transfer_aggregation(integer,integer[])",
		];
		for (const name of functions) {
			const publicGrant = await pool.query<{ allowed: boolean }>(
				`SELECT EXISTS (
				   SELECT 1
				   FROM pg_proc routine
				   CROSS JOIN LATERAL aclexplode(
				     COALESCE(routine.proacl, acldefault('f', routine.proowner))
				   ) grant_row
				   WHERE routine.oid = to_regprocedure($1)
				     AND grant_row.grantee = 0
				     AND grant_row.privilege_type = 'EXECUTE'
				 ) AS allowed`,
				[`public.${name}`]
			);
			expect(publicGrant.rows[0]?.allowed).toBe(false);

			for (const role of ["anon", "authenticated"]) {
				const grants = await pool.query<{ allowed: boolean }>(
					"SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
					[role, `public.${name}`]
				);
				expect(grants.rows[0]?.allowed).toBe(false);
			}
			const serviceGrant = await pool.query<{ allowed: boolean }>(
				"SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS allowed",
				[`public.${name}`]
			);
			expect(serviceGrant.rows[0]?.allowed).toBe(true);
		}

		await expect(
			Promise.all([
				pool.query("SELECT * FROM public.get_players_for_picker(2, NULL)"),
				pool.query("SELECT * FROM public.get_captain_counts(1, 'classic', 1)"),
				pool.query("SELECT * FROM public.get_pick_aggregation(1, ARRAY[]::integer[])"),
				pool.query("SELECT * FROM public.get_transfer_aggregation(1, ARRAY[]::integer[])"),
			])
		).resolves.toHaveLength(4);
	});
});
