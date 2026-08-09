-- Keep foreign-key maintenance indexed independently of the tournament-scoped
-- primary key and reporting indexes.
CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_event
  ON public.tournament_selection_stats (event_id);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_element
  ON public.tournament_selection_stats (element_id);
