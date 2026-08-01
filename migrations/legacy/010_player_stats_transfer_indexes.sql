-- Improve top-transfers query performance by avoiding seq scans on player_stats.
-- Supports ORDER BY transfers_in_event DESC LIMIT ? and transfers_out_event DESC LIMIT ?
CREATE INDEX IF NOT EXISTS idx_player_stats_event_transfers_in
  ON public.player_stats (event_id, transfers_in_event DESC);

CREATE INDEX IF NOT EXISTS idx_player_stats_event_transfers_out
  ON public.player_stats (event_id, transfers_out_event DESC);
