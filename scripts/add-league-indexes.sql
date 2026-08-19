-- Database migration script to add indexes for league queries optimization.
-- 
-- This script adds indexes to improve performance of league-related queries:
-- 1. entry_leagues: composite index on (entry_id, league_type)
-- 2. tournaments: index on league_id for JOIN operations
--
-- Run this script against your PostgreSQL database:
-- psql -d your_database_name -f scripts/add-league-indexes.sql
--
-- Note: These indexes are created with CONCURRENTLY to avoid locking the tables
-- during index creation. This means the indexes will be built without blocking
-- other operations on the tables.

-- 1. Add composite index on entry_leagues for (entry_id, league_type)
-- This optimizes queries that filter by entry_id and optionally by league_type
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entry_leagues_entry_id_league_type 
ON competition.entry_leagues (entry_id, league_type);

-- 2. Add index on tournaments.league_id for JOIN operations
-- This optimizes the LEFT JOIN with entry_leagues
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournaments_league_id 
ON competition.tournaments (league_id);

-- 3. Add composite index on entry_leagues for season_id queries
-- This optimizes the read-model queries that filter by season_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entry_leagues_season_id_entry_id 
ON competition.entry_leagues (season_id, entry_id);

-- 4. Add index on tournaments for season_id queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournaments_season_id_league_id 
ON competition.tournaments (season_id, league_id);

-- Verify indexes were created
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes 
WHERE tablename IN ('entry_leagues', 'tournaments')
    AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;
