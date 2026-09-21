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
import { getSupabase, json, monthRange, todayIST, fetchLastWeekLeaders, fetchTodayLeaders, fetchHourlyActivity, fetchLiveCount } from './lib/supabase.js';

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

// Reads the cached students.current_streak column, same as streak.js —
// this used to recompute the streak itself, from schedule_tasks +
// task_progress, with none of streak.js's protections (see
// streakScheduledDatesFor in lib/supabase.js): a real, live bug, found
// 2026-09-21 investigating an unrelated Pomodoro-credit report. This
// function was simply missed when the rest of the streak-caching
// migration landed (streak.js, pomodoro-leaderboard.js, team-students.js
// were all switched over — see CLAUDE.md's streak-caching write-up — this
// one wasn't), so every fresh page load showed a streak computed the old,
// unprotected way, while any task-toggle-triggered refresh (which hits
// streak.js) correctly showed the cached value — a real, visible mismatch
// confirmed directly against production: 8 of the top 20 highest-streak
// students were seeing a number 2 lower on load than their real, correct
// streak, exactly the shape of the Aug 29/30 schedule-reload bug that
// streakScheduledDatesFor() was built to fix, just still live in this one
// un-migrated code path.
async function fetchStreak(supabase, email) {
  const { data, error } = await supabase.from('students').select('current_streak').eq('email', email).maybeSingle();
  if (error) throw new Error(error.message);
  return { streak: data ? data.current_streak || 0 : 0 };
}

// See record_malpractice_incident in schema.sql / pomodoro-complete.js.
// Fetched once per page load (not per Start click) so progress.js can
// check it entirely client-side before ever attempting a session —
// pomo-active.js still enforces the actual freeze server-side regardless
// (see its own comment), this is purely what lets the UI show the right
// message without a dedicated round-trip at Start time.
async function fetchMalpracticeStatus(supabase, email) {
  const { data, error } = await supabase
    .from('students')
    .select('malpractice_incident_count, malpractice_frozen_until')
    .eq('email', email)
    .maybeSingle();
  if (error) throw new Error(error.message);

  // Deliberately its own separate query, not folded into the select
  // above — a real, live-caught regression, not a hypothetical: a single
  // PostgREST select fails ENTIRELY if even one requested column doesn't
  // exist, so adding malpractice_warning_ack_count (added after the
  // first two columns had already been migrated) straight into that same
  // select would silently mask a real, already-correct
  // incident_count/frozen_until behind the safe-default fallback the
  // moment this new column didn't exist yet — confirmed directly: a real
  // account already at incident_count 2 stopped showing the warning gate
  // at all the moment this was added to the combined select, pre-migration.
  let warningAckCount = 0;
  try {
    const { data: ackData, error: ackError } = await supabase
      .from('students')
      .select('malpractice_warning_ack_count')
      .eq('email', email)
      .maybeSingle();
    if (!ackError && ackData) warningAckCount = ackData.malpractice_warning_ack_count || 0;
  } catch (e) { /* pre-migration or any other hiccup — 0 is a safe default */ }

  return {
    incidentCount: data ? data.malpractice_incident_count || 0 : 0,
    frozenUntil: data ? data.malpractice_frozen_until : null,
    warningAckCount,
  };
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
  const [lastWeekLeaders, todayLeaders, streak, subjectProgress, pomoSettings, pomoSessions, pomoActive, hourlyActivity, liveCount, malpractice] = await Promise.all([
    fetchLastWeekLeaders(supabase, email).catch(() => ({ leaders: [] })),
    fetchTodayLeaders(supabase, email).catch(() => ({ leaders: [] })),
    email ? fetchStreak(supabase, email).catch(() => ({ streak: null })) : Promise.resolve(null),
    email ? fetchSubjectProgress(supabase, email).catch(() => ({ subjects: [] })) : Promise.resolve(null),
    email ? fetchPomoSettings(supabase, email).catch(() => null) : Promise.resolve(null),
    email ? fetchPomoSessions(supabase, email).catch(() => null) : Promise.resolve(null),
    email ? fetchPomoActive(supabase, email).catch(() => null) : Promise.resolve(null),
    // Batch-wide, not per-student — fetched unconditionally regardless of
    // guest/student, same as schedule/lastWeekLeaders/todayLeaders above.
    fetchHourlyActivity(supabase).catch(() => ({ hours: [] })),
    // Just the initial value — live-count.js is polled separately for
    // updates after this (see startLiveCountPoll in progress.js).
    fetchLiveCount(supabase).catch(() => ({ count: 0, maxCount: 0 })),
    // Non-critical — a hiccup here (or, pre-migration, the columns simply
    // not existing yet) must never block the rest of the page; a guest
    // has no account to freeze, hence null rather than a fetch at all.
    email ? fetchMalpracticeStatus(supabase, email).catch(() => ({ incidentCount: 0, frozenUntil: null, warningAckCount: 0 })) : Promise.resolve(null),
  ]);

  return json(200, { schedule, lastWeekLeaders, todayLeaders, progress, streak, subjectProgress, pomoSettings, pomoSessions, pomoActive, hourlyActivity, liveCount, malpractice });
}
