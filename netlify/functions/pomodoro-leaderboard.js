// GET /api/pomodoro-leaderboard?email=...
// Top students by focus minutes logged *this week* (Mon-start, IST), for
// Focus Mode's weekly leaderboard. Display names are shown publicly by
// design; no email or other identity is returned in the response. The
// optional `email` query param (the viewer's own, if logged in) is only
// used to flag their own row with is_me, never anyone else's.
import { getSupabase, json, weekStartIST } from './lib/supabase.js';

const LIMIT = 20;

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const viewerEmail = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  const supabase = getSupabase();
  const weekStart = weekStartIST();

  const { data: stats, error: statsError } = await supabase
    .from('pomodoro_stats')
    .select('email, total_minutes, total_sessions')
    .eq('week_start', weekStart)
    .order('total_minutes', { ascending: false })
    .limit(LIMIT);
  if (statsError) return json(500, { error: statsError.message });

  if (!stats.length) return json(200, { leaderboard: [], viewerRank: null });

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
    is_me: !!viewerEmail && s.email === viewerEmail,
  }));

  // A logged-in viewer who didn't make the top 20 otherwise sees zero
  // indication of their own standing — the query above simply never
  // fetches their row. Look it up separately so Focus Mode can still show
  // them where they stand. Rank is computed as "how many students have
  // strictly more minutes than me, plus one" rather than something
  // stored, since it has to reflect the live leaderboard order.
  let viewerRank = null;
  const viewerInTop = leaderboard.some(r => r.is_me);
  if (viewerEmail && !viewerInTop) {
    const { data: viewerStats, error: viewerError } = await supabase
      .from('pomodoro_stats')
      .select('total_minutes, total_sessions')
      .eq('email', viewerEmail)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (viewerError) return json(500, { error: viewerError.message });

    if (viewerStats) {
      const { count, error: countError } = await supabase
        .from('pomodoro_stats')
        .select('*', { count: 'exact', head: true })
        .eq('week_start', weekStart)
        .gt('total_minutes', viewerStats.total_minutes);
      if (countError) return json(500, { error: countError.message });

      viewerRank = {
        rank: (count || 0) + 1,
        total_minutes: viewerStats.total_minutes,
        total_sessions: viewerStats.total_sessions,
      };
    }
  }

  return json(200, { leaderboard, viewerRank });
}
