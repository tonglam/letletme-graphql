DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS public.events (id INT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.teams (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public.players (
  id INT PRIMARY KEY,
  web_name TEXT NOT NULL,
  type INT NOT NULL,
  team_id INT NOT NULL REFERENCES public.teams(id)
);
CREATE TABLE IF NOT EXISTS public.tournament_infos (id INT PRIMARY KEY);

DO $types$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public' AND type.typname = 'league_type'
  ) THEN
    CREATE TYPE public.league_type AS ENUM ('classic', 'h2h');
  END IF;
END
$types$;

CREATE TABLE IF NOT EXISTS public.league_event_results (
  league_id INT NOT NULL,
  league_type public.league_type NOT NULL,
  event_id INT NOT NULL,
  captain_id INT
);
CREATE TABLE IF NOT EXISTS public.entry_event_results (
  entry_id INT NOT NULL,
  event_id INT NOT NULL,
  event_picks JSONB
);
CREATE TABLE IF NOT EXISTS public.entry_event_transfers (
  entry_id INT NOT NULL,
  event_id INT NOT NULL,
  element_in_id INT,
  element_out_id INT
);
