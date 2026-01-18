#!/usr/bin/env bun

/**
 * Drop authentication tables
 */

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

async function dropTables(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_URL,
  });

  try {
    console.log('🔄 Connecting to database...');
    const client = await pool.connect();

    console.log('✅ Connected to database');
    console.log('🗑️  Dropping auth tables...');

    const dropSQL = `
      DROP TABLE IF EXISTS device_sessions CASCADE;
      DROP TABLE IF EXISTS verification CASCADE;
      DROP TABLE IF EXISTS account CASCADE;
      DROP TABLE IF EXISTS session CASCADE;
      DROP TABLE IF EXISTS "user" CASCADE;
    `;

    await client.query(dropSQL);

    console.log('✅ Tables dropped successfully');

    client.release();
  } catch (error) {
    console.error('❌ Drop failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

dropTables();
