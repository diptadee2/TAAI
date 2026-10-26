// GET   /api/team-students          -> every student with performance
//                                       metrics + notes, for /team's
//                                       Students view (identifying high
//                                       performers, dropped-off students,
//                                       etc.)
// PATCH /api/team-students { email, notes } -> update one student's notes
//
// Role-gated the same as team-posts.js. Computes everything from full
// history in a small, fixed number of batch queries (one per table, not
// one per student) rather than looping per-student queries.
//
// Streak reads the cached students.current_streak column directly (see
// complete-task.js and daily-streak-snapshot.js for how it's kept up to
// date) instead of recomputing it from schedule_tasks + task_progress —
// the query for that scheduled-dates list has been removed entirely, it
// had no other consumer in this file.
//
// task_progress and pomo_daily_sessions specifically go through
// fetchAllRows, not a plain .select() — a real, already-shipped bug,
// confirmed directly: PostgREST caps a single response at 1,000 rows
// regardless of how many actually match, and both tables already exceed
// that (2,595 completed task_progress rows, 1,112 pomo_daily_sessions
// rows, as of 2026-09-06). A plain unbounded query here was silently
// returning only the first page and building every student's all-time
// hours, last-active date, and consistency figure from an incomplete
// slice of the real data, with no error — it just looked like a normal
// response.
import { getSupabase, json, requireAdmin, todayForStreak, weekStartIST, fetchAllRows } from './lib/supabase.js';

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

    // Only the fields sent are changed: notes, and/or the Ranker's batch tag
    // (2026-10-26; rankers_batch_at records when it was added).
    const patch = {};
    if ('notes' in body) patch.notes = body.notes || null;
    if ('rankers_batch' in body) { patch.rankers_batch = !!body.rankers_batch; patch.rankers_batch_at = body.rankers_batch ? new Date().toISOString() : null; }
    if (!Object.keys(patch).length) return json(400, { error: 'nothing to update' });
    const { error } = await supabase.from('students').update(patch).eq('email', email);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const today = todayForStreak();

  let studentsResult, completed, sessions, weekStatsResult, taskBatchRows, malpracticeResult, nameCheckResult, reviewNoteResult, batchResult, rankersResult;
  try {
    [studentsResult, completed, sessions, weekStatsResult, taskBatchRows, malpracticeResult, nameCheckResult, reviewNoteResult, batchResult, rankersResult] = await Promise.all([
      // needs_rename itself is included directly here, not in the
      // best-effort query below — it was already migrated in a prior
      // session (see schema.sql's own comment on it) and is stable, so
      // mixing it into the SAME select as the genuinely-new
      // needs_rename_source/name_check_reason columns would be a real
      // bug: PostgREST fails a select ENTIRELY if even one requested
      // column doesn't exist, which would mask this already-correct,
      // already-migrated value behind the two not-yet-migrated ones'
      // failure — the exact mistake this codebase's own history already
      // flags (see malpractice_warning_ack_count's writeup in CLAUDE.md).
      // batch is NOT added here for the exact same reason — see its own
      // best-effort query below instead.
      supabase.from('students').select('email, display_name, notes, created_at, current_streak, needs_rename'),
      fetchAllRows(() => supabase.from('task_progress').select('email, date, subject, task_text, completed_at').eq('completed', true).lte('date', today)),
      fetchAllRows(() => supabase.from('pomo_daily_sessions').select('email, date, total_minutes')),
      supabase.from('pomodoro_stats').select('email, total_minutes').eq('week_start', weekStartIST()),
      // Whole-schedule task count, per batch (not date-limited) — the same
      // denominator subject-progress.js uses for its per-subject done/
      // total, here rolled into one overall "how much of the course"
      // percentage instead of a per-subject breakdown, which wouldn't fit
      // a table with 300 rows. schedule_tasks only ever holds months
      // already loaded (see "Schedule data flow" in CLAUDE.md), so this is
      // naturally "tasks assigned so far", not some far-future total.
      // Was a count-only HEAD request (one shared total, no batch
      // dimension) until second-batch support — supabase-js can't GROUP BY
      // in a head-count query, so this is now a real (paginated, via
      // fetchAllRows for the same >1,000-row reason task_progress/
      // pomo_daily_sessions above already need it) fetch of just `batch`,
      // counted client-side per batch below. Wrapped in its own try/catch,
      // NOT left to fetchAllRows' own throw-on-error — that throw is
      // exactly right for completed/sessions above (a real failure there
      // should fail this whole view), but a still-new `batch` column
      // missing pre-migration must degrade to "no totals yet" instead of
      // taking down the entire Students view the way an actually-broken
      // schedule_tasks table would.
      (async () => {
        try { return await fetchAllRows(() => supabase.from('schedule_tasks').select('batch, date, subject, task_text')); }
        catch { return []; }
      })(),
      // Best-effort, deliberately its own query rather than added to the
      // main students select above — see record_malpractice_incident in
      // schema.sql. A pre-migration "column does not exist" error here
      // must never fail the WHOLE Students view the way a missing
      // display_name/streak legitimately would.
      supabase.from('students').select('email, malpractice_incident_count, malpractice_offense_count, malpractice_frozen_until'),
      // Same best-effort, own-query treatment as malpractice above —
      // only the genuinely-new columns here, needs_rename itself is in
      // the main select above (see its own comment for why they can't
      // share one query). gate_escalated added alongside the other two
      // — safe to combine since all three are equally not-yet-migrated
      // at the time this was added, so there's no already-stable column
      // to accidentally mask.
      supabase.from('students').select('email, needs_rename_source, name_check_reason, gate_escalated'),
      // name_review_note is its OWN separate query, NOT combined into
      // the one above — a real regression caught during testing: by the
      // time this column was added, needs_rename_source/name_check_reason/
      // gate_escalated were already migrated and stable, so bundling a
      // still-pending column in with them would have masked all three
      // already-working fields behind this one's own missing-column
      // error, the exact mistake this file's own comment above already
      // warns about (and, unlike here, that comment was already
      // outdated the moment name_review_note landed — kept in mind for
      // next time a "genuinely new" column joins an already-settled one).
      supabase.from('students').select('email, name_review_note'),
      // batch (added 2026-09-28) — its own best-effort query, same
      // discipline as malpractice/nameCheck/reviewNote above: a
      // pre-migration missing-column error here must never fail the
      // whole Students view, it just leaves every student defaulting to
      // 'C' below (batchByEmail) until the migration runs.
      supabase.from('students').select('email, batch'),
      // Ranker's batch tag (2026-10-26), own best-effort query: before the
      // column exists nobody is tagged and nothing else breaks.
      supabase.from('students').select('email, rankers_batch, rankers_batch_at'),
    ]);
  } catch (err) {
    return json(500, { error: err.message });
  }
  const { data: students, error: studentsErr } = studentsResult;
  const { data: weekStats, error: weekErr } = weekStatsResult;
  const err = studentsErr || weekErr;
  if (err) return json(500, { error: err.message });

  // Per batch, replacing the old single shared totalTaskCount — see
  // taskBatchRows' own comment above for why this is a best-effort,
  // already-fault-tolerant fetch (empty array on failure, not a thrown
  // error), so no additional error-checking is needed here.
  const taskCountByBatch = new Map();
  // batch -> Set of "date|subject|task_text" for every task currently in that
  // batch's schedule. Course progress only counts ticks that match one of these
  // (2026-10-22): a schedule reload replaces tasks, but the old ticks stay in
  // task_progress, so counting every tick put two students at 109%.
  const taskKeysByBatch = new Map();
  for (const row of taskBatchRows) {
    const batch = row.batch || 'C';
    taskCountByBatch.set(batch, (taskCountByBatch.get(batch) || 0) + 1);
    if (!taskKeysByBatch.has(batch)) taskKeysByBatch.set(batch, new Set());
    taskKeysByBatch.get(batch).add(row.date + '|' + row.subject + '|' + row.task_text);
  }

  // For the performance score (2026-10-26): each batch's scheduled tasks and
  // days up to today only, so future, not-yet-due tasks don't count against
  // anyone.
  const keysToDateByBatch = new Map(), datesToDateByBatch = new Map();
  for (const row of taskBatchRows) {
    if (row.date > today) continue;
    const batch = row.batch || 'C';
    if (!keysToDateByBatch.has(batch)) { keysToDateByBatch.set(batch, new Set()); datesToDateByBatch.set(batch, new Set()); }
    keysToDateByBatch.get(batch).add(row.date + '|' + row.subject + '|' + row.task_text);
    datesToDateByBatch.get(batch).add(row.date);
  }
  const rankersByEmail = new Map();
  if (rankersResult && !rankersResult.error) {
    for (const row of rankersResult.data || []) if (row.rankers_batch) rankersByEmail.set(row.email, row.rankers_batch_at || true);
  }

  const batchByEmail = new Map();
  if (!batchResult.error) {
    for (const row of batchResult.data || []) {
      batchByEmail.set(row.email, row.batch);
    }
  }

  const malpracticeByEmail = new Map();
  if (!malpracticeResult.error) {
    for (const row of malpracticeResult.data || []) {
      malpracticeByEmail.set(row.email, row);
    }
  }

  const nameCheckByEmail = new Map();
  if (!nameCheckResult.error) {
    for (const row of nameCheckResult.data || []) {
      nameCheckByEmail.set(row.email, row);
    }
  }

  const reviewNoteByEmail = new Map();
  if (!reviewNoteResult.error) {
    for (const row of reviewNoteResult.data || []) {
      reviewNoteByEmail.set(row.email, row.name_review_note);
    }
  }

  const completedByEmail = new Map(); // email -> Set(date), for streak
  const taskCountByEmail = new Map(); // email -> completed task count
  for (const row of completed) {
    if (!completedByEmail.has(row.email)) completedByEmail.set(row.email, new Set());
    completedByEmail.get(row.email).add(row.date);
    const keys = taskKeysByBatch.get(batchByEmail.get(row.email) || 'C');
    // No schedule rows at all (best-effort fetch failed): count every tick, as before.
    if (keys && !keys.has(row.date + '|' + row.subject + '|' + row.task_text)) continue;
    taskCountByEmail.set(row.email, (taskCountByEmail.get(row.email) || 0) + 1);
  }

  const minutesByEmail = new Map(); // email -> total minutes, all-time
  const lastActiveByEmail = new Map(); // email -> latest date seen
  const monthMinutesByEmailDate = new Map(); // email -> { 'YYYY-MM-DD': minutes }, this month only
  const currentMonth = today.slice(0, 7);
  // Rolling last 30 days: today and the 29 days before it (IST dates).
  const last30Start = new Date(Date.parse(today + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
  const last30MinutesByEmail = new Map();
  for (const row of sessions) {
    if (row.date >= last30Start && row.date <= today) last30MinutesByEmail.set(row.email, (last30MinutesByEmail.get(row.email) || 0) + (row.total_minutes || 0));
    minutesByEmail.set(row.email, (minutesByEmail.get(row.email) || 0) + (row.total_minutes || 0));
    const prev = lastActiveByEmail.get(row.email);
    if (!prev || row.date > prev) lastActiveByEmail.set(row.email, row.date);
    if (row.date.slice(0, 7) === currentMonth) {
      if (!monthMinutesByEmailDate.has(row.email)) monthMinutesByEmailDate.set(row.email, {});
      monthMinutesByEmailDate.get(row.email)[row.date] = row.total_minutes;
    }
  }
  // "Last active" also counts ticking a task (2026-10-26): the day they
  // ticked it (IST), not the task's own date, so catching up on old days
  // still counts as being active today. Before this only focus sessions
  // counted, and students who tick but never use the timer showed "Never".
  for (const row of completed) {
    if (!row.completed_at) continue;
    const d = new Date(new Date(row.completed_at).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    if (d > today) continue;
    const prev = lastActiveByEmail.get(row.email);
    if (!prev || d > prev) lastActiveByEmail.set(row.email, d);
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

  // Performance score (2026-10-26, for picking high performers): 40% progress
  // on tasks due so far, 40% consistency (half: share of the batch's scheduled
  // days, from its first day, with at least one tick; half: typical daily
  // focus time, the median over the last 45 days, quiet days as 0, 2h+ = full
  // marks). Both consistency halves count days before a student joined as
  // missed, so a late joiner can't match months of steady work in a few
  // weeks (2026-10-26),
  // 20% streak (70% longest streak ever
  // relative to the batch's best, 30% current streak). Compared within each
  // student's own batch.
  const last45 = new Date(Date.parse(today + 'T00:00:00Z') - 44 * 86400000).toISOString().slice(0, 10);
  const tickDaysByEmail = new Map(), dueDoneByEmail = new Map();
  for (const row of completed) {
    const keys = keysToDateByBatch.get(batchByEmail.get(row.email) || 'C');
    if (!keys || !keys.has(row.date + '|' + row.subject + '|' + row.task_text)) continue;
    dueDoneByEmail.set(row.email, (dueDoneByEmail.get(row.email) || 0) + 1);
    if (!tickDaysByEmail.has(row.email)) tickDaysByEmail.set(row.email, new Set());
    tickDaysByEmail.get(row.email).add(row.date);
  }
  // Focus time per day over the last 45 days (for the consistency half that
  // measures how much they actually study, not just whether they showed up).
  const focus45ByEmail = new Map(); // email -> { date: minutes }
  for (const row of sessions) {
    if (row.date < last45 || row.date > today) continue;
    if (!focus45ByEmail.has(row.email)) focus45ByEmail.set(row.email, {});
    focus45ByEmail.get(row.email)[row.date] = (focus45ByEmail.get(row.email)[row.date] || 0) + (row.total_minutes || 0);
  }
  const FOCUS_FULL_MARKS_MIN = 120; // a typical day of 2h+ focus earns full marks for that half
  const perf = new Map();
  for (const s of students) {
    const batch = batchByEmail.get(s.email) || 'C';
    const keys = keysToDateByBatch.get(batch) || new Set(), dates = datesToDateByBatch.get(batch) || new Set();
    const ticks = tickDaysByEmail.get(s.email) || new Set();
    const joined = String(s.created_at || today).slice(0, 10);
    const all = [...new Set([...dates, ...ticks])].sort();
    const eligible = all.filter(d => d < today || ticks.has(d));
    const tickRatio = eligible.length ? eligible.filter(d => ticks.has(d)).length / eligible.length : 0;
    let run = 0, longest = 0;
    for (const d of all) { if (ticks.has(d)) { run++; if (run > longest) longest = run; } else if (d !== today) run = 0; }
    // Median daily focus minutes over the last 45 days, quiet days (and days
    // before joining) counted as 0, the same idea as the Consistency column.
    const winStart = last45;
    const fm = focus45ByEmail.get(s.email) || {}, perDay = [];
    for (let t = Date.parse(winStart + 'T00:00:00Z'); t <= Date.parse(today + 'T00:00:00Z'); t += 86400000) perDay.push(fm[new Date(t).toISOString().slice(0, 10)] || 0);
    const focusMedian = median(perDay);
    const focusRatio = Math.min(1, focusMedian / FOCUS_FULL_MARKS_MIN);
    // Time in batch, for the early-joiner penalty: days since joining over
    // days since the batch's first scheduled day (0 = just joined, 1 = from day one).
    const batchStart = all.length ? all[0] : today;
    const span = Math.max(1, (Date.parse(today + 'T00:00:00Z') - Date.parse(batchStart + 'T00:00:00Z')) / 86400000);
    const inFor = Math.max(0, (Date.parse(today + 'T00:00:00Z') - Date.parse((joined > batchStart ? joined : batchStart) + 'T00:00:00Z')) / 86400000);
    const tenure = Math.min(1, inFor / span);
    perf.set(s.email, { batch, focusMedian, tenure, daysInactive: daysInactiveFor(lastActiveByEmail.get(s.email) || null), progress: keys.size ? Math.min(1, (dueDoneByEmail.get(s.email) || 0) / keys.size) : 0, tickRatio, focusRatio, longest, current: s.current_streak || 0 });
  }
  const bestLongest = new Map();
  for (const v of perf.values()) bestLongest.set(v.batch, Math.max(bestLongest.get(v.batch) || 1, v.longest));
  for (const v of perf.values()) {
    const best = bestLongest.get(v.batch) || 1;
    // Early joiners who are behind lose up to 15 points (2026-10-26, "if they
    // joined early but are underperforming, negative marking"): scaled by
    // time in batch and by how far under 50% progress they are; nothing at
    // 50% progress or more, nothing for someone who just joined.
    v.penalty = Math.round(15 * v.tenure * Math.max(0, (0.5 - v.progress) / 0.5));
    // Gone quiet (2026-10-26, "recent activity"): no tick and no focus
    // session for 7+ days costs 3 points, rising to 10 at 30+ days; never
    // active at all, 10.
    const di = v.daysInactive;
    v.inactivePenalty = di == null ? 10 : di < 7 ? 0 : Math.round(3 + 7 * Math.min(1, (di - 7) / 23));
    v.score = Math.max(0, -v.inactivePenalty + Math.round(100 * (0.4 * v.progress + 0.4 * (0.5 * v.tickRatio + 0.5 * v.focusRatio) + 0.2 * (0.7 * v.longest / best + 0.3 * Math.min(1, v.current / best)))) - v.penalty);
  }

  const rows = students.map(s => {
    const lastActive = lastActiveByEmail.get(s.email) || null;
    const malpractice = malpracticeByEmail.get(s.email);
    const nameCheck = nameCheckByEmail.get(s.email);
    // Each student's own batch's total, not one shared number across
    // batches — see taskCountByBatch above. batchByEmail (not s.batch —
    // see its own query above for why) falls back to 'C' the same way
    // the schema itself does.
    const batchTaskTotal = taskCountByBatch.get(batchByEmail.get(s.email) || 'C') || 0;
    return {
      email: s.email,
      display_name: s.display_name,
      notes: s.notes || '',
      created_at: s.created_at,
      total_minutes: minutesByEmail.get(s.email) || 0,
      week_minutes: weekMinutesByEmail.get(s.email) || 0,
      last30_minutes: last30MinutesByEmail.get(s.email) || 0,
      score: perf.get(s.email).score,
      due_progress_pct: Math.round(perf.get(s.email).progress * 100),
      tick_day_pct: Math.round(perf.get(s.email).tickRatio * 100),
      focus_day_pct: Math.round(perf.get(s.email).focusRatio * 100),
      focus_median_45_minutes: Math.round(perf.get(s.email).focusMedian),
      score_penalty: perf.get(s.email).penalty,
      inactive_penalty: perf.get(s.email).inactivePenalty,
      longest_streak: perf.get(s.email).longest,
      rankers_batch: rankersByEmail.has(s.email),
      rankers_batch_at: typeof rankersByEmail.get(s.email) === 'string' ? rankersByEmail.get(s.email) : null,
      streak: s.current_streak || 0,
      tasks_completed: taskCountByEmail.get(s.email) || 0,
      progress_pct: batchTaskTotal > 0 ? Math.min(100, Math.round(((taskCountByEmail.get(s.email) || 0) / batchTaskTotal) * 100)) : 0,
      batch: batchByEmail.get(s.email) || 'C',
      consistency_minutes: consistencyFor(s.email),
      last_active: lastActive,
      days_inactive: daysInactiveFor(lastActive),
      // See record_malpractice_incident in schema.sql — for spotting
      // repeat cheat attempts. malpractice_frozen_until is only meaningful
      // if it's still in the future; a past one just means a freeze that
      // already expired, not an active one.
      malpractice_incident_count: malpractice?.malpractice_incident_count || 0,
      malpractice_offense_count: malpractice?.malpractice_offense_count || 0,
      malpractice_frozen_until: malpractice?.malpractice_frozen_until || null,
      // See students.needs_rename in schema.sql — needs_rename_source
      // ('admin' | 'ai_scan') tells the Students view whether a flag
      // already has a Claude judgment behind it (name_check_reason)
      // or is purely a human call awaiting one.
      needs_rename: s.needs_rename || false,
      needs_rename_source: nameCheck?.needs_rename_source || null,
      name_check_reason: nameCheck?.name_check_reason || null,
      // Whether this student has burned all 3 real gated attempts this
      // month and is blocked until a team member clears it (see
      // schema.sql's own comment on gate_escalated) — backs the
      // "Clear block" / "Rename" actions in the Students view.
      gate_escalated: nameCheck?.gate_escalated || false,
      // Advisory-only, never gates anyone — see schema.sql's own comment
      // on name_review_note. Shown regardless of needs_rename, since the
      // whole point is catching a name Claude itself judged fine.
      name_review_note: reviewNoteByEmail.get(s.email) || null,
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
    malpractice_flagged: rows.filter(r => r.malpractice_incident_count > 0).length,
    needs_rename_flagged: rows.filter(r => r.needs_rename).length,
    gate_escalated_count: rows.filter(r => r.gate_escalated).length,
  };

  return json(200, { students: rows, summary });
}
