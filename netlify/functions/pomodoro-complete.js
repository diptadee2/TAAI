// POST /api/pomodoro-complete  { email, minutes }
// Called once a focus (work) pomodoro session actually finishes, accumulating
// this week's focus time per student for Focus Mode's weekly leaderboard,
// and today's session count for the session dots. Only the genuine
// tick-to-zero completion path calls this (see progress.js's pomoTick), not
// Skip, otherwise a student could spam Skip for free credit on either stat.
import { getSupabase, json, weekStartIST, todayIST } from './lib/supabase.js';

// Matches the Focus settings panel's own max (progress.js's pomo-set-work
// input has max="180") — a single real session can never legitimately
// exceed this, so reject anything bigger rather than trusting the caller.
const MAX_MINUTES_PER_SESSION = 180;

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const minutes = Number(body.minutes);
  if (!email || !Number.isFinite(minutes) || minutes <= 0) {
    return json(400, { error: 'email and a positive minutes are required' });
  }
  if (minutes > MAX_MINUTES_PER_SESSION) {
    return json(400, { error: `minutes cannot exceed ${MAX_MINUTES_PER_SESSION}` });
  }

  const supabase = getSupabase();

  // Atomic UPSERTs (see increment_pomodoro_stats/increment_pomo_daily_sessions
  // in schema.sql), not a read-then-write from here — a student with two
  // tabs open both completing the same session around the same moment
  // previously raced a plain fetch-then-upsert into double-crediting one
  // of these (confirmed in testing). Postgres serializes these correctly
  // via row-level locking during the UPDATE regardless of how many
  // concurrent calls arrive, since there's no separate "read" step for
  // another request to race against.
  const { data: weekData, error: weekError } = await supabase
    .rpc('increment_pomodoro_stats', { p_email: email, p_week_start: weekStartIST(), p_minutes: Math.round(minutes) })
    .single();
  if (weekError) return json(500, { error: weekError.message });

  const { data: dayData, error: dayError } = await supabase
    .rpc('increment_pomo_daily_sessions', { p_email: email, p_date: todayIST() })
    .single();
  if (dayError) return json(500, { error: dayError.message });

  return json(200, {
    ok: true,
    total_minutes: weekData.total_minutes,
    total_sessions: weekData.total_sessions,
    sessions_today: dayData.sessions_completed,
  });
}
