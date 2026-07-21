// GET /api/schedule?month=YYYY-MM
// Returns every scheduled task for the month, grouped by date:
// [{ date: "2026-08-01", tasks: [{ subject, task_text, position }, ...] }, ...]
import { getSupabase, json, monthRange } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const range = monthRange(event.queryStringParameters?.month);
  if (!range) return json(400, { error: 'month is required, format YYYY-MM' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('schedule_tasks')
    .select('date, subject, task_text, position')
    .gte('date', range.start)
    .lt('date', range.end)
    .order('date', { ascending: true })
    .order('position', { ascending: true });
  if (error) return json(500, { error: error.message });

  const byDate = new Map();
  for (const row of data) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push({ subject: row.subject, task_text: row.task_text, position: row.position });
  }

  const days = [...byDate.entries()].map(([date, tasks]) => ({ date, tasks }));
  return json(200, { days });
}
