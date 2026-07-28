// GET  /api/pomo-settings?email=...                     -> { work, shortBreak, longBreak, cycle } (nulls if never customized)
// POST /api/pomo-settings  { email, work, shortBreak, longBreak, cycle } -> saves and echoes them back
//
// Persists a student's pomodoro timer durations so a customized setup
// follows them across devices/browsers instead of only living in one
// device's localStorage (see progress.js's applyPomoSettings, which calls
// both localStorage and this).
import { getSupabase, json } from './lib/supabase.js';

function clampMinutes(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function handler(event) {
  const supabase = getSupabase();

  if (event.httpMethod === 'GET') {
    const email = String(event.queryStringParameters?.email || '').trim().toLowerCase();
    if (!email) return json(400, { error: 'email is required' });

    const { data, error } = await supabase
      .from('students')
      .select('pomo_work_min, pomo_short_break_min, pomo_long_break_min, pomo_cycle_sessions')
      .eq('email', email)
      .maybeSingle();
    if (error) return json(500, { error: error.message });

    return json(200, {
      work: data?.pomo_work_min ?? null,
      shortBreak: data?.pomo_short_break_min ?? null,
      longBreak: data?.pomo_long_break_min ?? null,
      cycle: data?.pomo_cycle_sessions ?? null,
    });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return json(400, { error: 'email is required' });

    const work = clampMinutes(body.work, 1, 180);
    const shortBreak = clampMinutes(body.shortBreak, 1, 60);
    const longBreak = clampMinutes(body.longBreak, 1, 90);
    const cycle = clampMinutes(body.cycle, 1, 12);
    if (work === null || shortBreak === null || longBreak === null || cycle === null) {
      return json(400, { error: 'work, shortBreak, longBreak, cycle must be valid numbers' });
    }

    const { data, error } = await supabase
      .from('students')
      .update({
        pomo_work_min: work,
        pomo_short_break_min: shortBreak,
        pomo_long_break_min: longBreak,
        pomo_cycle_sessions: cycle,
      })
      .eq('email', email)
      .select('pomo_work_min, pomo_short_break_min, pomo_long_break_min, pomo_cycle_sessions')
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: 'student not found' });

    return json(200, {
      work: data.pomo_work_min,
      shortBreak: data.pomo_short_break_min,
      longBreak: data.pomo_long_break_min,
      cycle: data.pomo_cycle_sessions,
    });
  }

  return json(405, { error: 'method not allowed' });
}
