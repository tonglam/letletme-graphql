-- Add last_event_id column to entry_infos to track which event the "last" values belong to
-- These "last" values are from the previous completed GW

ALTER TABLE entry_infos 
ADD COLUMN IF NOT EXISTS last_event_id integer DEFAULT 0;

-- Initialize last_event_id based on existing overall_points
-- If overall_points > 0, we assume they have history (set to a reasonable default like 0)
-- This will be properly populated by the ETL sync script after each GW
UPDATE entry_infos 
SET last_event_id = 0 
WHERE last_event_id IS NULL;
