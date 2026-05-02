-- Add total_points column to players table if it doesn't exist.
-- The external FPL sync pipeline may or may not include this column.
-- This ensures the Supabase PostgREST queries that reference it don't fail.

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS total_points INTEGER DEFAULT 0;

-- Add player_id alias column to player_values if element_id exists but player_id doesn't.
-- The code now uses element_id, but we keep this as a safety net.
-- (No-op if column already exists.)

-- Ensure player_values has element_id (the actual column name used by FPL).
-- This is informational -- we already fixed the code to use element_id.