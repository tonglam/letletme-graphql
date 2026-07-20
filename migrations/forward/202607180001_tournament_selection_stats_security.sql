-- The GraphQL service owns this read model and its security boundary.
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tournament_id, event_id, element_id)
);

ALTER TABLE public.tournament_selection_stats ENABLE ROW LEVEL SECURITY;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.tournament_selection_stats FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.tournament_selection_stats FROM authenticated;
  END IF;
END
$security$;

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_tournament_event
  ON public.tournament_selection_stats (tournament_id, event_id);

CREATE INDEX IF NOT EXISTS idx_tournament_selection_stats_pick_count
  ON public.tournament_selection_stats (tournament_id, event_id, pick_count DESC);
