// Scheduled once a day (netlify.toml): the whole GATE CSE / DA YouTube market
// for /team > Competitors > Whole market. See lib/yt-market.js. Uses only the
// free YouTube API quota (~715 of 10,000 units a day), no paid API.
import { getSupabase, json } from './lib/supabase.js';
import { runYtMarket } from './lib/yt-market.js';
import { ytKey } from './lib/yt-monitor.js';

export async function handler() {
  if (!ytKey()) return json(200, { ok: false, skipped: 'no YouTube API key' });
  try { return json(200, await runYtMarket(getSupabase())); }
  catch (e) { return json(200, { ok: false, skipped: e.message }); }
}
