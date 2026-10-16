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
//
// 2026-10-17, to cut Supabase requests (Log Ingestion is metered per
// request): a page load used to make ~25-40 database requests. Now:
//  - the leaderboards, live count and hourly chart come from the shared
//    30s cache in lib/board-cache.js (same data the 60s polls use);
//  - each batch's schedule and lesson links are cached for 5 minutes
//    (getBatchSchedule), since they're identical for every student;
//  - the student's own row is read ONCE with select('*') instead of ~6
//    separate column lookups. select('*') can't fail on a column that
//    doesn't exist yet, so the old "keep new columns in their own query"
//    precaution is no longer needed here;
//  - task_progress is read once (all of the student's rows) and used for
//    both the month's ticks and the subject totals.
// A warm student page load is now 5 requests; a guest's is 0. The response
// shape is unchanged.
import { getSupabase, json, monthRange, todayIST, fetchAllRows, fetchLiveStatusByEmail } from './lib/supabase.js';
import { getSharedWeekly, getBatchSchedule, getSharedHourly, buildTodayLeaders, buildLastWeekLeaders } from './lib/board-cache.js';

// Matches rename.js's own GATE_CHECK_LIMIT exactly; keep in sync by hand.
const GATE_CHECK_LIMIT = 3;

// Month view of a cached batch schedule: same shape and order as the old
// per-request query (by date, then position).
function scheduleForMonth(sched, range) {
  const rows = sched.rows
    .filter((r) => r.date >= range.start && r.date < range.end)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.position - b.position));
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push({ subject: row.subject, task_text: row.task_text, position: row.position });
  }
  return { days: [...byDate.entries()].map(([date, tasks]) => ({ date, tasks })), latestMonth: sched.latestMonth };
}

function subjectProgressFrom(sched, completedKeys) {
  const totals = {};
  for (const row of sched.rows) {
    if (!totals[row.subject]) totals[row.subject] = { done: 0, total: 0 };
    totals[row.subject].total++;
    if (completedKeys.has(`${row.date}|${row.subject}|${row.task_text}`)) totals[row.subject].done++;
  }
  return { subjects: Object.keys(totals).map((subject) => ({ subject, done: totals[subject].done, total: totals[subject].total })) };
}

function pomoActiveFrom(data) {
  if (!data) return null;
  return {
    mode: data.mode,
    running: data.running,
    phaseEndAt: data.phase_end_at,
    secondsLeft: data.seconds_left,
    totalSeconds: data.total_seconds,
    completedSessions: data.completed_sessions,
    updatedAt: data.updated_at,
    // How long ago the server first heard of this phase (what
    // pomodoro-complete.js measures elapsed time from), as an age so client
    // clock skew doesn't matter (see pomoPhaseRanFully in progress.js).
    phaseStartedAgeMs: data.phase_started_at ? Math.max(0, Date.now() - data.phase_started_at) : null,
  };
}

