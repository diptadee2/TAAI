// Scheduled function (see netlify.toml) — runs once a day and recomputes
// EVERY student's streak, storing it in students.current_streak.
//
// This is the half of the streak-caching change that handles a streak
// changing *without* a write happening: a student who simply stops doing
// tasks should see their streak correctly reach 0 the next time anyone
// looks, even though no task_progress row was ever written to trigger
// that. complete-task.js (the other half) handles the opposite case —
// updating the ONE student who just ticked something, immediately, so
// today's completion shows up right away instead of waiting for this
// job to run again.
//
// Same batched-query shape team-students.js already uses for every
// student at once (one scheduled-dates query, one task_progress query
// covering everyone, grouped by email in JS) — not a per-student query
// loop, and not a new algorithm: this calls the exact same
// computeStreak() every other streak-computing call site already uses,
// so there's no way for this job's numbers to disagree with what
// complete-task.js or the (still-live, unswitched) read sites compute.
// Uses fetchAllRows for the task_progress fetch specifically — see that
// helper's own comment in lib/supabase.js for a real, already-shipped
// bug this caught: task_progress already has thousands of completed
// rows, past PostgREST's default per-response cap, so team-students.js's
// identical unbounded query (already live) has been silently building
// its streak/task-count numbers from an incomplete slice of real data
// the whole time. Fixed there too, same commit.
import { getSupabase, json, todayForStreak, computeStreak, fetchAllRows } from './lib/supabase.js';

export async function handler() {
  const supabase = getSupabase();
  const today = todayForStreak();

  let studentsResult, scheduledResult, completed;
  try {
    [studentsResult, scheduledResult, completed] = await Promise.all([
      supabase.from('students').select('email'),
      supabase.from('schedule_tasks').select('date').lte('date', today).order('date', { ascending: false }),
      fetchAllRows(() => supabase.from('task_progress').select('email, date').eq('completed', true).lte('date', today)),
    ]);
  } catch (err) {
    return json(500, { error: err.message });
  }
  const { data: students, error: studentsErr } = studentsResult;
  const { data: scheduled, error: schedErr } = scheduledResult;
  const err = studentsErr || schedErr;
  if (err) return json(500, { error: err.message });

  const scheduledDates = [...new Set(scheduled.map(r => r.date))];

  const completedByEmail = new Map();
  for (const row of completed) {
    if (!completedByEmail.has(row.email)) completedByEmail.set(row.email, new Set());
    completedByEmail.get(row.email).add(row.date);
  }

  const emails = students.map(s => s.email);
  const streaks = students.map(s => computeStreak(scheduledDates, completedByEmail.get(s.email) || new Set(), today));

  // A real UPDATE via update_student_streaks (see schema.sql), not
  // .upsert() — a partial-column upsert here fails outright, since
  // Postgres validates an INSERT ... ON CONFLICT's candidate row against
  // NOT NULL constraints (students.display_name has one) before it even
  // checks for a conflict, even though every row here already exists and
  // should only ever hit the UPDATE branch. Confirmed this exact failure
  // mode directly on a disposable test student before reaching this fix.
  const { error: rpcError } = await supabase.rpc('update_student_streaks', { p_emails: emails, p_streaks: streaks });
  if (rpcError) return json(500, { error: rpcError.message });

  return json(200, { students_updated: emails.length });
}
