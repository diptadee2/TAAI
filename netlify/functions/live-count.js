// GET /api/live-count
// Standalone endpoint for the Today card's busy meter (see
// hourlyBusyMeterHtml in progress.js) — needs its own poll loop separate
// from tracker-data.js's once-per-page-load batch, since (unlike the
// leaderboard's poll, which only runs in Focus Mode, or the champions
// card's, which only runs outside it) the Today card renders in BOTH
// contexts, so this poll needs to run regardless of state.focus. Same
// "small independently-pollable endpoint" pattern already used for
// streak.js/last-week-leaders.js/pomo-settings.js.
import { getSupabase, json, fetchLiveCount } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const supabase = getSupabase();
  try {
    const result = await fetchLiveCount(supabase);
    return json(200, result);
  } catch (err) {
    return json(500, { error: err.message });
  }
}
