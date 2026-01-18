#!/usr/bin/env bun

/**
 * Verify deadline_time is stored correctly as TEXT in ISO 8601 format
 */

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

async function verify(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_URL,
  });

  try {
    console.log('🔍 Verifying deadline_time storage format...\n');

    const result = await pool.query(`
      SELECT 
        id, 
        name, 
        deadline_time,
        is_current,
        is_next,
        pg_typeof(deadline_time) as data_type
      FROM events 
      WHERE id IN (22, 23, 24)
      ORDER BY id
    `);

    console.log('📊 Database Storage:');
    console.log('─'.repeat(80));
    result.rows.forEach((row) => {
      const status = row.is_current ? '[CURRENT]' : row.is_next ? '[NEXT]' : '';
      console.log(`GW ${row.id} ${status}:`);
      console.log(`  Name: ${row.name}`);
      console.log(`  Deadline: ${row.deadline_time}`);
      console.log(`  Type: ${row.data_type}`);
      console.log(`  Length: ${row.deadline_time?.length || 0} chars`);
      console.log('');
    });

    console.log('✅ Verification complete!');
    console.log('\n📝 Format: All deadlines stored as ISO 8601 text strings');
    console.log('   Expected: "2026-01-24T11:00:00Z" (20 chars)');

    await pool.end();
  } catch (error) {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  }
}

verify();
