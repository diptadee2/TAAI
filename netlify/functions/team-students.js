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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

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

  const [{ data: students, error: studentsErr }, { data: scheduled, error: schedErr }, { data: completed, error: progErr }, { data: sessions, error: sessErr }, { data: weekStats, error: weekErr }, { count: totalTaskCount, error: totalErr }] = await Promise.all([
    supabase.from('students').select('email, display_name, notes, created_at'),
    supabase.from('schedule_tasks').select('date').lte('date', today).order('date', { ascending: false }),
    supabase.from('task_progress').select('email, date').eq('completed', true).lte('date', today),
    supabase.from('pomo_daily_sessions').select('email, date, total_minutes'),
    supabase.from('pomodoro_stats').select('email, total_minutes').eq('week_start', weekStartIST()),
    // Whole-schedule task count (not date-limited), the same denominator
    // subject-progress.js uses for its per-subject done/total — here
    // rolled into one overall "how much of the course" percentage instead
    // of a per-subject breakdown, which wouldn't fit a table with 300
    // rows. schedule_tasks only ever holds months already loaded (see
    // "Schedule data flow" in CLAUDE.md), so this is naturally "tasks
    // assigned so far", not some far-future total.
    supabase.from('schedule_tasks').select('*', { count: 'exact', head: true }),
  ]);
  const err = studentsErr || schedErr || progErr || sessErr || weekErr || totalErr;
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
  const monthMinutesByEmailDate = new Map(); // email -> { 'YYYY-MM-DD': minutes }, this month only
  const currentMonth = today.slice(0, 7);
  for (const row of sessions) {
    minutesByEmail.set(row.email, (minutesByEmail.get(row.email) || 0) + (row.total_minutes || 0));
    const prev = lastActiveByEmail.get(row.email);
    if (!prev || row.date > prev) lastActiveByEmail.set(row.email, row.date);
    if (row.date.slice(0, 7) === currentMonth) {
      if (!monthMinutesByEmailDate.has(row.email)) monthMinutesByEmailDate.set(row.email, {});
      monthMinutesByEmailDate.get(row.email)[row.date] = row.total_minutes;
    }
  }

  // "Consistency" here means the same thing the monthly Discord post
  // means by it — median daily minutes, zero-filled per day (a quiet day
  // counts as a real 0, not a skipped one), so one huge binge day can't
  // outrank someone who shows up for less time but every day. Unlike
  // computeMonthlyConsistency() (which reports on a month that's already
  // fully closed), this is a live in-progress reading: zero-filled only
  // across days that have actually happened so far this month, not the
  // whole month — filling in not-yet-arrived future days as zeros would
  // artificially crater everyone's median early in the month.
  const dayOfMonth = Number(today.slice(8, 10));
  function consistencyFor(email) {
    var byDate = monthMinutesByEmailDate.get(email) || {};
    var values = [];
    for (var d = 1; d <= dayOfMonth; d++) {
      var dateStr = currentMonth + '-' + String(d).padStart(2, '0');
      values.push(byDate[dateStr] || 0);
    }
    return median(values);
  }

  const weekMinutesByEmail = new Map(weekStats.map(r => [r.email, r.total_minutes]));

  // Days between last_active and today — computed server-side (against
  // todayForStreak(), the same IST-anchored "today" every other date
  // calculation here uses) rather than left to the browser's local clock,
  // same reasoning as todayIST() elsewhere: a client-side Date() diff
  // would be off by however far the viewer's own timezone/clock drifts,
  // and silently wrong for a few hours around midnight IST either way.
  // null (not a number) for a student with no session at all, distinct
  // from 0 (active today) — both render differently in the table.
  const todayMs = Date.parse(today + 'T00:00:00Z');
  function daysInactiveFor(lastActive) {
    if (!lastActive) return null;
    return Math.round((todayMs - Date.parse(lastActive + 'T00:00:00Z')) / 86400000);
  }

  const rows = students.map(s => {
    const lastActive = lastActiveByEmail.get(s.email) || null;
    return {
      email: s.email,
      display_name: s.display_name,
      notes: s.notes || '',
      created_at: s.created_at,
      total_minutes: minutesByEmail.get(s.email) || 0,
      week_minutes: weekMinutesByEmail.get(s.email) || 0,
      streak: computeStreak(scheduledDates, completedByEmail.get(s.email) || new Set(), today),
      tasks_completed: taskCountByEmail.get(s.email) || 0,
      progress_pct: totalTaskCount > 0 ? Math.round(((taskCountByEmail.get(s.email) || 0) / totalTaskCount) * 100) : 0,
      consistency_minutes: consistencyFor(s.email),
      last_active: lastActive,
      days_inactive: daysInactiveFor(lastActive),
    };
  });

  rows.sort((a, b) => b.total_minutes - a.total_minutes);

  // Summary stats for the view's top-of-page cards — computed once here
  // (over every student, not just whatever the client happens to have
  // filtered to) rather than in the browser, so "how many are inactive
  // 7+ days" etc. always reflects the true full roster regardless of
  // the current filter/search state.
  const summary = {
    total_students: rows.length,
    active_this_week: rows.filter(r => r.week_minutes > 0).length,
    inactive_7d: rows.filter(r => r.days_inactive != null && r.days_inactive >= 7).length,
    never_active: rows.filter(r => r.days_inactive == null).length,
    avg_progress_pct: rows.length ? Math.round(rows.reduce((sum, r) => sum + r.progress_pct, 0) / rows.length) : 0,
    avg_consistency_minutes: rows.length ? Math.round(rows.reduce((sum, r) => sum + r.consistency_minutes, 0) / rows.length) : 0,
  };

  return json(200, { students: rows, summary });
}
