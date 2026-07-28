// GET /api/pomo-sessions?email=...  -> { date, sessionsCompleted }
// Today's (IST) completed work-session count, for Focus Mode's session
// dots — written by pomodoro-complete.js on each genuine completion. A new
// day is simply a new pomo_daily_sessions row, so this resets to 0 at
// midnight IST by construction, no cron job needed.
import { getSupabase, json, todayIST } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });

  const supabase = getSupabase();
  const today = todayIST();

  const { data, error } = await supabase
    .from('pomo_daily_sessions')
    .select('sessions_completed')
    .eq('email', email)
    .eq('date', today)
    .maybeSingle();
  if (error) return json(500, { error: error.message });

  return json(200, { date: today, sessionsCompleted: data?.sessions_completed || 0 });
}
