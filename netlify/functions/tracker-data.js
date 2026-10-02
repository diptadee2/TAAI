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

// batch (added 2026-09-28) scopes both queries below to one batch's own
// schedule — without this, once a second batch's schedule_tasks rows
// exist, a student would see a calendar mixing both batches' content,
// and latestMonth (which caps the month-nav "next" arrow) could point
// past the end of THEIR OWN batch's real schedule. See handler() for how
// batch is resolved (student's own students.batch, or a guest's
// previewed batch).
// Task -> lesson links for the batch being viewed (schedule_task_links),
// as { subject: { task_text: url } }. Best-effort: any error (including
// the table not existing yet) returns null, and the page falls back to
// the static /course-links.js map.
async function fetchTaskLinks(supabase, batch) {
  try {
    const { data, error } = await supabase.from('schedule_task_links').select('subject, task_text, url').eq('batch', batch);
    if (error) return null;
    const out = {};
    for (const r of data || []) {
      if (!/^https:\/\/learn\.taai\.live\//.test(r.url)) continue;
      (out[r.subject] = out[r.subject] || {})[r.task_text] = r.url;
    }
    return out;
  } catch { return null; }
}

async function fetchSchedule(supabase, range, batch) {
  const { data, error } = await supabase
    .from('schedule_tasks')
    .select('date, subject, task_text, position')
    .eq('batch', batch)
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
    .eq('batch', batch)
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

// See needs_rename in schema.sql — its own standalone query, not folded
// into fetchMalpracticeStatus above, for the exact same reason that
// function already keeps warningAckCount separate: a single PostgREST
// select fails entirely if even one requested column doesn't exist, and
// this is a brand-new, likely-not-yet-migrated column that must never be
// able to take down malpractice status (or vice versa) just because one
// of the two hasn't been migrated yet.
// Also returns the student's CURRENT display_name (a stable, always-
// migrated column, safe to combine with needs_rename here) — a real bug
// this fixes: the rename gate used to read the name it's complaining
// about from progress.js's own cookie-cached state.student.display_name,
// which only updates on a real register/rename response. A student whose
// cookie predates a later rename (their own earlier voluntary rename, or
// an admin's direct SQL correction) would see the gate quoting a STALE,
// already-changed name back at them — confirmed happening for real
// ("it says karzy8 but i was using dipta for the email"), not a
// hypothetical. The server's own fresh read is what the gate should
// actually quote.
// Matches rename.js's own GATE_CHECK_LIMIT exactly — no shared constant
// exists across these two files (a Netlify Function boundary, same
// reasoning already accepted elsewhere in this codebase, e.g. the
// pomodoro-complete.js/progress.js work-minute cap), so this needs to be
// kept in sync by hand if that cap ever changes.
const GATE_CHECK_LIMIT = 3;

async function fetchNeedsRename(supabase, email) {
  const { data, error } = await supabase
    .from('students')
    .select('needs_rename, display_name')
    .eq('email', email)
    .maybeSingle();
  if (error) throw new Error(error.message);

  // Own separate, best-effort query — gate_name_check_count/month are
  // genuinely newer, less-stable columns than needs_rename/display_name
  // above, so combining them into one select risks the exact "one
  // missing column masks an already-working one" bug this codebase has
  // hit before (see malpractice_warning_ack_count's writeup in
  // CLAUDE.md). A lookup failure here just means the gate shows no tries-
  // left count yet, never a reason to break needs_rename/display_name.
  let triesLeft = GATE_CHECK_LIMIT;
  try {
    const { data: rate } = await supabase
      .from('students')
      .select('gate_name_check_count, gate_name_check_month, gate_escalated')
      .eq('email', email)
      .maybeSingle();
    if (rate && rate.gate_name_check_month === todayIST().slice(0, 7)) {
      triesLeft = rate.gate_escalated ? 0 : Math.max(0, GATE_CHECK_LIMIT - (rate.gate_name_check_count || 0));
    }
    // else: no record yet, or a stale month — fresh GATE_CHECK_LIMIT tries.
  } catch (e) {
    console.error('fetchNeedsRename: gate tries-left lookup failed for', email, e);
  }

  return { needsRename: !!(data && data.needs_rename), currentDisplayName: data ? data.display_name : null, gateTriesLeft: triesLeft };
}

// batch (added 2026-09-28) — this is a genuine second copy of
// subject-progress.js's own logic, embedded here for the page-load
// batch fetch; it was missed in the first batch-scoping pass (only the
// standalone subject-progress.js file, called separately after a task
// toggle, was scoped) — a real gap, caught on review, not by design.
// Always the student's REAL batch (never a scouted preview one, see
// handler()'s own scheduleBatch/realBatch split) — subject progress is
// real, earned progress, not something that should shift just because
// a student is currently browsing a different batch's calendar.
async function fetchSubjectProgress(supabase, email, batch) {
  const { data: scheduled, error: schedErr } = await supabase
    .from('schedule_tasks')
    .select('date, subject, task_text')
    .eq('batch', batch);
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
    .select('mode, running, phase_end_at, seconds_left, total_seconds, completed_sessions, updated_at, phase_started_at')
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
    // When the server first heard of this phase (what pomodoro-complete.js
    // measures elapsed time from). The client won't claim a completion
    // before this much real time has passed (see pomoPhaseRanFully).
    phaseStartedAt: data.phase_started_at || null,
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase() || null;
  const range = monthRange(event.queryStringParameters?.month);
  if (!range) return json(400, { error: 'month is required, format YYYY-MM' });

  const supabase = getSupabase();

  // realBatch: the student's own actual, assigned batch — authoritative
  // for streak/subjectProgress/task-completion, resolved server-side
  // from their own row, never trusted from the client (a student's real
  // batch only ever changes via migrate-batch.js's own explicit,
  // confirmed action). A guest has no row to resolve from, so realBatch
  // is meaningless for them — it's just set equal to scheduleBatch.
  //
  // scheduleBatch: which batch's CALENDAR to actually render — normally
  // the same as realBatch, but a REGISTERED student can "scout" a
  // different batch's schedule read-only (progress.js's batch dropdown,
  // sent as previewBatch) without that touching anything about their
  // real account. A guest has no realBatch to differ from, so their own
  // `batch` param (unchanged from before) IS the schedule batch.
  //
  // Best-effort, wrapped in its own try/catch rather than failing the
  // whole request — a pre-migration "column does not exist" (batch not
  // added to students yet) must never 500 this endpoint, the single
  // biggest one on the page, just to resolve a value that safely
  // defaults to 'C' anyway.
  // Everything that doesn't depend on the student's batch starts right
  // away, in parallel with the batch lookup below (2026-10-01). It used to
  // wait for the batch lookup AND the schedule load first, which added two
  // extra round trips to the critical path of every page load.
  const independentP = Promise.all([
    fetchLastWeekLeaders(supabase, email).catch(() => ({ leaders: [] })),
    fetchTodayLeaders(supabase, email).catch(() => ({ leaders: [] })),
    email ? fetchStreak(supabase, email).catch(() => ({ streak: null })) : Promise.resolve(null),
    email ? fetchPomoSettings(supabase, email).catch(() => null) : Promise.resolve(null),
    email ? fetchPomoSessions(supabase, email).catch(() => null) : Promise.resolve(null),
    email ? fetchPomoActive(supabase, email).catch(() => null) : Promise.resolve(null),
    fetchHourlyActivity(supabase).catch(() => ({ hours: [] })),
    fetchLiveCount(supabase).catch(() => ({ count: 0, maxCount: 0 })),
    email ? fetchMalpracticeStatus(supabase, email).catch(() => ({ incidentCount: 0, frozenUntil: null, warningAckCount: 0 })) : Promise.resolve(null),
    email ? fetchNeedsRename(supabase, email).catch(() => ({ needsRename: false })) : Promise.resolve(null),
  ]);

  let realBatch = 'C';
  let scheduleBatch = 'C';
  if (email) {
    // supabase-js returns { data, error } rather than throwing, so the
    // fault-tolerance here is a plain error check, not try/catch.
    const { data: studentRow, error: batchErr } = await supabase.from('students').select('batch').eq('email', email).maybeSingle();
    if (!batchErr && studentRow && studentRow.batch) realBatch = studentRow.batch;
    scheduleBatch = realBatch;
    const previewBatch = String(event.queryStringParameters?.previewBatch || '').trim();
    if (previewBatch) scheduleBatch = previewBatch;
  } else {
    const previewBatch = String(event.queryStringParameters?.batch || '').trim();
    if (previewBatch) scheduleBatch = previewBatch;
    realBatch = scheduleBatch;
  }
  // Only a registered student can genuinely "scout" — a guest's
  // scheduleBatch and realBatch are set equal above by construction.
  const isScouting = !!email && scheduleBatch !== realBatch;

  const taskLinksP = fetchTaskLinks(supabase, scheduleBatch);
  let schedule, progress, subjectProgress;
  try {
    // schedule and (if applicable) progress must still fail the whole
    // request on error — no client-side .catch() covered these before.
    [schedule, progress, subjectProgress] = await Promise.all([
      fetchSchedule(supabase, range, scheduleBatch),
      // Suppressed while scouting a different batch — task_progress has
      // no batch column (see schema.sql's own comment on it: email ->
      // students.batch was meant to be sufficient disambiguation for a
      // student who only ever sees their OWN batch's schedule). Showing
      // it against a scouted, different batch risks a coincidental
      // date/subject/task_text match rendering as falsely "completed" —
      // scouting is meant to be a genuinely read-only look, never
      // something that can show an inaccurate checkmark. Still shaped
      // like fetchProgress's own real return value ({ progress: [] }),
      // not bare null — progress.js's data.progress.progress read
      // assumes that shape whenever state.student is truthy (which it
      // still is while scouting), so a bare null here would throw.
      email && !isScouting ? fetchProgress(supabase, email, range) : Promise.resolve(email ? { progress: [] } : null),
      email ? fetchSubjectProgress(supabase, email, realBatch).catch(() => ({ subjects: [] })) : Promise.resolve(null),
    ]);
  } catch (err) {
    return json(500, { error: err.message });
  }

  // Everything else degrades to its old client-side .catch() fallback
  // instead of failing the whole response. streak/subjectProgress
  // always use realBatch, never scheduleBatch — a student's actual,
  // earned progress must never shift just because they're currently
  // browsing a different batch's calendar.
  const [lastWeekLeaders, todayLeaders, streak, pomoSettings, pomoSessions, pomoActive, hourlyActivity, liveCount, malpractice, needsRename] = await independentP;

  const studentBatch = email ? realBatch : null;
  const taskLinks = await taskLinksP;
  return json(200, { schedule, lastWeekLeaders, todayLeaders, progress, streak, subjectProgress, pomoSettings, pomoSessions, pomoActive, hourlyActivity, liveCount, malpractice, needsRename, studentBatch, taskLinks });
}
