// GET /api/pomodoro-leaderboard?email=...
// Top students by focus minutes logged *this week* (Mon-start, IST), for
// Focus Mode's weekly leaderboard. Display names are shown publicly by
// design; no email or other identity is returned in the response. The
// optional `email` query param (the viewer's own, if logged in) is only
// used to flag their own row with is_me, never anyone else's.
import { getSupabase, json, weekStartIST, weekBefore, fetchTodayLeaders, fetchLiveStatusByEmail, fetchLiveCount, fetchAllTimeMinutesByEmail, fetchFlaggedEmails, notInEmailList } from './lib/supabase.js';

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
  // liveCount rides along here too, same reasoning as todayLeaders below —
  // the Today card's busy meter (progress.js) used to poll its own
  // separate /api/live-count endpoint every 60s regardless of context,
  // which meant a genuinely new always-on background request for every
  // viewer. This poll and last-week-leaders.js's together already cover
  // both contexts the Today card can appear in (Focus Mode vs. the plain
  // checklist, mutually exclusive), so folding it into both existing 60s
  // polls instead means zero extra requests, not a smaller third one.
  const [statsResult, todayLeaders, liveCount, flaggedEmails] = await Promise.all([
    // Secondary tiebreak (email) added alongside the same fix in
    // fetchTodayLeaders — without one, two students on equal minutes
    // land in whatever order Postgres happens to return, which isn't
    // guaranteed stable across repeated polls. Deliberately still
    // LIMIT 20 + a query here, not a full fetch-and-sort-in-JS like
    // fetchTodayLeaders' fix — pomodoro_stats scales with total active
    // students, not (bounded) daily activity, and this endpoint is
    // polled every 60s per viewer; see the viewer-rank fix below for how
    // the tiebreak stays consistent without an unbounded fetch.
    supabase.from('pomodoro_stats').select('email, total_minutes, total_sessions').eq('week_start', weekStart).order('total_minutes', { ascending: false }).order('email', { ascending: true }).limit(LIMIT),
    fetchTodayLeaders(supabase, viewerEmail),
    // Non-critical — a live-count hiccup (or, pre-migration, the table
    // simply not existing yet) must never fail the whole leaderboard poll.
    fetchLiveCount(supabase).catch(() => ({ count: 0, maxCount: 0 })),
    // See fetchFlaggedEmails' own comment — a gated student is excluded
    // from this board entirely (added on direct request). Fetched here
    // in parallel rather than sequentially first, to avoid adding a
    // round-trip to an endpoint polled every 60s — this does mean
    // fetchTodayLeaders above does its own separate, equally-cheap fetch
    // of the same thing rather than sharing this one, a small accepted
    // duplication in exchange for zero added latency on the common case.
    fetchFlaggedEmails(supabase),
  ]);

  const { data: rawStats, error: statsError } = statsResult;
  if (statsError) return json(500, { error: statsError.message });

  // Filtered here (post-fetch, in JS) rather than as a DB-side NOT IN on
  // the query above, for the same latency reason as fetching flaggedEmails
  // in parallel — the LIMIT-20 query would need flaggedEmails resolved
  // BEFORE it could apply that filter, which would force it to wait on a
  // sequential lookup first. Accepted tradeoff: if a currently-flagged
  // student happens to already be within the raw top 20, the board can
  // show fewer than 20 rows until their gate resolves or they naturally
  // drop out of the raw top 20, rather than perfectly backfilling with
  // whoever's actually 21st — self-corrects on the very next 60s poll
  // regardless, and this should be a rare, momentary state by design
  // (this whole feature is built to have very few students simultaneously
  // flagged and unresolved).
  const stats = rawStats.filter((s) => !flaggedEmails.has(s.email));

  if (!stats.length) return json(200, { leaderboard: [], viewerRank: null, todayLeaders, liveCount });

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
  let studentsResult, liveStatusByEmail, lastWeekRankResult, allTimeMinutesByEmail;
  try {
    [studentsResult, liveStatusByEmail, lastWeekRankResult, allTimeMinutesByEmail] = await Promise.all([
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
      // Best-effort — see all_time_minutes in schema.sql / its own comment
      // on fetchAllTimeMinutesByEmail. A pre-migration "column does not
      // exist" error (or any other failure) here must never fail the
      // whole leaderboard poll the way a missing display_name/
      // current_streak legitimately would.
      fetchAllTimeMinutesByEmail(supabase, streakEmails),
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
    return liveStatusByEmail[email] || { is_live: false, pomo_status: null, pomo_phase_end_at: null, pomo_phase_total_seconds: null, pomo_last_seen_at: null };
  }

  const leaderboard = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    total_sessions: s.total_sessions,
    streak: streakByEmail[s.email] || 0,
    all_time_minutes: allTimeMinutesByEmail[s.email] || 0,
    previous_week_rank: lastWeekRankByEmail[s.email] ?? null,
    ...pomoFieldsFor(s.email),
    is_me: !!viewerEmail && s.email === viewerEmail,
  }));

  // A logged-in viewer who didn't make the top 20 otherwise sees zero
  // indication of their own standing — the query above simply never
  // fetches their row. Look it up separately so Focus Mode can still show
  // them where they stand.
  //
  // Real bug, fixed alongside the identical one in fetchTodayLeaders:
  // rank used to be "how many students have strictly more minutes, plus
  // one" — a tie-aware formula that hands every student tied on minutes
  // the SAME rank number, while the visible top-20 list above just uses
  // untied array position (1, 2, 3, ...). A tie spanning the top-20
  // cutoff meant a viewer just outside it could get handed a rank
  // already shown on a specific different (also-tied) student in the
  // visible list — confirmed happening for real via the identical daily-
  // board bug. Fixed the same way conceptually (one consistent
  // tiebreak — email — used everywhere), but without fetching every
  // row: strictly-greater and tied-but-alphabetically-earlier are two
  // separate bounded COUNT queries, added together, rather than a full
  // fetch-and-sort (see the LIMIT-20 query above for why that'd be too
  // expensive here, unlike the daily board's naturally small table).
  let viewerRank = null;
  const viewerInTop = leaderboard.some(r => r.is_me);
  // A flagged viewer sees no pinned rank of their own either, not just
  // exclusion from the visible rows — same "hidden until resolved,
  // including from themselves" rule as fetchLastWeekLeaders/
  // fetchTodayLeaders apply.
  if (viewerEmail && !viewerInTop && !flaggedEmails.has(viewerEmail)) {
    const { data: viewerStats, error: viewerError } = await supabase
      .from('pomodoro_stats')
      .select('total_minutes, total_sessions')
      .eq('email', viewerEmail)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (viewerError) return json(500, { error: viewerError.message });

    if (viewerStats) {
      const flaggedFilter = notInEmailList(flaggedEmails);
      let greaterQuery = supabase.from('pomodoro_stats').select('*', { count: 'exact', head: true }).eq('week_start', weekStart).gt('total_minutes', viewerStats.total_minutes);
      let tiedEarlierQuery = supabase.from('pomodoro_stats').select('*', { count: 'exact', head: true }).eq('week_start', weekStart).eq('total_minutes', viewerStats.total_minutes).lt('email', viewerEmail);
      if (flaggedFilter) {
        greaterQuery = greaterQuery.not('email', 'in', flaggedFilter);
        tiedEarlierQuery = tiedEarlierQuery.not('email', 'in', flaggedFilter);
      }
      const [greaterResult, tiedEarlierResult] = await Promise.all([greaterQuery, tiedEarlierQuery]);
      if (greaterResult.error) return json(500, { error: greaterResult.error.message });
      if (tiedEarlierResult.error) return json(500, { error: tiedEarlierResult.error.message });

      viewerRank = {
        rank: (greaterResult.count || 0) + (tiedEarlierResult.count || 0) + 1,
        total_minutes: viewerStats.total_minutes,
        total_sessions: viewerStats.total_sessions,
        streak: streakByEmail[viewerEmail] || 0,
        all_time_minutes: allTimeMinutesByEmail[viewerEmail] || 0,
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
  return json(200, { leaderboard, viewerRank, todayLeaders, liveCount });
}
