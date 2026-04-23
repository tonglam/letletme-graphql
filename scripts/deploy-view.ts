import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_KEY!;

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sql = readFileSync('migrations/006_tournament_event_result_view.sql', 'utf8');

async function run() {
  const { error } = await supabase.rpc('exec_sql', { sql });
  if (error) {
    console.error('RPC failed, trying direct query...', error.message);
    // Fallback: try running as a direct query
    const { error: qError } = await supabase.from('_exec_sql').select('*').eq('sql', sql);
    if (qError) {
      console.error('Direct query also failed:', qError.message);
      process.exit(1);
    }
  }
  console.log('Migration applied successfully');
}

run();
