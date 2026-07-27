// GET /api/pomodoro-leaderboard
// Top students by focus minutes logged *this week* (Mon-start, IST), for
// Focus Mode's weekly leaderboard. Display names are shown publicly by
// design; no email or other identity is returned.
import { getSupabase, json, weekStartIST } from './lib/supabase.js';

const LIMIT = 20;

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const supabase = getSupabase();

  const { data: stats, error: statsError } = await supabase
    .from('pomodoro_stats')
    .select('email, total_minutes, total_sessions')
    .eq('week_start', weekStartIST())
    .order('total_minutes', { ascending: false })
    .limit(LIMIT);
  if (statsError) return json(500, { error: statsError.message });

  if (!stats.length) return json(200, { leaderboard: [] });

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('email, display_name')
    .in('email', stats.map(s => s.email));
  if (studentsError) return json(500, { error: studentsError.message });

  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));
  const leaderboard = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    total_sessions: s.total_sessions,
  }));

  return json(200, { leaderboard });
}
