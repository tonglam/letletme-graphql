-- Improve history lookup performance for playerValueHistory query.
-- Supports WHERE player_id = ? ORDER BY change_date DESC LIMIT ?
CREATE INDEX IF NOT EXISTS idx_player_values_player_id_change_date_desc
  ON public.player_values (player_id, change_date DESC);
