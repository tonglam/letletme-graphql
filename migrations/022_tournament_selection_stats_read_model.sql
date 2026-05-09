-- Persisted read model for GraphQL tournamentSelectionStats.
-- Selection and transfer data is immutable after a gameweek is synced, so reads
-- should not repeat JSON/RPC aggregation on every GraphQL request.

CREATE TABLE IF NOT EXISTS public.tournament_selection_stats (
  tournament_id INT NOT NULL REFERENCES public.tournament_infos(id) ON DELETE CASCADE,
  event_id INT NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  element_id INT NOT NULL REFERENCES public.players(id),
  pick_count INT NOT NULL DEFAULT 0,
  captain_count INT NOT NULL DEFAULT 0,
  vice_captain_count INT NOT NULL DEFAULT 0,
  transfer_in_count INT NOT NULL DEFAULT 0,
  transfer_out_count INT NOT NULL DEFAULT 0,
  total_entries INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tournament_selection_stats_pkey
    PRIMARY KEY (tournament_id, event_id, element_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_tournament_event
  ON public.tournament_selection_stats (tournament_id, event_id);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_pick_count
  ON public.tournament_selection_stats (tournament_id, event_id, pick_count DESC);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_captain_count
  ON public.tournament_selection_stats (tournament_id, event_id, captain_count DESC);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_vice_captain_count
  ON public.tournament_selection_stats (tournament_id, event_id, vice_captain_count DESC);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_transfer_in_count
  ON public.tournament_selection_stats (tournament_id, event_id, transfer_in_count DESC);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_transfer_out_count
  ON public.tournament_selection_stats (tournament_id, event_id, transfer_out_count DESC);
