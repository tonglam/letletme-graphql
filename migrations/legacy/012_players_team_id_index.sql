-- Add index on players.team_id for efficient JOIN resolution.
-- The players picker query joins players ↔ teams on team_id,
-- and the N+1-safe team lookup also benefits from this index.
CREATE INDEX IF NOT EXISTS idx_players_team_id ON public.players(team_id);
