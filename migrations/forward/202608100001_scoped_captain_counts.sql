-- Scope tournament captain exposure to the tournament's membership rather
-- than aggregating every manager in the underlying FPL league.
CREATE OR REPLACE FUNCTION public.get_captain_counts_for_entries(
  p_event_id integer,
  p_entry_ids integer[]
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
    WHERE result.event_id = p_event_id
      AND result.entry_id = ANY(COALESCE(p_entry_ids, ARRAY[]::integer[]))
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

REVOKE ALL ON FUNCTION public.get_captain_counts_for_entries(integer, integer[]) FROM PUBLIC;

DO $permissions$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.get_captain_counts_for_entries(integer, integer[]) FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_captain_counts_for_entries(integer, integer[]) TO service_role;
  END IF;
END
$permissions$;
