\set ON_ERROR_STOP on

-- This fixture is deliberately owned by the GraphQL consumer. Data migrations
-- and Data's graphql-consumer-authority.sql establish producer-owned schema,
-- grants, current-season identity and the canonical Core publication. This
-- file supplies only the external Web-auth boundary and GraphQL login.
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $fn$ SELECT current_setting('request.jwt.claim.role', true) $fn$;

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
