// GET /api/progress?email=...&month=YYYY-MM
// Returns this student's task completion for the month:
// [{ date, subject, task_text, completed }, ...]
import { getSupabase, json, monthRange } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  const range = monthRange(event.queryStringParameters?.month);
  if (!email) return json(400, { error: 'email is required' });
  if (!range) return json(400, { error: 'month is required, format YYYY-MM' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('task_progress')
    .select('date, subject, task_text, completed')
    .eq('email', email)
    .gte('date', range.start)
    .lt('date', range.end);
  if (error) return json(500, { error: error.message });

  return json(200, { progress: data });
}
