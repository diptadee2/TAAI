// GET /api/last-week-focus-leaders -> { weekStart, leaders: [{ display_name, total_minutes }] }
// Last (fully completed) week's top 5 students by focus minutes logged via
// the pomodoro timer — a recognition panel shown outside Focus Mode on the
// progress tracker, public like the live weekly leaderboard (display names
// shown by design, see pomodoro-leaderboard.js). Reuses pomodoro_stats,
// which already keeps a permanent row per (email, week_start) — nothing
// new to store, this just reads one week back from whatever
// weekStartIST() currently returns.
import { getSupabase, json, weekStartIST } from './lib/supabase.js';

const LIMIT = 5;

function lastWeekStart() {
  const d = new Date(weekStartIST() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const supabase = getSupabase();
  const weekStart = lastWeekStart();

  const { data: stats, error: statsError } = await supabase
    .from('pomodoro_stats')
    .select('email, total_minutes')
    .eq('week_start', weekStart)
    .order('total_minutes', { ascending: false })
    .limit(LIMIT);
  if (statsError) return json(500, { error: statsError.message });

  if (!stats.length) return json(200, { weekStart, leaders: [] });

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('email, display_name')
    .in('email', stats.map(s => s.email));
  if (studentsError) return json(500, { error: studentsError.message });

  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));
  const leaders = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
  }));

  return json(200, { weekStart, leaders });
}
