// GET  /api/lms-price-check  -> current LMS sync state + recent price changes (for /team)
// POST /api/lms-price-check  -> run the LMS price sync right now ("Check LMS now")
//
// Admin only. The same sync also runs every 15 minutes inside
// discord-dispatch.js; see lib/lms-price-sync.js for the rules.
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { syncLmsPrices, RUN_ROW_ID } from './lib/lms-price-sync.js';

async function readState(supabase) {
  const [{ data: rows, error }, { data: log }] = await Promise.all([
    supabase.from('lms_price_sync').select('*'),
    supabase.from('lms_price_log').select('*').order('created_at', { ascending: false }).limit(20),
  ]);
  if (error) return { available: false, error: error.message };
  const run = (rows || []).find(r => r.id === RUN_ROW_ID) || null;
  return { available: true, lastRun: run, courses: (rows || []).filter(r => r.id !== RUN_ROW_ID), log: log || [] };
}

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  const supabase = getSupabase();

  if (event.httpMethod === 'GET') return json(200, await readState(supabase));

  if (event.httpMethod === 'POST') {
    let sync;
    try {
      sync = await syncLmsPrices(supabase, { deadline: Date.now() + 20000 });
    } catch (err) {
      return json(500, { error: err.message });
    }
    return json(200, Object.assign({ sync }, await readState(supabase)));
  }

  return json(405, { error: 'method not allowed' });
}
