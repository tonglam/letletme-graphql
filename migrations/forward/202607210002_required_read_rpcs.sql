-- GraphQL calls these read-only RPCs through Supabase using a server-side
-- service_role credential. Keep the executable surface explicit: browser JWT
-- roles cannot invoke these functions and the functions run as the caller.

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
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    p.id,
    p.web_name,
    p.type AS element_type,
    p.team_id,
    t.name AS team_name,
    t.short_name AS team_short_name
  FROM public.players p
  JOIN public.teams t ON t.id = p.team_id
  WHERE p.id > COALESCE(p_cursor, 0)
  ORDER BY p.id ASC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$function$;

CREATE OR REPLACE FUNCTION public.get_captain_counts(
  p_league_id integer,
  p_league_type text,
  p_event_id integer
)
RETURNS TABLE (
  captain_id integer,
  count bigint,
  total_entries bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  WITH matched AS (
    SELECT result.captain_id
    FROM public.league_event_results result
    WHERE result.league_id = p_league_id
      AND result.league_type::text = p_league_type
      AND result.event_id = p_event_id
  ),
  totals AS (
    SELECT COUNT(*) AS total_entries FROM matched
  )
  SELECT matched.captain_id, COUNT(*) AS count, totals.total_entries
  FROM matched
  CROSS JOIN totals
  WHERE matched.captain_id IS NOT NULL
  GROUP BY matched.captain_id, totals.total_entries;
$function$;

CREATE OR REPLACE FUNCTION public.get_pick_aggregation(
  p_event_id integer,
  p_entry_ids integer[]
)
RETURNS TABLE (
  element_id integer,
  pick_count bigint,
  vice_captain_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    expanded.element_id,
    COUNT(*) AS pick_count,
    COUNT(*) FILTER (
      WHERE expanded.pick ->> 'isViceCaptain' = 'true'
         OR expanded.pick ->> 'is_vice_captain' = 'true'
         OR expanded.pick ->> 'viceCaptain' = 'true'
    ) AS vice_captain_count
  FROM (
    SELECT
      COALESCE(
        (pick ->> 'element')::integer,
        (pick ->> 'element_id')::integer
      ) AS element_id,
      pick
    FROM public.entry_event_results result,
      LATERAL jsonb_array_elements(COALESCE(result.event_picks, '[]'::jsonb)) AS pick
    WHERE result.event_id = p_event_id
      AND result.entry_id = ANY(p_entry_ids)
  ) expanded
  WHERE expanded.element_id IS NOT NULL
  GROUP BY expanded.element_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_transfer_aggregation(
  p_event_id integer,
  p_entry_ids integer[]
)
RETURNS TABLE (
  element_id integer,
  transfer_in_count bigint,
  transfer_out_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    COALESCE(incoming.element_id, outgoing.element_id) AS element_id,
    incoming.count AS transfer_in_count,
    outgoing.count AS transfer_out_count
  FROM (
    SELECT transfer.element_in_id AS element_id, COUNT(*) AS count
    FROM public.entry_event_transfers transfer
    WHERE transfer.event_id = p_event_id
      AND transfer.entry_id = ANY(p_entry_ids)
      AND transfer.element_in_id IS NOT NULL
    GROUP BY transfer.element_in_id
  ) incoming
  FULL OUTER JOIN (
    SELECT transfer.element_out_id AS element_id, COUNT(*) AS count
    FROM public.entry_event_transfers transfer
    WHERE transfer.event_id = p_event_id
      AND transfer.entry_id = ANY(p_entry_ids)
      AND transfer.element_out_id IS NOT NULL
    GROUP BY transfer.element_out_id
  ) outgoing ON incoming.element_id = outgoing.element_id;
$function$;

REVOKE ALL ON FUNCTION public.get_players_for_picker(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_captain_counts(integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_pick_aggregation(integer, integer[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_transfer_aggregation(integer, integer[]) FROM PUBLIC;

DO $permissions$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.get_players_for_picker(integer, integer) FROM %I',
        client_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.get_captain_counts(integer, text, integer) FROM %I',
        client_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.get_pick_aggregation(integer, integer[]) FROM %I',
        client_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.get_transfer_aggregation(integer, integer[]) FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_players_for_picker(integer, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.get_captain_counts(integer, text, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.get_pick_aggregation(integer, integer[]) TO service_role;
    GRANT EXECUTE ON FUNCTION public.get_transfer_aggregation(integer, integer[]) TO service_role;
  END IF;
END
$permissions$;
