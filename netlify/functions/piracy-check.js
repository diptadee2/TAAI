// Daily check of every reported Telegram link (2026-11-12, cron in
// netlify.toml). Updates piracy_reports.status from Telegram's public pages;
// the weekly 'piracy_status' scheduled post reads the results. Skips quietly
// until the piracy_reports table exists.
import { getSupabase, json } from './lib/supabase.js';
import { checkPiracyLinks } from './lib/piracy.js';

export async function handler() {
  try {
    const result = await checkPiracyLinks(getSupabase(), { concurrency: 8, budgetMs: 22000 });
    return json(200, result);
  } catch (e) {
    return json(200, { skipped: e.message });
  }
}
