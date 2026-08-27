// GET /api/tracker-data?email=...&month=YYYY-MM  (email optional — guests
// only get schedule + lastWeekLeaders, same as before)
//
// Combines what used to be 7 separate Netlify Functions (schedule,
// last-week-focus-leaders, progress, streak, subject-progress,
// pomo-settings GET, pomo-sessions), all of which were only ever called
// together as one batch from loadMonth() in progress.js, into a single
// request. Each of those was its own independent Lambda deployment, so a
// page load after any idle gap paid up to 7 separate cold-start costs in
// parallel (container boot + module load + Supabase client construction)
// for what's fundamentally one "give me the tracker page's data" ask —
// that's what was driving both the inflated Web-requests count and the
// surprisingly high per-call latency seen in the Netlify Functions
// dashboard (1.2-1.8s p50 on simple single-table queries). This folds
// them into one cold start instead of up to seven.
//
// streak.js, subject-progress.js, and pomo-settings.js are deliberately
// NOT removed — they're still called independently after a task toggle
// (refreshStreak/refreshSubjectProgress) or a settings save
// (saveRemotePomoSettings' POST), so those routes still need to exist on
// their own. schedule.js, last-week-focus-leaders.js, the old progress.js
// function, and pomo-sessions.js had no other callers and were deleted.
//
// Error-handling mirrors the exact per-call .catch() behavior loadMonth()
// used to have client-side: schedule and progress had no .catch there, so
// a failure in either must still fail this whole request (matching
// loadMonth's outer .catch, which shows "Couldn't load your roadmap").
// The other five degrade to the same fallback values their client-side
// .catch()es used to supply, rather than failing the whole page.
//
// pomoActive was added later, for cross-device pomodoro sync — see
// fetchPomoActive below and pomo-active.js (the write side).
import { getSupabase, json, monthRange, todayIST, weekStartIST, weekBefore } from './lib/supabase.js';

const DEMO_TODAY_FLOOR = '2026-08-01'; // see streak.js — same self-expiring floor

function lastWeekStart() {
  return weekBefore(weekStartIST());
}

async function fetchSchedule(supabase, range) {
  const { data, error } = await supabase
    .from('schedule_tasks')
    .select('date, subject, task_text, position')
    .gte('date', range.start)
    .lt('date', range.end)
    .order('date', { ascending: true })
    .order('position', { ascending: true });
  if (error) throw new Error(error.message);

  const byDate = new Map();
  for (const row of data) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push({ subject: row.subject, task_text: row.task_text, position: row.position });
  }
  const days = [...byDate.entries()].map(([date, tasks]) => ({ date, tasks }));

  const { data: latestRow, error: latestError } = await supabase
    .from('schedule_tasks')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(latestError.message);

  return { days, latestMonth: latestRow ? latestRow.date.slice(0, 7) : null };
}

async function fetchLastWeekLeaders(supabase, email) {
  const weekStart = lastWeekStart();
  const { data: stats, error: statsError } = await supabase
    .from('pomodoro_stats')
    .select('email, total_minutes')
    .eq('week_start', weekStart)
    .order('total_minutes', { ascending: false })
    .limit(5);
  if (statsError) throw new Error(statsError.message);
  if (!stats.length) return { weekStart, leaders: [], viewerRank: null };

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('email, display_name')
    .in('email', stats.map(s => s.email));
  if (studentsError) throw new Error(studentsError.message);

  // Previous-week rank, for the same up/down arrow the top-20 board
  // shows (rankMovementHtml in progress.js, reused as-is here) — except
  // "previous" means the week before *this* week's top-5 snapshot,
  // rather than the last poll. A full ranked snapshot of that earlier
  // week (not just these 5 emails' own rows), since a leader's previous
  // rank can be well outside that week's own top 5 — someone who jumped
  // from #12 to #3 should still show as a big rise, not "no data".
  // Computed in JS from one query rather than a per-leader rank-count
  // query, since this whole function only ever runs on page load / an
  // explicit champions-card refresh, not on a poll.
  const prevWeekStart = weekBefore(weekStart);
  const { data: prevWeekStats, error: prevWeekError } = await supabase
    .from('pomodoro_stats')
    .select('email, total_minutes')
    .eq('week_start', prevWeekStart)
    .order('total_minutes', { ascending: false });
  if (prevWeekError) throw new Error(prevWeekError.message);
  const prevRankByEmail = Object.fromEntries(prevWeekStats.map((s, i) => [s.email, i + 1]));

  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));
  const leaders = stats.map((s, i) => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    is_me: !!email && s.email === email,
    previous_week_rank: prevRankByEmail[s.email] ?? null,
  }));

  // Same idea as pomodoro-leaderboard.js's viewerRank — a student outside
  // last week's top 5 otherwise has no way to see where they actually
  // stood, since this query never fetches their row at all.
  let viewerRank = null;
  const viewerInTop = leaders.some(l => l.is_me);
  if (email && !viewerInTop) {
    const { data: viewerStats, error: viewerError } = await supabase
      .from('pomodoro_stats')
      .select('total_minutes')
      .eq('email', email)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (viewerError) throw new Error(viewerError.message);

    if (viewerStats) {
      const { count, error: countError } = await supabase
        .from('pomodoro_stats')
        .select('*', { count: 'exact', head: true })
        .eq('week_start', weekStart)
        .gt('total_minutes', viewerStats.total_minutes);
      if (countError) throw new Error(countError.message);

      viewerRank = { rank: (count || 0) + 1, total_minutes: viewerStats.total_minutes, previous_week_rank: prevRankByEmail[email] ?? null };
    }
  }

  return { weekStart, leaders, viewerRank };
}

