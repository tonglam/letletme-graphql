#!/usr/bin/env bun
/**
 * Database migration script to add indexes for league queries optimization.
 * 
 * This script adds indexes to improve performance of league-related queries:
 * 1. entry_leagues: composite index on (entry_id, league_type)
 * 2. tournaments: index on league_id for JOIN operations
 * 
 * Run with: bun scripts/add-league-indexes.ts
 */

import { database } from "../src/infra/database";
import { logger } from "../src/infra/logger";

async function addLeagueIndexes() {
  logger.info("Starting league indexes migration...");

  try {
    // 1. Add composite index on entry_leagues for (entry_id, league_type)
    // This optimizes queries that filter by entry_id and optionally by league_type
    logger.info("Adding composite index on entry_leagues (entry_id, league_type)...");
    await database.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entry_leagues_entry_id_league_type 
      ON competition.entry_leagues (entry_id, league_type)
    `);
    logger.info("✓ Added idx_entry_leagues_entry_id_league_type");

    // 2. Add index on tournaments.league_id for JOIN operations
    // This optimizes the LEFT JOIN with entry_leagues
    logger.info("Adding index on tournaments.league_id...");
    await database.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournaments_league_id 
      ON competition.tournaments (league_id)
    `);
    logger.info("✓ Added idx_tournaments_league_id");

    // 3. Add composite index on entry_leagues for season_id queries
    // This optimizes the read-model queries that filter by season_id
    logger.info("Adding composite index on entry_leagues (season_id, entry_id)...");
    await database.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entry_leagues_season_id_entry_id 
      ON competition.entry_leagues (season_id, entry_id)
    `);
    logger.info("✓ Added idx_entry_leagues_season_id_entry_id");

    // 4. Add index on tournaments for season_id queries
    logger.info("Adding index on tournaments (season_id, league_id)...");
    await database.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournaments_season_id_league_id 
      ON competition.tournaments (season_id, league_id)
    `);
    logger.info("✓ Added idx_tournaments_season_id_league_id");

    logger.info("League indexes migration completed successfully!");
    logger.info("");
    logger.info("Summary of added indexes:");
    logger.info("1. idx_entry_leagues_entry_id_league_type - Optimizes entry league queries by type");
    logger.info("2. idx_tournaments_league_id - Optimizes JOIN operations with tournaments");
    logger.info("3. idx_entry_leagues_season_id_entry_id - Optimizes read-model season queries");
    logger.info("4. idx_tournaments_season_id_league_id - Optimizes tournament season queries");

  } catch (error) {
    logger.error({ err: error }, "Failed to add league indexes");
    throw error;
  } finally {
    await database.end();
  }
}

// Run the migration
addLeagueIndexes()
  .then(() => {
    logger.info("Migration completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ err: error }, "Migration failed");
    process.exit(1);
  });
