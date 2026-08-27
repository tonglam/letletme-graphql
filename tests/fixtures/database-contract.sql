\set ON_ERROR_STOP on

-- This fixture is deliberately owned by the GraphQL consumer. Data migrations
-- establish the producer schema and grants; this file supplies only the
-- external Web-auth boundary plus the minimum authoritative rows needed to
-- execute GraphQL's real startup contract against a disposable PostgreSQL 15
-- database.
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $fn$ SELECT current_setting('request.jwt.claim.role', true) $fn$;

UPDATE fpl.seasons
SET is_current = FALSE
WHERE is_current;

INSERT INTO fpl.seasons (
  season_id,
  season_code,
  display_name,
  start_year,
  end_year,
  lifecycle_state,
  is_current
) VALUES (
  2026,
  '2627',
  '2026/27',
  2026,
  2027,
  'preseason',
  TRUE
)
ON CONFLICT (season_id) DO UPDATE
SET
  season_code = EXCLUDED.season_code,
  display_name = EXCLUDED.display_name,
  start_year = EXCLUDED.start_year,
  end_year = EXCLUDED.end_year,
  lifecycle_state = EXCLUDED.lifecycle_state,
  is_current = TRUE,
  updated_at = now();

UPDATE ops.dataset_publications
SET status = 'superseded', updated_at = now()
WHERE dataset = 'fpl:core'
  AND season_id = 2026
  AND event_id IS NULL
  AND status = 'active'
  AND publication_id <> '00000000-0000-4000-8000-000000000007'::uuid;

INSERT INTO ops.dataset_publications (
  publication_id,
  dataset,
  season_id,
  event_id,
  revision,
  status,
  manifest,
  activated_at
) VALUES (
  '00000000-0000-4000-8000-000000000007',
  'fpl:core',
  2026,
  NULL,
  7,
  'active',
  jsonb_build_object(
    'dataset', 'fpl:core',
    'seasonCode', '2627',
    'eventId', NULL,
    'revision', 7,
    'publicationId', '00000000-0000-4000-8000-000000000007',
    'sourceCheckedAt', '2026-08-10T00:00:00.000Z',
    'publishedAt', '2026-08-10T00:00:01.000Z',
    'state', 'active',
    'items', jsonb_build_array(
      jsonb_build_object('name', 'events', 'key', 'llm:data:fpl:core:2627:7:events', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'teams', 'key', 'llm:data:fpl:core:2627:7:teams', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'players', 'key', 'llm:data:fpl:core:2627:7:players', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'phases', 'key', 'llm:data:fpl:core:2627:7:phases', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'fixtures', 'key', 'llm:data:fpl:core:2627:7:fixtures', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'currentEventId', 'key', 'llm:data:fpl:core:2627:7:currentEventId', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64))
    )
  ),
  now()
)
ON CONFLICT (publication_id) DO UPDATE
SET
  status = 'active',
  manifest = EXCLUDED.manifest,
  activated_at = now(),
  updated_at = now();

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM ops.dataset_publications publication
    JOIN fpl.seasons season ON season.season_id = publication.season_id
    WHERE publication.dataset = 'fpl:core'
      AND publication.event_id IS NULL
      AND publication.status = 'active'
      AND season.is_current
      AND jsonb_array_length(publication.manifest -> 'items') = 6
  ) <> 1 THEN
    RAISE EXCEPTION 'expected one canonical core publication fixture';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS bauth;
CREATE TABLE IF NOT EXISTS bauth."user" (
  id text PRIMARY KEY,
  email text,
  fpl_entry_id integer,
  fpl_entry_verified_at timestamptz
);
CREATE TABLE IF NOT EXISTS bauth.mini_program_session (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text,
  token_hash text NOT NULL,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  device_id text
);
CREATE TABLE IF NOT EXISTS bauth.mini_program_account (
  id text PRIMARY KEY,
  openid text NOT NULL,
  unionid text,
  linked_web_user_id text,
  follow_entry_id integer,
  entry_choice text,
  entry_choice_mini_entry_id integer,
  entry_choice_web_entry_id integer
);
REVOKE ALL ON SCHEMA bauth FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA bauth FROM PUBLIC;
REVOKE ALL ON bauth."user", bauth.mini_program_session, bauth.mini_program_account
  FROM letletme_graphql_reader;
GRANT USAGE ON SCHEMA bauth TO letletme_graphql_reader;
GRANT SELECT (id, fpl_entry_id, fpl_entry_verified_at)
  ON bauth."user" TO letletme_graphql_reader;
GRANT SELECT (user_id, account_id, token_hash, revoked_at, expires_at)
  ON bauth.mini_program_session TO letletme_graphql_reader;
GRANT SELECT (
  id,
  linked_web_user_id,
  follow_entry_id,
  entry_choice,
  entry_choice_mini_entry_id,
  entry_choice_web_entry_id
)
  ON bauth.mini_program_account TO letletme_graphql_reader;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graphql_ci') THEN
    CREATE ROLE graphql_ci LOGIN PASSWORD 'graphql_ci'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE graphql_ci
  LOGIN PASSWORD 'graphql_ci'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT letletme_graphql_reader TO graphql_ci;
