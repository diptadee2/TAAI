// GET /api/pomodoro-leaderboard?email=...
// Top students by focus minutes logged *this week* (Mon-start, IST), for
// Focus Mode's weekly leaderboard. Display names are shown publicly by
// design; no email or other identity is returned in the response. The
// optional `email` query param (the viewer's own, if logged in) is only
// used to flag their own row with is_me, never anyone else's.
import { getSupabase, json, weekStartIST, weekBefore, fetchTodayLeaders, fetchLiveStatusByEmail } from './lib/supabase.js';

const LIMIT = 20;

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const viewerEmail = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  const supabase = getSupabase();
  const weekStart = weekStartIST();
  const lastWeekStart = weekBefore(weekStart);

  // This function is polled every 60s during Focus Mode (see LEADERBOARD_POLL_MS in
  // progress.js), so its
  // wall-clock duration (and therefore Functions compute) scales
  // directly with how many Supabase round-trips run one after another.
  // These two queries don't depend on each other's results — the week's
  // stats and today's leaders — so they run concurrently instead of
  // sequentially. Last week's ranks moved to the second batch below (see
  // final_rank) since it now depends on streakEmails.
  const [statsResult, todayLeaders] = await Promise.all([
    supabase.from('pomodoro_stats').select('email, total_minutes, total_sessions').eq('week_start', weekStart).order('total_minutes', { ascending: false }).limit(LIMIT),
    fetchTodayLeaders(supabase, viewerEmail),
  ]);

  const { data: stats, error: statsError } = statsResult;
  if (statsError) return json(500, { error: statsError.message });

  if (!stats.length) return json(200, { leaderboard: [], viewerRank: null, todayLeaders });

  const streakEmails = stats.map(s => s.email);
  if (viewerEmail && !streakEmails.includes(viewerEmail)) streakEmails.push(viewerEmail);

  // Same independence reasoning as above: the display-name+streak lookup,
  // the "live now" lookup, and last week's ranks only need streakEmails,
  // not each other's results. Streak balls shown between name and minutes
  // in the leaderboard UI read the cached students.current_streak column
  // directly now (kept correct by complete-task.js's same-day write and
  // daily-streak-snapshot.js's daily sweep — see CLAUDE.md) instead of
  // recomputing it from schedule_tasks + task_progress on every single
  // 60s poll.
  let studentsResult, liveStatusByEmail, lastWeekRankResult;
  try {
    [studentsResult, liveStatusByEmail, lastWeekRankResult] = await Promise.all([
      supabase.from('students').select('email, display_name, current_streak').in('email', streakEmails),
      fetchLiveStatusByEmail(supabase, streakEmails),
      // Rank-movement arrow, compared to where each student stood at the
      // *end of last week* — a fixed, historical reference point that's
      // identical for every viewer regardless of when they check.
      // final_rank is precomputed once, the first time
      // weekly-rank-snapshot.js runs after that week closes (see
      // schema.sql) — reading it here is a targeted, indexed lookup for
      // just the ~20 emails this poll actually needs, instead of the
      // unbounded "fetch every active student's whole previous week and
      // rank it in JS" query this replaced. Can be null for the small
      // window between a week closing and the next daily snapshot run
      // (up to ~1 hour, see that function's own comment on why it's a
      // daily check rather than a precisely-timed one) — handled the
      // same as "no previous rank at all" (a brand-new student), no
      // arrow shown, not an error.
      supabase.from('pomodoro_stats').select('email, final_rank').eq('week_start', lastWeekStart).in('email', streakEmails),
    ]);
  } catch (err) {
    return json(500, { error: err.message });
  }

  const { data: students, error: studentsError } = studentsResult;
  if (studentsError) return json(500, { error: studentsError.message });
  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));
  const streakByEmail = Object.fromEntries(students.map(s => [s.email, s.current_streak || 0]));

  const { data: lastWeekRanks, error: lastWeekRankError } = lastWeekRankResult;
  if (lastWeekRankError) return json(500, { error: lastWeekRankError.message });
  const lastWeekRankByEmail = Object.fromEntries(lastWeekRanks.filter(r => r.final_rank != null).map(r => [r.email, r.final_rank]));

  // "Live now" status — see fetchLiveStatusByEmail in lib/supabase.js for
  // the exact definition (shared with fetchTodayLeaders, so the daily and
  // weekly boards can't disagree on what counts as "live").
  function pomoFieldsFor(email) {
    return liveStatusByEmail[email] || { is_live: false, pomo_status: null, pomo_phase_end_at: null, pomo_last_seen_at: null };
  }

  const leaderboard = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    total_sessions: s.total_sessions,
    streak: streakByEmail[s.email] || 0,
    previous_week_rank: lastWeekRankByEmail[s.email] ?? null,
    ...pomoFieldsFor(s.email),
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
        streak: streakByEmail[viewerEmail] || 0,
        previous_week_rank: lastWeekRankByEmail[viewerEmail] ?? null,
        ...pomoFieldsFor(viewerEmail),
      };
    }
  }

  // todayLeaders was fetched up front, in parallel with the weekly-stats
  // queries above, so the "Today" card in Focus Mode can auto-refresh
  // alongside the top-20 board on the request that's already happening
  // every 60s — no extra network round-trip, just a modest amount of
  // extra JSON on an existing one. See refreshLeaderboard in progress.js
  // for the client side.
  return json(200, { leaderboard, viewerRank, todayLeaders });
}
