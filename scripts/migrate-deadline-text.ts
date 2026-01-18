#!/usr/bin/env bun

/**
 * Migration: Convert events.deadline_time from TIMESTAMP to TEXT
 * Run this to store ISO 8601 strings directly
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

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
    console.log('📝 Running migration: 003_events_deadline_text.sql');

    // Read migration file
    const migrationPath = join(import.meta.dir, '../migrations/003_events_deadline_text.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');

    // Execute migration
    await client.query(migrationSQL);

    console.log('✅ Migration completed successfully');

    // Verify the change
    const result = await client.query(`
      SELECT 
        column_name, 
        data_type,
        col_description('events'::regclass, ordinal_position) as description
      FROM information_schema.columns
      WHERE table_name = 'events' 
      AND column_name = 'deadline_time'
    `);

    console.log('\n📊 Column updated:');
    result.rows.forEach((row) => {
      console.log(`  ✓ ${row.column_name}: ${row.data_type}`);
      if (row.description) {
        console.log(`    ${row.description}`);
      }
    });

    // Show sample data
    const sampleResult = await client.query(`
      SELECT id, name, deadline_time 
      FROM events 
      WHERE deadline_time IS NOT NULL
      LIMIT 3
    `);

    console.log('\n📄 Sample data:');
    sampleResult.rows.forEach((row) => {
      console.log(`  GW ${row.id}: ${row.deadline_time}`);
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
