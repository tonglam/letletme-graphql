-- Improve event_live_explains lookup performance.
-- Supports the frequent WHERE event_id = ? AND element_id = ? LIMIT 1 query.
CREATE INDEX IF NOT EXISTS idx_event_live_explains_event_element
  ON public.event_live_explains (event_id, element_id);
