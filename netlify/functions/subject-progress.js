// GET /api/subject-progress?email=...
// Per-subject completion across the FULL schedule, not scoped to a single
// month or to elapsed days — a subject like "Linear Algebra" can span many
// months, so scoping to whatever month happens to be on screen would make
// progress look like it resets every time the student navigates months.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });

  const supabase = getSupabase();

  const { data: scheduled, error: schedErr } = await supabase
    .from('schedule_tasks')
    .select('date, subject, task_text');
  if (schedErr) return json(500, { error: schedErr.message });

  const { data: completed, error: progErr } = await supabase
    .from('task_progress')
    .select('date, subject, task_text')
    .eq('email', email)
    .eq('completed', true);
  if (progErr) return json(500, { error: progErr.message });

  const completedKeys = new Set(completed.map(r => `${r.date}|${r.subject}|${r.task_text}`));

  const totals = {};
  for (const row of scheduled) {
    if (!totals[row.subject]) totals[row.subject] = { done: 0, total: 0 };
    totals[row.subject].total++;
    if (completedKeys.has(`${row.date}|${row.subject}|${row.task_text}`)) totals[row.subject].done++;
  }

  const subjects = Object.keys(totals).map(subject => ({
    subject,
    done: totals[subject].done,
    total: totals[subject].total,
  }));

  return json(200, { subjects });
}
