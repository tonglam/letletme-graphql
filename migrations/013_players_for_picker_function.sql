-- Optimised picker query: single JOIN + column projection + cursor pagination.
-- Returns only the columns the picker UI needs instead of SELECT *.
-- Uses cursor-based (keyset) pagination for O(1) lookups on deep pages.

CREATE OR REPLACE FUNCTION get_players_for_picker(
  p_limit  INT DEFAULT 20,
  p_cursor INT DEFAULT NULL
)
RETURNS TABLE (
  id                   INT,
  web_name             TEXT,
  position             SMALLINT,
  team_id              INT,
  team_name            TEXT,
  team_short_name      TEXT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    p.id,
    p.web_name,
    p.type       AS position,
    p.team_id,
    t.name       AS team_name,
    t.short_name AS team_short_name
  FROM public.players p
  JOIN public.teams t ON t.id = p.team_id
  WHERE p.id > COALESCE(p_cursor, 0)
  ORDER BY p.id ASC
  LIMIT LEAST(p_limit, 200);
$$;