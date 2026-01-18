#!/usr/bin/env bun

/**
 * Database Migration Script
 * Runs SQL migrations against the PostgreSQL database
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
    console.log('📝 Running migration: 001_auth_schema.sql');

    // Read migration file
    const migrationPath = join(import.meta.dir, '../migrations/001_auth_schema.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');

    // Execute migration
    await client.query(migrationSQL);

    console.log('✅ Migration completed successfully');

    // Verify tables were created
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('user', 'session', 'account', 'verification', 'device_sessions')
      ORDER BY table_name
    `);

    console.log('\n📊 Created tables:');
    result.rows.forEach((row) => {
      console.log(`  ✓ ${row.table_name}`);
    });

    client.release();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
