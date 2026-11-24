// Scheduled every 6 hours (netlify.toml): records competitor YouTube numbers
// for /team > Competitors. See lib/yt-monitor.js.
import { getSupabase, json } from './lib/supabase.js';
import { runYtMonitor } from './lib/yt-monitor.js';

export async function handler() {
  try {
    const r = await runYtMonitor(getSupabase(), { budgetMs: 22000 });
    return json(200, r);
  } catch (e) {
    // e.g. the yt_* tables not created yet: report quietly, nobody is waiting
    return json(200, { ok: false, skipped: e.message });
  }
}
