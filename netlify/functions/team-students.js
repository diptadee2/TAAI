// GET   /api/team-students          -> every student with performance
//                                       metrics + notes, for /team's
//                                       Students view (identifying high
//                                       performers, dropped-off students,
//                                       etc.)
// PATCH /api/team-students { email, notes } -> update one student's notes
//
// Role-gated the same as team-posts.js. Computes everything from full
// history in a small, fixed number of batch queries (one per table, not
// one per student) rather than looping computeStreak-style per-student
// queries — the same batching principle pomodoro-leaderboard.js already
// uses for streak, just extended to every student instead of one board's
// worth of rows.
import { getSupabase, json, requireAdmin, todayForStreak, computeStreak, weekStartIST } from './lib/supabase.js';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;

  const supabase = getSupabase();

  if (event.httpMethod === 'PATCH') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return json(400, { error: 'email is required' });

    const { error } = await supabase.from('students').update({ notes: body.notes || null }).eq('email', email);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const today = todayForStreak();

  const [{ data: students, error: studentsErr }, { data: scheduled, error: schedErr }, { data: completed, error: progErr }, { data: sessions, error: sessErr }, { data: weekStats, error: weekErr }] = await Promise.all([
    supabase.from('students').select('email, display_name, notes, created_at'),
    supabase.from('schedule_tasks').select('date').lte('date', today).order('date', { ascending: false }),
    supabase.from('task_progress').select('email, date').eq('completed', true).lte('date', today),
    supabase.from('pomo_daily_sessions').select('email, date, total_minutes'),
    supabase.from('pomodoro_stats').select('email, total_minutes').eq('week_start', weekStartIST()),
  ]);
  const err = studentsErr || schedErr || progErr || sessErr || weekErr;
  if (err) return json(500, { error: err.message });

  const scheduledDates = [...new Set(scheduled.map(r => r.date))];

  const completedByEmail = new Map(); // email -> Set(date), for streak
  const taskCountByEmail = new Map(); // email -> completed task count
  for (const row of completed) {
    if (!completedByEmail.has(row.email)) completedByEmail.set(row.email, new Set());
    completedByEmail.get(row.email).add(row.date);
    taskCountByEmail.set(row.email, (taskCountByEmail.get(row.email) || 0) + 1);
  }

  const minutesByEmail = new Map(); // email -> total minutes, all-time
  const lastActiveByEmail = new Map(); // email -> latest date seen
  for (const row of sessions) {
    minutesByEmail.set(row.email, (minutesByEmail.get(row.email) || 0) + (row.total_minutes || 0));
    const prev = lastActiveByEmail.get(row.email);
    if (!prev || row.date > prev) lastActiveByEmail.set(row.email, row.date);
  }

  const weekMinutesByEmail = new Map(weekStats.map(r => [r.email, r.total_minutes]));

  const rows = students.map(s => ({
    email: s.email,
    display_name: s.display_name,
    notes: s.notes || '',
    created_at: s.created_at,
    total_minutes: minutesByEmail.get(s.email) || 0,
    week_minutes: weekMinutesByEmail.get(s.email) || 0,
    streak: computeStreak(scheduledDates, completedByEmail.get(s.email) || new Set(), today),
    tasks_completed: taskCountByEmail.get(s.email) || 0,
    last_active: lastActiveByEmail.get(s.email) || null,
  }));

  rows.sort((a, b) => b.total_minutes - a.total_minutes);

  return json(200, { students: rows });
}
