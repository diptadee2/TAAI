// GET /api/last-week-leaders?email=...
// Standalone version of tracker-data.js's lastWeekLeaders — exists so the
// last-week champions card (shown outside Focus Mode, on the main
// checklist) can periodically refresh its live-status dots (see
// refreshLastWeekChampions in progress.js) without needing the whole
// page-load batch (schedule, streak, subject-progress, etc.) re-fetched
// alongside it, same "small independently-pollable endpoint" pattern
// streak.js/subject-progress.js/pomo-settings.js already use for the same
// reason.
import { getSupabase, json, fetchLastWeekLeaders } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase() || null;
  const supabase = getSupabase();
  try {
    const result = await fetchLastWeekLeaders(supabase, email);
    return json(200, result);
  } catch (err) {
    return json(500, { error: err.message });
  }
}
