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
  // These four queries don't depend on each other's results — the
  // week's stats, last week's stats, the streak's scheduled-dates list,
  // and today's leaders are all independent — so they run concurrently
  // instead of sequentially.
  const [statsResult, lastWeekResult, scheduledResult, todayLeaders] = await Promise.all([
    supabase.from('pomodoro_stats').select('email, total_minutes, total_sessions').eq('week_start', weekStart).order('total_minutes', { ascending: false }).limit(LIMIT),
    supabase.from('pomodoro_stats').select('email, total_minutes').eq('week_start', lastWeekStart).order('total_minutes', { ascending: false }),
    supabase.from('schedule_tasks').select('date').lte('date', today).order('date', { ascending: false }),
    fetchTodayLeaders(supabase, viewerEmail),
  ]);

  const { data: stats, error: statsError } = statsResult;
  if (statsError) return json(500, { error: statsError.message });

  if (!stats.length) return json(200, { leaderboard: [], viewerRank: null, todayLeaders });

  // Rank-movement arrow, compared to where each student stood at the
  // *end of last week* — a fixed, historical reference point that's
  // identical for every viewer regardless of when they check, unlike a
  // client-side "since my last poll" comparison (which is what this
  // used to be — dropped in favor of this, since two different viewers
  // watching at different moments could see different or no arrows for
  // the same student, and a viewer's own very first load never had
  // anything to compare against). Full ranked snapshot of last week
  // (every student, not just this week's top 20) since someone's
  // standing last week can be well outside this week's top 20 — e.g. a
  // jump from #35 to #10 should still show as a real rise.
  const { data: lastWeekStats, error: lastWeekError } = lastWeekResult;
  if (lastWeekError) return json(500, { error: lastWeekError.message });
  const lastWeekRankByEmail = Object.fromEntries(lastWeekStats.map((s, i) => [s.email, i + 1]));

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
  // completed-tasks lookup, and the "live now" lookup only need
  // streakEmails, not each other's results.
  let studentsResult, completedResult, liveStatusByEmail;
  try {
    [studentsResult, completedResult, liveStatusByEmail] = await Promise.all([
      supabase.from('students').select('email, display_name').in('email', stats.map(s => s.email)),
      supabase.from('task_progress').select('email, date').in('email', streakEmails).eq('completed', true),
      fetchLiveStatusByEmail(supabase, streakEmails),
    ]);
  } catch (err) {
    return json(500, { error: err.message });
  }

  const { data: students, error: studentsError } = studentsResult;
  if (studentsError) return json(500, { error: studentsError.message });
  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));

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
