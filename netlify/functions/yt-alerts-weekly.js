// Weekly digest of competitor breakout videos to Discord, Monday 09:00 IST
// (netlify.toml). See lib/yt-alerts.js.
import { getSupabase, json } from './lib/supabase.js';
import { runYtAlertsDigest } from './lib/yt-alerts.js';

export async function handler() {
  try { return json(200, await runYtAlertsDigest(getSupabase())); }
  catch (e) { return json(200, { ok: false, skipped: e.message }); }
}
