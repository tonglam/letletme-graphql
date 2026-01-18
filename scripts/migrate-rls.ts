#!/usr/bin/env bun

/**
 * Apply RLS Policies to Authentication Tables
 * Run this after the auth schema migration
 */

import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

async function applyRlsPolicies(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_URL,
  });

  try {
    console.log('🔄 Connecting to database...');
    const client = await pool.connect();

    console.log('✅ Connected to database');
    console.log('🔐 Applying RLS policies to auth tables...');

    // Read migration file
    const migrationPath = join(import.meta.dir, '../migrations/002_auth_rls_policies.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');

    // Execute migration
    await client.query(migrationSQL);

    console.log('✅ RLS policies applied successfully');

    // Verify RLS is enabled
    const result = await client.query(`
      SELECT 
        schemaname,
        tablename,
        rowsecurity
      FROM pg_tables 
      WHERE schemaname = 'public'
      AND tablename IN ('user', 'session', 'account', 'verification', 'device_sessions')
      ORDER BY tablename
    `);

    console.log('\n🔒 RLS Status:');
    result.rows.forEach((row) => {
      const status = row.rowsecurity ? '✓ Enabled' : '✗ Disabled';
      console.log(`  ${status} - ${row.tablename}`);
    });

    // Count policies
    const policiesResult = await client.query(`
      SELECT 
        tablename,
        COUNT(*) as policy_count
      FROM pg_policies
      WHERE schemaname = 'public'
      AND tablename IN ('user', 'session', 'account', 'verification', 'device_sessions')
      GROUP BY tablename
      ORDER BY tablename
    `);

    console.log('\n📋 Policies Created:');
    policiesResult.rows.forEach((row) => {
      console.log(`  ${row.tablename}: ${row.policy_count} policies`);
    });

    const totalPolicies = policiesResult.rows.reduce((sum, row) => sum + parseInt(row.policy_count), 0);
    console.log(`\n✅ Total: ${totalPolicies} policies applied`);

    client.release();
  } catch (error) {
    console.error('❌ RLS migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

applyRlsPolicies();
