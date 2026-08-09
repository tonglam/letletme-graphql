-- The selection read model is server-owned. Browser roles remain revoked by
-- 202607180001; the GraphQL/Supabase runtime role needs explicit read access
-- on fresh databases where table ACLs are not inherited from the owner.
GRANT SELECT ON TABLE public.tournament_selection_stats TO service_role;