// Top 5 by focus minutes logged *today* (IST) — shown in Focus Mode next
// to the timer. Same shape/pattern as fetchLastWeekLeaders above, just
// keyed by pomo_daily_sessions.total_minutes for today's date instead of
// pomodoro_stats for a week — resets by construction every midnight IST
// since a new day is just a new row starting from zero, same as that
// table's existing sessions_completed always has.
async function fetchTodayLeaders(supabase, email) {
  const today = todayIST();
  const { data: stats, error: statsError } = await supabase
    .from('pomo_daily_sessions')
    .select('email, total_minutes')
    .eq('date', today)
    .order('total_minutes', { ascending: false })
    .limit(5);
  if (statsError) throw new Error(statsError.message);
  if (!stats.length) return { date: today, leaders: [], viewerRank: null };

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('email, display_name')
    .in('email', stats.map(s => s.email));
  if (studentsError) throw new Error(studentsError.message);

  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));
  const leaders = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    is_me: !!email && s.email === email,
  }));

  // Same idea as fetchLastWeekLeaders' viewerRank — a student outside
  // today's top 5 otherwise has no way to see where they actually stand.
  let viewerRank = null;
  const viewerInTop = leaders.some(l => l.is_me);
  if (email && !viewerInTop) {
    const { data: viewerStats, error: viewerError } = await supabase
      .from('pomo_daily_sessions')
      .select('total_minutes')
      .eq('email', email)
      .eq('date', today)
      .maybeSingle();
    if (viewerError) throw new Error(viewerError.message);

    if (viewerStats) {
      const { count, error: countError } = await supabase
        .from('pomo_daily_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('date', today)
        .gt('total_minutes', viewerStats.total_minutes);
      if (countError) throw new Error(countError.message);

      viewerRank = { rank: (count || 0) + 1, total_minutes: viewerStats.total_minutes };
    }
  }

  return { date: today, leaders, viewerRank };
}

async function fetchProgress(supabase, email, range) {
  const { data, error } = await supabase
    .from('task_progress')
    .select('date, subject, task_text, completed')
    .eq('email', email)
    .gte('date', range.start)
    .lt('date', range.end);
  if (error) throw new Error(error.message);
  return { progress: data };
}

async function fetchStreak(supabase, email) {
  const realToday = todayIST();
  const today = realToday > DEMO_TODAY_FLOOR ? realToday : DEMO_TODAY_FLOOR;

  const { data: scheduled, error: schedErr } = await supabase
    .from('schedule_tasks')
    .select('date')
    .lte('date', today)
    .order('date', { ascending: false });
  if (schedErr) throw new Error(schedErr.message);
  const scheduledDates = [...new Set(scheduled.map(r => r.date))];

  const { data: completed, error: progErr } = await supabase
    .from('task_progress')
    .select('date')
    .eq('email', email)
    .eq('completed', true);
  if (progErr) throw new Error(progErr.message);
  const completedDates = new Set(completed.map(r => r.date));

  let streak = 0;
  for (const date of scheduledDates) {
    if (completedDates.has(date)) { streak++; continue; }
    if (date === today) continue;
    break;
  }
  return { streak };
}

