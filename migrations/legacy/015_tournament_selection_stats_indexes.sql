-- Indexes to support tournament-scoped selection stats queries.

-- Fast lookup of captain_id counts per league per event
CREATE INDEX IF NOT EXISTS idx_league_event_results_captain_lookup
  ON public.league_event_results (league_id, league_type, event_id, captain_id);

-- Fast lookup of entry_event_results by event + batch of entry_ids
CREATE INDEX IF NOT EXISTS idx_entry_event_results_event_entry
  ON public.entry_event_results (event_id, entry_id);

-- Fast lookup of entry_event_transfers by event + batch of entry_ids
CREATE INDEX IF NOT EXISTS idx_entry_event_transfers_event_entry
  ON public.entry_event_transfers (event_id, entry_id);
