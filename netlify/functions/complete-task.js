// POST /api/complete-task  { email, date, subject, task_text, completed }
// Ticks/unticks one task. Task identity is (email, date, subject, task_text)
// per the schema, so if a sheet edit changes a cell's text after a student
// has ticked it, that tick is orphaned by design — the sheet is the source
// of truth, not the old wording.
import { getSupabase, json } from './lib/supabase.js';

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

  return json(200, { ok: true });
}