async function fetchSubjectProgress(supabase, email) {
  const { data: scheduled, error: schedErr } = await supabase
    .from('schedule_tasks')
    .select('date, subject, task_text');
  if (schedErr) throw new Error(schedErr.message);

  const { data: completed, error: progErr } = await supabase
    .from('task_progress')
    .select('date, subject, task_text')
    .eq('email', email)
    .eq('completed', true);
  if (progErr) throw new Error(progErr.message);

  const completedKeys = new Set(completed.map(r => `${r.date}|${r.subject}|${r.task_text}`));
  const totals = {};
  for (const row of scheduled) {
    if (!totals[row.subject]) totals[row.subject] = { done: 0, total: 0 };
    totals[row.subject].total++;
    if (completedKeys.has(`${row.date}|${row.subject}|${row.task_text}`)) totals[row.subject].done++;
  }
  const subjects = Object.keys(totals).map(subject => ({ subject, done: totals[subject].done, total: totals[subject].total }));
  return { subjects };
}

async function fetchPomoSettings(supabase, email) {
  const { data, error } = await supabase
    .from('students')
    .select('pomo_work_min, pomo_short_break_min, pomo_long_break_min, pomo_cycle_sessions')
    .eq('email', email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    work: data?.pomo_work_min ?? null,
    shortBreak: data?.pomo_short_break_min ?? null,
    longBreak: data?.pomo_long_break_min ?? null,
    cycle: data?.pomo_cycle_sessions ?? null,
  };
}

async function fetchPomoSessions(supabase, email) {
  const today = todayIST();
  const { data, error } = await supabase
    .from('pomo_daily_sessions')
    .select('sessions_completed')
    .eq('email', email)
    .eq('date', today)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { date: today, sessionsCompleted: data?.sessions_completed || 0 };
}

// The cross-device counterpart to localStorage's taai_pomo_active — see
// pomo-active.js for the write side. null (not found) just means this
// student has never started a timer on any device, or their last session
// already ran to a clean pause; that's the common case, not an error.
async function fetchPomoActive(supabase, email) {
  const { data, error } = await supabase
    .from('pomo_active_session')
    .select('mode, running, phase_end_at, seconds_left, total_seconds, completed_sessions, updated_at')
    .eq('email', email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    mode: data.mode,
    running: data.running,
    phaseEndAt: data.phase_end_at,
    secondsLeft: data.seconds_left,
    totalSeconds: data.total_seconds,
    completedSessions: data.completed_sessions,
    updatedAt: data.updated_at,
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase() || null;
  const range = monthRange(event.queryStringParameters?.month);
  if (!range) return json(400, { error: 'month is required, format YYYY-MM' });

  const supabase = getSupabase();

  let schedule, progress;
  try {
    // schedule and (if applicable) progress must still fail the whole
    // request on error — no client-side .catch() covered these before.
    [schedule, progress] = await Promise.all([
      fetchSchedule(supabase, range),
      email ? fetchProgress(supabase, email, range) : Promise.resolve(null),
    ]);
  } catch (err) {
    return json(500, { error: err.message });
  }

  // Everything else degrades to its old client-side .catch() fallback
  // instead of failing the whole response.
  const [lastWeekLeaders, todayLeaders, streak, subjectProgress, pomoSettings, pomoSessions, pomoActive] = await Promise.all([
    fetchLastWeekLeaders(supabase, email).catch(() => ({ leaders: [] })),
    fetchTodayLeaders(supabase, email).catch(() => ({ leaders: [] })),
    email ? fetchStreak(supabase, email).catch(() => ({ streak: null })) : Promise.resolve(null),
    email ? fetchSubjectProgress(supabase, email).catch(() => ({ subjects: [] })) : Promise.resolve(null),
    email ? fetchPomoSettings(supabase, email).catch(() => null) : Promise.resolve(null),
    email ? fetchPomoSessions(supabase, email).catch(() => null) : Promise.resolve(null),
    email ? fetchPomoActive(supabase, email).catch(() => null) : Promise.resolve(null),
  ]);

  return json(200, { schedule, lastWeekLeaders, todayLeaders, progress, streak, subjectProgress, pomoSettings, pomoSessions, pomoActive });
}
