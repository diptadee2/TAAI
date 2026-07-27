// POST /api/pomodoro-complete  { email, minutes }
// Called once a focus (work) pomodoro session actually finishes, accumulating
// this week's focus time per student for Focus Mode's weekly leaderboard.
// Only the genuine tick-to-zero completion path calls this (see progress.js's
// pomoTick), not Skip, otherwise a student could spam Skip for free credit.
import { getSupabase, json, weekStartIST } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const minutes = Number(body.minutes);
  if (!email || !Number.isFinite(minutes) || minutes <= 0) {
    return json(400, { error: 'email and a positive minutes are required' });
  }

  const supabase = getSupabase();
  const weekStart = weekStartIST();

  const { data: existing, error: fetchError } = await supabase
    .from('pomodoro_stats')
    .select('total_minutes, total_sessions')
    .eq('email', email)
    .eq('week_start', weekStart)
    .maybeSingle();
  if (fetchError) return json(500, { error: fetchError.message });

  const totalMinutes = (existing?.total_minutes || 0) + Math.round(minutes);
  const totalSessions = (existing?.total_sessions || 0) + 1;

  const { error: upsertError } = await supabase
    .from('pomodoro_stats')
    .upsert(
      { email, week_start: weekStart, total_minutes: totalMinutes, total_sessions: totalSessions, updated_at: new Date().toISOString() },
      { onConflict: 'email,week_start' }
    );
  if (upsertError) return json(500, { error: upsertError.message });

  return json(200, { ok: true, total_minutes: totalMinutes, total_sessions: totalSessions });
}
