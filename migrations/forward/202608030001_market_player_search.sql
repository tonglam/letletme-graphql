-- Bounded, server-filtered player picker search. This keeps the Web client
-- from loading the full roster and exposes only the picker projection.

CREATE OR REPLACE FUNCTION public.search_players_for_picker(
  p_query text,
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
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    player.id,
    player.web_name,
    player.type AS element_type,
    player.team_id,
    team.name AS team_name,
    team.short_name AS team_short_name
  FROM public.players player
  JOIN public.teams team ON team.id = player.team_id
  WHERE player.id > COALESCE(p_cursor, 0)
    AND length(trim(p_query)) > 0
    AND strpos(lower(player.web_name), lower(trim(p_query))) > 0
  ORDER BY player.id ASC
  LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;

REVOKE ALL ON FUNCTION public.search_players_for_picker(text, integer, integer) FROM PUBLIC;

DO $permissions$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.search_players_for_picker(text, integer, integer) FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.search_players_for_picker(text, integer, integer)
      TO service_role;
  END IF;
END
$permissions$;
