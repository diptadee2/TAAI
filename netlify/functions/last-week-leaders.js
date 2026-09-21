// GET /api/last-week-leaders?email=...
// Standalone version of tracker-data.js's lastWeekLeaders — exists so the
// last-week champions card (shown outside Focus Mode, on the main
// checklist) can periodically refresh its live-status dots (see
// refreshLastWeekChampions in progress.js) without needing the whole
// page-load batch (schedule, streak, subject-progress, etc.) re-fetched
// alongside it, same "small independently-pollable endpoint" pattern
// streak.js/subject-progress.js/pomo-settings.js already use for the same
// reason.
//
// liveCount rides along here too — this poll and pomodoro-leaderboard.js's
// together already cover both contexts the Today card's busy meter can
// appear in (checklist vs. Focus Mode, mutually exclusive per viewer), so
// folding it into both existing 60s polls means the meter gets live
// updates with zero extra requests, instead of running its own separate
// always-on poll for every viewer regardless of context.
import { getSupabase, json, fetchLastWeekLeaders, fetchLiveCount } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase() || null;
  const supabase = getSupabase();
  try {
    const [result, liveCount] = await Promise.all([
      fetchLastWeekLeaders(supabase, email),
      // Non-critical — a live-count hiccup (or, pre-migration, the table
      // simply not existing yet) must never fail the champions card.
      fetchLiveCount(supabase).catch(() => ({ count: 0, maxCount: 0 })),
    ]);
    return json(200, { ...result, liveCount });
  } catch (err) {
    return json(500, { error: err.message });
  }
}
