// POST /api/complete-task  { email, date, subject, task_text, completed }
// Ticks/unticks one task. Task identity is (email, date, subject, task_text)
// per the schema, so if a sheet edit changes a cell's text after a student
// has ticked it, that tick is orphaned by design — the sheet is the source
// of truth, not the old wording.
import { getSupabase, json, todayForStreak, computeStreak, fetchAllRows } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const date = String(body.date || '').trim();
  const subject = String(body.subject || '').trim();
  const taskText = String(body.task_text || '').trim();
  const completed = Boolean(body.completed);

  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !subject || !taskText) {
    return json(400, { error: 'email, date (YYYY-MM-DD), subject, task_text are required' });
  }

  const supabase = getSupabase();
  const { error } = await supabase.from('task_progress').upsert(
    {
      email,
      date,
      subject,
      task_text: taskText,
      completed,
      completed_at: completed ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'email,date,subject,task_text' }
  );
  if (error) return json(500, { error: error.message });

  // Same-day half of the streak-caching change — daily-streak-snapshot.js
  // (the other half) only runs once a day, so without this a completion
  // wouldn't show up in current_streak until tomorrow. Recomputes and
  // writes just THIS student's streak, awaited before responding rather
  // than fired-and-forgotten after — Netlify Functions don't reliably
  // keep running background work once a response has been sent, so
  // "respond now, update the streak later" isn't a safe pattern here,
  // it could just never happen. Runs unconditionally (tick or untick),
  // since undoing a completion can lower a streak just as much as
  // completing one can raise it. A failure here doesn't fail the whole
  // request — the task itself is already saved by this point, and a
  // stale current_streak is a display nicety that the next daily job (or
  // this student's own next completion) will correct, not something
  // worth losing their actual checkbox click over.
  try {
    const today = todayForStreak();
    const [{ data: scheduled, error: schedErr }, completedRows] = await Promise.all([
      supabase.from('schedule_tasks').select('date').lte('date', today).order('date', { ascending: false }),
      fetchAllRows(() => supabase.from('task_progress').select('date').eq('email', email).eq('completed', true).lte('date', today)),
    ]);
    if (!schedErr) {
      const scheduledDates = [...new Set(scheduled.map(r => r.date))];
      const completedDates = new Set(completedRows.map(r => r.date));
      const streak = computeStreak(scheduledDates, completedDates, today);
      await supabase.from('students').update({ current_streak: streak }).eq('email', email);
    }
  } catch (streakErr) {
    console.error('complete-task.js: failed to update current_streak for', email, streakErr);
  }

  return json(200, { ok: true });
}
