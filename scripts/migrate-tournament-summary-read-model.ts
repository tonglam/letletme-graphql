#!/usr/bin/env bun

/**
 * Apply tournament summary read-model migration.
 */

import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

async function runMigration(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_URL,
  });

  try {
    console.log('🔄 Connecting to database...');
    const client = await pool.connect();

    console.log('✅ Connected to database');
    console.log('📝 Running migration: 005_tournament_summary_read_model.sql');

    const migrationPath = join(import.meta.dir, '../migrations/005_tournament_summary_read_model.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');

    await client.query(migrationSQL);

    console.log('✅ Migration completed successfully');
    client.release();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
