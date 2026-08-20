// GET /api/pomodoro-leaderboard?email=...
// Top students by focus minutes logged *this week* (Mon-start, IST), for
// Focus Mode's weekly leaderboard. Display names are shown publicly by
// design; no email or other identity is returned in the response. The
// optional `email` query param (the viewer's own, if logged in) is only
// used to flag their own row with is_me, never anyone else's.
import { getSupabase, json, weekStartIST, todayForStreak, computeStreak, parseUtcTimestamp } from './lib/supabase.js';

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

  // Streak balls shown between name and minutes in the leaderboard UI —
  // computed the same way as the single-student /streak endpoint (see
  // computeStreak in lib/supabase.js) so the two can't disagree, but
  // batched: one scheduled-dates query and one task_progress query cover
  // every row (plus the viewer's own row, if they're not already in the
  // top 20) at once, instead of a separate /streak call per row.
  const streakEmails = stats.map(s => s.email);
  if (viewerEmail && !streakEmails.includes(viewerEmail)) streakEmails.push(viewerEmail);

  const today = todayForStreak();
  const { data: scheduledForStreak, error: schedError } = await supabase
    .from('schedule_tasks')
    .select('date')
    .lte('date', today)
    .order('date', { ascending: false });
  if (schedError) return json(500, { error: schedError.message });
  const scheduledDates = [...new Set(scheduledForStreak.map(r => r.date))];

  const { data: completedForStreak, error: completedError } = await supabase
    .from('task_progress')
    .select('email, date')
    .in('email', streakEmails)
    .eq('completed', true);
  if (completedError) return json(500, { error: completedError.message });

  const completedByEmail = {};
  completedForStreak.forEach(r => {
    if (!completedByEmail[r.email]) completedByEmail[r.email] = new Set();
    completedByEmail[r.email].add(r.date);
  });
  const streakByEmail = Object.fromEntries(
    streakEmails.map(e => [e, computeStreak(scheduledDates, completedByEmail[e] || new Set(), today)])
  );

  // "Live now" — a student is shown as currently in a focus session if
  // their pomo_active_session row (the same cross-device sync mirror
  // savePomoActiveState writes to, see progress.js) says running=true
  // AND their current phase's countdown hasn't finished yet. running
  // alone isn't enough: a browser tab closed mid-session without a final
  // sync leaves the row stuck at running=true forever, so phase_end_at
  // (ms epoch, only meaningful while running — see schema.sql) still
  // being in the future is what actually confirms the session hasn't
  // just been left stale. This naturally "expires" a dead session once
  // its nominal length is up, without needing a heartbeat.
  // mode ('work' | 'break', see schema.sql) is what actually drives the
  // Status column — is_live alone only says "in a session", not which
  // phase they're in. updated_at (touched on every start/pause/skip/
  // reset/phase-advance, see pomo-active.js) is what backs "last seen"
  // for anyone with a session row who isn't currently live.
  const { data: activeSessions, error: activeError } = await supabase
    .from('pomo_active_session')
    .select('email, running, phase_end_at, mode, updated_at')
    .in('email', streakEmails);
  if (activeError) return json(500, { error: activeError.message });
  const now = Date.now();
  const sessionByEmail = Object.fromEntries(activeSessions.map(r => [r.email, r]));
  const liveByEmail = {};
  activeSessions.forEach(r => {
    if (r.running && r.phase_end_at && r.phase_end_at > now) liveByEmail[r.email] = r;
  });

  function pomoFieldsFor(email) {
    const session = sessionByEmail[email];
    const live = liveByEmail[email];
    return {
      is_live: !!live,
      pomo_status: live?.mode || null,
      // ms epoch, same clock the client's own timer counts down to (see
      // pomo.phaseEndAt in progress.js) — the frontend derives a live
      // ticking mm:ss from this rather than a value that would already
      // be stale by the time it's rendered, let alone a second later.
      pomo_phase_end_at: live?.phase_end_at || null,
      // Only set when there's a session row AND they're not currently
      // live — someone who's never touched Pomodoro gets null (nothing
      // to show), not a misleading "last seen" for an activity they've
      // never done.
      pomo_last_seen_at: (!live && session) ? parseUtcTimestamp(session.updated_at).getTime() : null,
    };
  }

  const leaderboard = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    total_sessions: s.total_sessions,
    streak: streakByEmail[s.email] || 0,
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
        ...pomoFieldsFor(viewerEmail),
      };
    }
  }

  return json(200, { leaderboard, viewerRank });
}
