// GET /api/pomodoro-leaderboard?email=...
// Top students by focus minutes logged *this week* (Mon-start, IST), for
// Focus Mode's weekly leaderboard. Display names are shown publicly by
// design; no email or other identity is returned in the response. The
// optional `email` query param (the viewer's own, if logged in) is only
// used to flag their own row with is_me, never anyone else's.
import { getSupabase, json, weekStartIST, weekBefore, todayForStreak, computeStreak, fetchTodayLeaders, fetchLiveStatusByEmail } from './lib/supabase.js';

const LIMIT = 20;

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const viewerEmail = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  const supabase = getSupabase();
  const weekStart = weekStartIST();
  const lastWeekStart = weekBefore(weekStart);
  const today = todayForStreak();

  // This function is polled every 30s during Focus Mode, so its
  // wall-clock duration (and therefore Functions compute) scales
  // directly with how many Supabase round-trips run one after another.
  // These three queries don't depend on each other's results — the
  // week's stats, the streak's scheduled-dates list, and today's leaders
  // are all independent — so they run concurrently instead of
  // sequentially. Last week's ranks moved to the second batch below
  // (see final_rank) since it now depends on streakEmails.
  const [statsResult, scheduledResult, todayLeaders] = await Promise.all([
    supabase.from('pomodoro_stats').select('email, total_minutes, total_sessions').eq('week_start', weekStart).order('total_minutes', { ascending: false }).limit(LIMIT),
    supabase.from('schedule_tasks').select('date').lte('date', today).order('date', { ascending: false }),
    fetchTodayLeaders(supabase, viewerEmail),
  ]);

  const { data: stats, error: statsError } = statsResult;
  if (statsError) return json(500, { error: statsError.message });

  if (!stats.length) return json(200, { leaderboard: [], viewerRank: null, todayLeaders });

  // Streak balls shown between name and minutes in the leaderboard UI —
  // computed the same way as the single-student /streak endpoint (see
  // computeStreak in lib/supabase.js) so the two can't disagree, but
  // batched: one scheduled-dates query and one task_progress query cover
  // every row (plus the viewer's own row, if they're not already in the
  // top 20) at once, instead of a separate /streak call per row.
  const { data: scheduledForStreak, error: schedError } = scheduledResult;
  if (schedError) return json(500, { error: schedError.message });
  const scheduledDates = [...new Set(scheduledForStreak.map(r => r.date))];

  const streakEmails = stats.map(s => s.email);
  if (viewerEmail && !streakEmails.includes(viewerEmail)) streakEmails.push(viewerEmail);

  // Same independence reasoning as above: the display-name lookup, the
  // completed-tasks lookup, the "live now" lookup, and last week's ranks
  // only need streakEmails, not each other's results.
  let studentsResult, completedResult, liveStatusByEmail, lastWeekRankResult;
  try {
    [studentsResult, completedResult, liveStatusByEmail, lastWeekRankResult] = await Promise.all([
      supabase.from('students').select('email, display_name').in('email', stats.map(s => s.email)),
      supabase.from('task_progress').select('email, date').in('email', streakEmails).eq('completed', true),
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

  const { data: lastWeekRanks, error: lastWeekRankError } = lastWeekRankResult;
  if (lastWeekRankError) return json(500, { error: lastWeekRankError.message });
  const lastWeekRankByEmail = Object.fromEntries(lastWeekRanks.filter(r => r.final_rank != null).map(r => [r.email, r.final_rank]));

  const { data: completedForStreak, error: completedError } = completedResult;
  if (completedError) return json(500, { error: completedError.message });

  const completedByEmail = {};
  completedForStreak.forEach(r => {
    if (!completedByEmail[r.email]) completedByEmail[r.email] = new Set();
    completedByEmail[r.email].add(r.date);
  });
  const streakByEmail = Object.fromEntries(
    streakEmails.map(e => [e, computeStreak(scheduledDates, completedByEmail[e] || new Set(), today)])
  );

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
  // every 30s — no extra network round-trip, just a modest amount of
  // extra JSON on an existing one. See refreshLeaderboard in progress.js
  // for the client side.
  return json(200, { leaderboard, viewerRank, todayLeaders });
}
