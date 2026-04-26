#!/usr/bin/env bun

/**
 * One-time fix: backfill entry_infos baseline after adding last_event_id column.
 *
 * Reads current event from Redis (event:current), sets last_event_id = currentEvent - 1,
 * then fetches GW picks from the FPL API to populate overall_points, overall_rank,
 * team_value, and bank for that event.
 *
 * Usage:
 *   bun run scripts/fix-entry-infos-baseline.ts
 *
 * Environment:
 *   - SUPABASE_URL
 *   - SUPABASE_KEY (service role key)
 *   - REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 */

import { createClient } from '@supabase/supabase-js';
import { connectRedis } from '../src/infra/redis';

const FPL_BASE_URL = 'https://fantasy.premierleague.com/api';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

interface FPLPicksEntryHistory {
  event: number;
  points: number;
  total_points: number;
  rank: number;
  overall_rank: number;
  bank: number;
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
}

interface FPLPicksResponse {
  entry_history: FPLPicksEntryHistory | null;
}

async function fetchEventPicks(
  entryId: number,
  eventId: number,
): Promise<FPLPicksEntryHistory | null> {
  const res = await fetch(`${FPL_BASE_URL}/entry/${entryId}/event/${eventId}/picks/`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for entry ${entryId} event ${eventId}`);
  }
  const data: FPLPicksResponse = await res.json();
  return data.entry_history ?? null;
}

async function getCurrentEventId(): Promise<number> {
  const redis = await connectRedis();
  try {
    const raw = await redis.get('event:current');
    if (!raw) {
      throw new Error('event:current key not found in Redis');
    }
    const parsed = JSON.parse(raw) as { id?: unknown };
    const id = Number(parsed.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`Invalid event id in Redis: ${parsed.id}`);
    }
    return id;
  } finally {
    await redis.quit();
  }
}

async function main() {
  const currentEventId = await getCurrentEventId();
  const targetEventId = currentEventId - 1;

  console.log(`Current event from Redis: ${currentEventId} → target event: ${targetEventId}`);

  if (targetEventId <= 0) {
    console.error('Target event must be >= 1, aborting.');
    process.exit(1);
  }

  const { data: entries, error: fetchError } = await supabase
    .from('entry_infos')
    .select('id');

  if (fetchError) {
    console.error('Failed to fetch entries:', fetchError);
    process.exit(1);
  }

  if (!entries || entries.length === 0) {
    console.log('No entries found in entry_infos');
    return;
  }

  console.log(`Processing ${entries.length} entries...\n`);

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const entry of entries) {
    try {
      const history = await fetchEventPicks(entry.id, targetEventId);

      if (!history) {
        console.log(`Entry ${entry.id}: no picks for event ${targetEventId}, skipping`);
        skippedCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const { error: updateError } = await supabase
        .from('entry_infos')
        .update({
          overall_points: history.total_points,
          overall_rank: history.overall_rank,
          team_value: history.value,
          bank: history.bank,
          last_event_id: targetEventId,
        })
        .eq('id', entry.id);

      if (updateError) {
        console.error(`Entry ${entry.id}: update failed -`, updateError.message);
        errorCount++;
      } else {
        console.log(
          `Entry ${entry.id}: pts=${history.total_points} rank=${history.overall_rank} value=${history.value} bank=${history.bank}`,
        );
        successCount++;
      }
    } catch (err) {
      console.error(`Entry ${entry.id}: error -`, err instanceof Error ? err.message : err);
      errorCount++;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log('\n=== Summary ===');
  console.log(`Total:   ${entries.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Errors:  ${errorCount}`);

  // Verification
  console.log(`\n=== Sample verification (last_event_id = ${targetEventId}) ===`);

  const { data: sample, error: sampleError } = await supabase
    .from('entry_infos')
    .select('id, overall_points, overall_rank, bank, team_value, last_event_id')
    .eq('last_event_id', targetEventId)
    .limit(5);

  if (sampleError) {
    console.error('Verification query failed:', sampleError.message);
  } else {
    console.table(sample);
  }

  const { count, error: countError } = await supabase
    .from('entry_infos')
    .select('id', { count: 'exact', head: true })
    .eq('last_event_id', 0);

  if (countError) {
    console.error('Count query failed:', countError.message);
  } else {
    if ((count ?? 0) > 0) {
      console.warn(`⚠  ${count} rows still have last_event_id = 0`);
    } else {
      console.log('All rows updated (last_event_id = 0 count: 0)');
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
