-- Change events.deadline_time from TIMESTAMP to TEXT
-- This allows storing ISO 8601 strings directly: "2026-01-24T11:00:00Z"

-- Convert existing timestamp data to ISO 8601 text format
ALTER TABLE events 
ALTER COLUMN deadline_time TYPE TEXT 
USING to_char(deadline_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

-- Add comment explaining the format
COMMENT ON COLUMN events.deadline_time IS 'ISO 8601 datetime string in UTC (e.g., "2026-01-24T11:00:00Z")';
