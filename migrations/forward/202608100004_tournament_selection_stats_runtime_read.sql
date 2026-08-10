-- The public trends repository reads this server-owned model through the
-- direct GraphQL pool. Grant the current runtime role without widening access
-- to browser roles or PUBLIC.
DO $grant$
DECLARE
  runtime_role text := current_setting('letletme.runtime_db_role', true);
BEGIN
  IF runtime_role IS NULL OR btrim(runtime_role) = '' THEN
    RAISE EXCEPTION 'runtime database role is required to grant selection-stat read access';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime database role % does not exist', runtime_role;
  END IF;

  EXECUTE format(
    'GRANT SELECT ON TABLE public.tournament_selection_stats TO %I',
    runtime_role
  );

  EXECUTE 'DROP POLICY IF EXISTS tournament_selection_stats_runtime_read
    ON public.tournament_selection_stats';
  EXECUTE format(
    'CREATE POLICY tournament_selection_stats_runtime_read
       ON public.tournament_selection_stats
       FOR SELECT TO %I USING (
         EXISTS (
           SELECT 1
           FROM public.public_league_trends_catalog catalog
           WHERE catalog.tournament_id = tournament_selection_stats.tournament_id
             AND catalog.enabled = true
         )
       )',
    runtime_role
  );
END
$grant$;
