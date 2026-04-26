#!/usr/bin/env bun

/**
 * Sync entry_infos with previous GW data from FPL API
 * 
 * This script should run AFTER GW deadline passes (before next GW starts)
 * e.g., after GW 34 deadline, before GW 35 starts - it stores GW 34 data
 * 
 * The "last" fields (overall_points, overall_rank, team_value, bank) in entry_infos
 * represent the previous completed GW's data, which is used for liveTotalPoints calculation.
 * 
 * Usage: 
 *   bun run scripts/sync-entry-baseline.ts
 * 
 * Environment:
 *   - SUPABASE_URL
 *   - SUPABASE_KEY (service role key)
 */

import { createClient } from '@supabase/supabase-js';

const FPL_BASE_URL = 'https://fantasy.premierleague.com/api';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

interface FPLHistoryEntry {
  event: number;
  points: number;
  total_points: number;
  rank: number;
  overall_rank: number;
  bank: number;
  value: number;
}

async function fetchFPLHistory(entryId: number): Promise<FPLHistoryEntry[]> {
  const res = await fetch(`${FPL_BASE_URL}/entry/${entryId}/history/`);
  if (!res.ok) {
    throw new Error(`Failed to fetch FPL history for entry ${entryId}: ${res.status}`);
  }
  const data = await res.json();
  return data.current || [];
}

async function main() {
  console.log('Fetching all entries from entry_infos...');
  
  const { data: entries, error } = await supabase
    .from('entry_infos')
    .select('id');

  if (error) {
    console.error('Failed to fetch entries:', error);
    process.exit(1);
  }

  if (!entries || entries.length === 0) {
    console.log('No entries found in entry_infos');
    return;
  }

  console.log(`Processing ${entries.length} entries...`);
  
  let successCount = 0;
  let errorCount = 0;
  let skipCount = 0;

  for (const entry of entries) {
    try {
      const history = await fetchFPLHistory(entry.id);
      
      if (history.length < 2) {
        console.log(`Entry ${entry.id}: Not enough history (${history.length} events), skipping`);
        skipCount++;
        continue;
      }
      
      const currentEvent = history[history.length - 1];
      const previousEvent = history[history.length - 2];
      
      console.log(
        `Entry ${entry.id}: Current GW ${currentEvent.event}, Previous GW ${previousEvent.event} ` +
        `(pts: ${previousEvent.total_points}, rank: ${previousEvent.overall_rank})`
      );

      const { error: updateError } = await supabase
        .from('entry_infos')
        .update({
          overall_points: previousEvent.total_points,
          overall_rank: previousEvent.overall_rank,
          team_value: previousEvent.value,
          bank: previousEvent.bank,
          last_event_id: previousEvent.event,
        })
        .eq('id', entry.id);

      if (updateError) {
        console.error(`Entry ${entry.id}: Failed to update -`, updateError);
        errorCount++;
      } else {
        successCount++;
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (err) {
      console.error(`Entry ${entry.id}: Error -`, err);
      errorCount++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total: ${entries.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Skipped: ${skipCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log('Done!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});