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
//
// 2026-10-09: rebuilt on lib/board-cache.js (see pomodoro-leaderboard.js):
// the shared parts are computed at most once per 30s per function
// instance, the viewer's rank is computed from the cached week (same "count
// of eligible students with more minutes, plus one" rule as lib
// fetchLastWeekLeaders), and only the viewer's own all-time minutes and
// live status are looked up per request. Same response shape.
import { getSupabase, json } from './lib/supabase.js';
import { buildLastWeekLeaders } from './lib/board-cache.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase() || null;
  try {
    return json(200, await buildLastWeekLeaders(getSupabase(), email));
  } catch (err) {
    return json(500, { error: err.message });
  }
}
