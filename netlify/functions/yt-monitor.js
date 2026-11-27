// Scheduled every 6 hours (netlify.toml): records competitor YouTube numbers
// for /team > Competitors. See lib/yt-monitor.js.
import { getSupabase, json } from './lib/supabase.js';
import { runYtMonitor } from './lib/yt-monitor.js';
import { runYtAlerts } from './lib/yt-alerts.js';

export async function handler() {
  try {
    const s = getSupabase();
    const r = await runYtMonitor(s, { budgetMs: 22000 });
    // Breakout alerts to Discord (2026-11-27); a failure here never fails the update.
    r.alerts = await runYtAlerts(s).catch(e => ({ error: String(e.message || e) }));
    return json(200, r);
  } catch (e) {
    // e.g. the yt_* tables not created yet: report quietly, nobody is waiting
    return json(200, { ok: false, skipped: e.message });
  }
}
