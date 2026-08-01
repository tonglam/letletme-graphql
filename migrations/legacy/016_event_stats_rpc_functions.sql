-- RPC functions for tournament selection stats aggregation.
-- Moves heavy aggregation from Node.js to PostgreSQL for better performance.
-- Reduces ~22 queries per request to ~5 by eliminating batched fetches and JS-side counting.

-- 1. Captain counts: GROUP BY aggregation instead of fetching all rows into JS
CREATE OR REPLACE FUNCTION get_captain_counts(
  p_league_id INT,
  p_league_type TEXT,
  p_event_id INT
)
RETURNS TABLE (
  captain_id INT,
  count BIGINT,
  total_entries BIGINT
)
LANGUAGE sql STABLE
AS $$
  WITH matched AS (
    SELECT captain_id
    FROM public.league_event_results
    WHERE league_id = p_league_id
      AND league_type = p_league_type
      AND event_id = p_event_id
  ),
  totals AS (
    SELECT COUNT(*) AS total_entries FROM matched
  )
  SELECT captain_id, COUNT(*) AS count, t.total_entries
  FROM matched
  CROSS JOIN totals t
  WHERE captain_id IS NOT NULL
  GROUP BY captain_id, t.total_entries;
$$;

-- 2. Pick aggregation: jsonb_array_elements + GROUP BY instead of batched JS parsing
CREATE OR REPLACE FUNCTION get_pick_aggregation(
  p_event_id INT,
  p_entry_ids INT[]
)
RETURNS TABLE (
  element_id INT,
  pick_count BIGINT,
  vice_captain_count BIGINT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    element_id,
    COUNT(*) AS pick_count,
    COUNT(*) FILTER (
      WHERE pick ->> 'isViceCaptain' = 'true'
         OR pick ->> 'is_vice_captain' = 'true'
         OR pick ->> 'viceCaptain' = 'true'
    ) AS vice_captain_count
  FROM (
    SELECT
      COALESCE(
        (pick ->> 'element')::INT,
        (pick ->> 'element_id')::INT
      ) AS element_id,
      pick
    FROM public.entry_event_results eer,
      LATERAL jsonb_array_elements(COALESCE(eer.event_picks, '[]'::jsonb)) AS pick
    WHERE eer.event_id = p_event_id
      AND eer.entry_id = ANY(p_entry_ids)
  ) sub
  WHERE element_id IS NOT NULL
  GROUP BY element_id;
$$;

-- 3. Transfer aggregation: GROUP BY instead of batched JS counting
CREATE OR REPLACE FUNCTION get_transfer_aggregation(
  p_event_id INT,
  p_entry_ids INT[]
)
RETURNS TABLE (
  element_id INT,
  transfer_in_count BIGINT,
  transfer_out_count BIGINT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    COALESCE(ins.element_id, outs.element_id) AS element_id,
    ins.cnt AS transfer_in_count,
    outs.cnt AS transfer_out_count
  FROM (
    SELECT element_in_id AS element_id, COUNT(*) AS cnt
    FROM public.entry_event_transfers
    WHERE event_id = p_event_id
      AND entry_id = ANY(p_entry_ids)
      AND element_in_id IS NOT NULL
    GROUP BY element_in_id
  ) ins
  FULL OUTER JOIN (
    SELECT element_out_id AS element_id, COUNT(*) AS cnt
    FROM public.entry_event_transfers
    WHERE event_id = p_event_id
      AND entry_id = ANY(p_entry_ids)
      AND element_out_id IS NOT NULL
    GROUP BY element_out_id
  ) outs ON ins.element_id = outs.element_id;
$$;

-- 4. Missing index for tournament_entries lookup
CREATE INDEX IF NOT EXISTS idx_tournament_entries_tournament_id
  ON public.tournament_entries (tournament_id);
