-- The public league trends catalog is read through the direct GraphQL pool,
-- whose login is intentionally separate from the migration/DDL login.  The
-- migration runner sets this session value from the runtime DATABASE_URL so
-- the grant remains least-privilege and is never widened to PUBLIC.
DO $grant$
DECLARE
  runtime_role text := current_setting('letletme.runtime_db_role', true);
BEGIN
  IF runtime_role IS NULL OR btrim(runtime_role) = '' THEN
    RAISE EXCEPTION 'runtime database role is required to grant catalog read access';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime database role % does not exist', runtime_role;
  END IF;

  EXECUTE format(
    'GRANT SELECT ON TABLE public.public_league_trends_catalog TO %I',
    runtime_role
  );
END
$grant$;
