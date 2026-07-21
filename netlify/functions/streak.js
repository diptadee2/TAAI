// GET /api/streak?email=...
// Consecutive-day streak, computed from full history (not just the visible
// month) so it doesn't reset when the student flips to a different month.
// A "day" only counts toward or against the streak if something was
// actually scheduled that day — rest days with nothing assigned neither
// extend nor break it. Today gets a pass if nothing's ticked yet, since
// the day isn't over.
import { getSupabase, json, todayIST } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });

  const supabase = getSupabase();
  const today = todayIST();

  const { data: scheduled, error: schedErr } = await supabase
    .from('schedule_tasks')
    .select('date')
    .lte('date', today)
    .order('date', { ascending: false });
  if (schedErr) return json(500, { error: schedErr.message });

  const scheduledDates = [...new Set(scheduled.map(r => r.date))];

  const { data: completed, error: progErr } = await supabase
    .from('task_progress')
    .select('date')
    .eq('email', email)
    .eq('completed', true);
  if (progErr) return json(500, { error: progErr.message });

  const completedDates = new Set(completed.map(r => r.date));

  let streak = 0;
  for (const date of scheduledDates) {
    if (completedDates.has(date)) { streak++; continue; }
    if (date === today) continue;
    break;
  }

  return json(200, { streak });
}