// Everything below derived from the one students row (or the same
// fallbacks the old separate lookups used when that read fails).
function studentDerived(row, readFailed) {
  if (readFailed) {
    return {
      streak: { streak: null },
      pomoSettings: null,
      malpractice: { incidentCount: 0, frozenUntil: null, warningAckCount: 0 },
      needsRename: { needsRename: false },
    };
  }
  let triesLeft = GATE_CHECK_LIMIT;
  if (row && row.gate_name_check_month === todayIST().slice(0, 7)) {
    triesLeft = row.gate_escalated ? 0 : Math.max(0, GATE_CHECK_LIMIT - (row.gate_name_check_count || 0));
  }
  return {
    streak: { streak: row ? row.current_streak || 0 : 0 },
    pomoSettings: {
      work: row?.pomo_work_min ?? null,
      shortBreak: row?.pomo_short_break_min ?? null,
      longBreak: row?.pomo_long_break_min ?? null,
      cycle: row?.pomo_cycle_sessions ?? null,
    },
    malpractice: {
      incidentCount: row ? row.malpractice_incident_count || 0 : 0,
      frozenUntil: row ? row.malpractice_frozen_until ?? null : null,
      warningAckCount: row ? row.malpractice_warning_ack_count || 0 : 0,
    },
    needsRename: { needsRename: !!(row && row.needs_rename), currentDisplayName: row ? row.display_name : null, gateTriesLeft: triesLeft },
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase() || null;
  const range = monthRange(event.queryStringParameters?.month);
  if (!range) return json(400, { error: 'month is required, format YYYY-MM' });

  const supabase = getSupabase();
  const today = todayIST();

  // Wave 1: everything that doesn't need the student's batch.
  const studentP = email
    ? supabase.from('students').select('*').eq('email', email).maybeSingle().then((r) => r, (e) => ({ data: null, error: e }))
    : Promise.resolve({ data: null, error: null });
  // All of this student's task rows (ticked or not), used for both the
  // month's ticks and the subject totals.
  const progressP = email
    ? fetchAllRows(() => supabase.from('task_progress').select('date, subject, task_text, completed').eq('email', email))
    : Promise.resolve(null);
  const todayRowP = email
    ? supabase.from('pomo_daily_sessions').select('email, sessions_completed, total_minutes').eq('email', email).eq('date', today).maybeSingle().then((r) => r, (e) => ({ data: null, error: e }))
    : Promise.resolve(null);
  const pomoActiveP = email
    ? supabase.from('pomo_active_session').select('mode, running, phase_end_at, seconds_left, total_seconds, completed_sessions, updated_at, phase_started_at').eq('email', email).maybeSingle().then((r) => (r.error ? null : pomoActiveFrom(r.data)), () => null)
    : Promise.resolve(null);
  const liveP = email ? fetchLiveStatusByEmail(supabase, [email]).catch(() => ({})) : Promise.resolve({});
  const weeklyP = getSharedWeekly(supabase).catch(() => null);
  const hourlyP = getSharedHourly(supabase).catch(() => ({ hours: [] }));

  const { data: studentRow, error: studentErr } = await studentP;

  // realBatch: the student's own batch (authoritative for progress/streak).
  // scheduleBatch: which batch's calendar to show (a student may scout
  // another batch read-only via previewBatch; a guest previews via batch).
  let realBatch = 'C';
  let scheduleBatch = 'C';
  if (email) {
    if (!studentErr && studentRow && studentRow.batch) realBatch = studentRow.batch;
    scheduleBatch = realBatch;
    const previewBatch = String(event.queryStringParameters?.previewBatch || '').trim();
    if (previewBatch) scheduleBatch = previewBatch;
  } else {
    const previewBatch = String(event.queryStringParameters?.batch || '').trim();
    if (previewBatch) scheduleBatch = previewBatch;
    realBatch = scheduleBatch;
  }
  const isScouting = !!email && scheduleBatch !== realBatch;

  let sched, realSched, progressRows;
  try {
    // The schedule and (if applicable) progress still fail the whole
    // request on error, as before.
    [sched, realSched, progressRows] = await Promise.all([
      getBatchSchedule(supabase, scheduleBatch),
      email && realBatch !== scheduleBatch ? getBatchSchedule(supabase, realBatch).catch(() => null) : Promise.resolve(null),
      email && !isScouting ? progressP : progressP.catch(() => null),
    ]);
  } catch (err) {
    return json(500, { error: err.message });
  }
  if (!realSched) realSched = realBatch === scheduleBatch ? sched : null;

  const schedule = scheduleForMonth(sched, range);
  // Suppressed while scouting another batch: task_progress has no batch
  // column, so a coincidental match could show a false tick.
  let progress = null;
  if (email) {
    progress = isScouting
      ? { progress: [] }
      : { progress: progressRows.filter((r) => r.date >= range.start && r.date < range.end) };
  }
  let subjectProgress = null;
  if (email) {
    if (progressRows && realSched) {
      const completedKeys = new Set(progressRows.filter((r) => r.completed).map((r) => `${r.date}|${r.subject}|${r.task_text}`));
      subjectProgress = subjectProgressFrom(realSched, completedKeys);
    } else {
      subjectProgress = { subjects: [] };
    }
  }

  const derived = email ? studentDerived(studentRow, !!studentErr) : null;
  const [todayRowRes, pomoActive, liveByEmail, sh, hourlyActivity] = await Promise.all([todayRowP, pomoActiveP, liveP, weeklyP, hourlyP]);
  const todayRow = todayRowRes && !todayRowRes.error ? todayRowRes.data : undefined;
  const pomoSessions = email ? (todayRowRes && !todayRowRes.error ? { date: today, sessionsCompleted: todayRow?.sessions_completed || 0 } : null) : null;

  // Today's leaders: shared cache plus the viewer's own fresh numbers.
  let todayLeaders = { leaders: [] };
  if (sh) {
    const viewer = email && studentRow ? {
      today: todayRow === undefined ? undefined : (todayRow ? { email, total_minutes: todayRow.total_minutes } : null),
      allTime: studentRow.all_time_minutes || 0,
      aboutRow: 'about_text' in studentRow ? studentRow : null,
      live: liveByEmail[email],
      name: studentRow.display_name || null,
    } : null;
    const viewerFlagged = !!email && sh.flagged.has(email);
    const nameFor = (e) => sh.nameByEmail[e] || (e === email && viewer?.name) || 'Anonymous';
    todayLeaders = buildTodayLeaders(sh, email, viewer, viewerFlagged, nameFor);
  }

  let lastWeekLeaders;
  try {
    const lw = await buildLastWeekLeaders(supabase, email, email ? { live: liveByEmail[email], allTime: studentRow?.all_time_minutes || 0 } : null);
    lastWeekLeaders = { weekStart: lw.weekStart, leaders: lw.leaders, viewerRank: lw.viewerRank };
  } catch (e) {
    lastWeekLeaders = { leaders: [] };
  }

  const liveCount = sh ? sh.liveCount : { count: 0, maxCount: 0 };
  return json(200, {
    schedule, lastWeekLeaders, todayLeaders, progress,
    streak: derived ? derived.streak : null,
    subjectProgress,
    pomoSettings: derived ? derived.pomoSettings : null,
    pomoSessions, pomoActive, hourlyActivity, liveCount,
    malpractice: derived ? derived.malpractice : null,
    needsRename: derived ? derived.needsRename : null,
    studentBatch: email ? realBatch : null,
    taskLinks: sched.links,
  });
}
