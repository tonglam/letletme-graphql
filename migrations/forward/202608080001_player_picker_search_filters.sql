-- Keep search pagination correct when the picker combines text search with
-- position, team, or price filters. The original three-argument function is
-- retained for existing callers; this overload is the server-filtered path
-- used by GraphQL.
CREATE OR REPLACE FUNCTION public.search_players_for_picker(
  p_query text,
  p_limit integer,
  p_cursor integer,
  p_position integer,
  p_team_id integer,
  p_min_price integer,
  p_max_price integer
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
    player.type::smallint AS element_type,
    player.team_id,
    team.name AS team_name,
    team.short_name AS team_short_name
  FROM public.players player
  JOIN public.teams team ON team.id = player.team_id
  WHERE player.id > COALESCE(p_cursor, 0)
    AND length(trim(p_query)) > 0
    AND strpos(lower(player.web_name), lower(trim(p_query))) > 0
    AND (p_position IS NULL OR player.type = p_position)
    AND (p_team_id IS NULL OR player.team_id = p_team_id)
    AND (p_min_price IS NULL OR player.price >= p_min_price)
    AND (p_max_price IS NULL OR player.price <= p_max_price)
  ORDER BY player.id ASC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$function$;

REVOKE ALL ON FUNCTION public.search_players_for_picker(text, integer, integer, integer, integer, integer, integer) FROM PUBLIC;

DO $permissions$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.search_players_for_picker(text, integer, integer, integer, integer, integer, integer) FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.search_players_for_picker(text, integer, integer, integer, integer, integer, integer)
      TO service_role;
  END IF;
END
$permissions$;
