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
  type SMALLINT NOT NULL,
  team_id INT NOT NULL REFERENCES public.teams(id)
);

-- The production player contract includes the current FPL price. Keep the
-- migration-test fixture aligned so price-aware picker migrations can be
-- applied against the minimal bootstrap schema as well.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS price INT NOT NULL DEFAULT 0;

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
  element_in_cost INT,
  element_out_id INT,
  element_out_cost INT
);

-- Domain tables are owned by letletme_data; keep this migration-test fixture
-- aligned with its existing entry_event_transfers cost columns. These ALTERs
-- also repair a reused local test database created by an older bootstrap.
ALTER TABLE public.entry_event_transfers
  ADD COLUMN IF NOT EXISTS element_in_cost INT,
  ADD COLUMN IF NOT EXISTS element_out_cost INT;

-- Production databases may already have the historical picker function. The
-- forward migration must preserve its SMALLINT row type so CREATE OR REPLACE
-- succeeds without a destructive drop.
CREATE OR REPLACE FUNCTION public.get_players_for_picker(
  p_limit integer DEFAULT 20,
  p_cursor integer DEFAULT NULL
)
RETURNS TABLE (
  id integer,
  web_name text,
  element_type smallint,
  team_id integer,
  team_name text,
  team_short_name text
)
LANGUAGE sql
STABLE
AS $function$
  SELECT
    p.id,
    p.web_name,
    p.type,
    p.team_id,
    t.name,
    t.short_name
  FROM public.players p
  JOIN public.teams t ON t.id = p.team_id
  WHERE p.id > COALESCE(p_cursor, 0)
  ORDER BY p.id ASC
  LIMIT LEAST(p_limit, 200);
$function$;
