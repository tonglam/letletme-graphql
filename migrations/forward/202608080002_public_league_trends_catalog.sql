-- Operator-managed allowlist for the public league trends read model.
-- Data owns tournament_selection_stats; GraphQL owns this public catalog and
-- only publishes rows that are explicitly enabled.
CREATE TABLE IF NOT EXISTS public.public_league_trends_catalog (
  tournament_id integer PRIMARY KEY REFERENCES public.tournament_infos(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.touch_public_league_trends_catalog_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS public_league_trends_catalog_touch_updated_at
  ON public.public_league_trends_catalog;

CREATE TRIGGER public_league_trends_catalog_touch_updated_at
BEFORE UPDATE ON public.public_league_trends_catalog
FOR EACH ROW
EXECUTE FUNCTION public.touch_public_league_trends_catalog_updated_at();

CREATE INDEX IF NOT EXISTS idx_public_league_trends_catalog_enabled_order
  ON public.public_league_trends_catalog (enabled, sort_order, tournament_id);

ALTER TABLE public.public_league_trends_catalog ENABLE ROW LEVEL SECURITY;

DO $security$
DECLARE
  client_role text;
BEGIN
  REVOKE ALL ON TABLE public.public_league_trends_catalog FROM PUBLIC;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.public_league_trends_catalog FROM %I',
        client_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON TABLE public.public_league_trends_catalog TO service_role;
  END IF;
END
$security$;
