-- Clean up obsolete regular views that have been replaced by materialized views.
-- v_tournament_event_snapshot  → mv_tournament_event_snapshot
-- v_tournament_snapshot        → mv_tournament_snapshot
-- v_tournament_event_result    → KEPT (still used by getTournamentEventResults)

DROP VIEW IF EXISTS public.v_tournament_snapshot CASCADE;
DROP VIEW IF EXISTS public.v_tournament_event_snapshot CASCADE;
