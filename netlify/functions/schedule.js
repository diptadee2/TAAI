// GET /api/schedule?month=YYYY-MM
// Returns every scheduled task for the month, grouped by date:
// [{ date: "2026-08-01", tasks: [{ subject, task_text, position }, ...] }, ...]
// Also returns latestMonth — the latest month with any schedule data at
// all, regardless of which month was requested — so progress.js can
// disable month-nav's "next" arrow past it. Schedule data is uploaded
// manually per the user's own PDFs/CSVs (see CLAUDE.md), so this changes
// every time a new month gets loaded; computing it here instead of
// hardcoding a constant means nothing needs to be remembered/bumped
// whenever that happens.
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

  const { data: latestRow, error: latestError } = await supabase
    .from('schedule_tasks')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) return json(500, { error: latestError.message });

  return json(200, { days, latestMonth: latestRow ? latestRow.date.slice(0, 7) : null });
}
