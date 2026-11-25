// Scheduled every 12 hours (netlify.toml): reads the competitor web pages
// listed in web_pages and records what changed, for /team > Competitors >
// Websites. See lib/web-monitor.js.
import { getSupabase, json } from './lib/supabase.js';
import { runWebMonitor } from './lib/web-monitor.js';

export async function handler() {
  try {
    return json(200, await runWebMonitor(getSupabase(), { budgetMs: 22000 }));
  } catch (e) {
    // e.g. the web_* tables not created yet: report quietly, nobody is waiting
    return json(200, { ok: false, skipped: e.message });
  }
}
