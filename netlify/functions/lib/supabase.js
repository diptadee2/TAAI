import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

let client = null;

export function getSupabase() {
  if (!client) {
    // supabase-js constructs a Realtime client eagerly even though these
    // functions never subscribe to anything — it needs a WebSocket ctor to
    // do that, which isn't a guaranteed global across every Lambda/Node
    // runtime a Netlify Function might execute on. Supplying `ws` avoids a
    // hard crash on every single request in environments without one.
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      realtime: { transport: ws },
    });
  }
  return client;
}

// Bumped by hand whenever a client/server *contract* change ships for the
// progress tracker (e.g. today's Pomodoro completion payload shape) — not
// on every deploy. progress.js polls /version against this and auto-
// reloads on a mismatch, so a tab left open across a deploy like today's
// (old JS silently sending a request shape the new server no longer
// accepts) doesn't stay stuck indefinitely waiting for someone to notice
// and manually refresh.
export const CLIENT_VERSION = '2026-09-01-1';

export function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// "Today" as a calendar date in IST (the site's audience), not the
// function runtime's own timezone. Netlify Functions run on infrastructure
// with no guaranteed local timezone (typically UTC) — for roughly the
// first 5.5 hours of every IST calendar day, naive `new Date()`-based
// "today" logic on the server disagrees with what students actually see
// on their own devices (which compute "today" from the browser's local
// time, correctly IST for this audience), silently treating same-day
// completions as belonging to "yesterday".
const IST_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export function todayIST() {
  return IST_FORMATTER.format(new Date());
}

// The IST calendar date before todayIST() — used by discord-daily-leader.js
// to report on the day that just fully ended, not the in-progress one.
export function yesterdayIST() {
  const d = new Date(todayIST() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Monday of the current ISO week, based on the IST calendar date. Same
// Monday-start-week convention progress.js's mondayOf() already uses
// client-side for the calendar's "Week N" labels. Used to key the
// pomodoro leaderboard's per-week rows.
export function weekStartIST() {
  const d = new Date(todayIST() + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// The Monday exactly one week before a given week_start — used to look
// up "the week before this one" for a rank comparison (pomodoro-
// leaderboard.js's week_start_rank, tracker-data.js's
// previous_week_rank) that's the same for every viewer regardless of
// when they check, unlike a client-side "since my last poll" comparison.
export function weekBefore(weekStart) {
  const d = new Date(weekStart + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

// The schedule starts Aug 1 2026, so streak math needs the same floor as
// the frontend's clamped "today" (see DEMO_TODAY_FLOOR in progress.js) —
// without it, a completion on the frontend's Aug 1 "today" would have
// server-side streak logic still looking for scheduled dates <= the real
// (pre-Aug-1) date, find nothing, and always report streak 0. Self-
// expiring: todayIST() has been past this floor since 2026-08-01, so it's
// already a no-op — kept only so streak.js and pomodoro-leaderboard.js
// (both of which need this) can't drift out of sync on when to drop it.
const DEMO_TODAY_FLOOR = '2026-08-01';
export function todayForStreak() {
  const real = todayIST();
  return real > DEMO_TODAY_FLOOR ? real : DEMO_TODAY_FLOOR;
}

// Consecutive-day streak given every scheduled date (most-recent first)
// and the set of dates a student actually completed something on. Shared
// by streak.js (one student) and pomodoro-leaderboard.js (every row on
// the board, batched into two queries total instead of one /streak call
// per row) so the two can't disagree on the same student's number. A
// "rest day" with nothing scheduled neither extends nor breaks the streak;
// today gets a pass if nothing's ticked yet since the day isn't over.
export function computeStreak(scheduledDatesDesc, completedDates, today) {
  let streak = 0;
  for (const date of scheduledDatesDesc) {
    if (completedDates.has(date)) { streak++; continue; }
    if (date === today) continue;
    break;
  }
  return streak;
}

// Parses a Postgres `timestamp` (without time zone) column's string value
// as the UTC instant it actually is — confirmed as a real bug, not just
// theoretical: pomo_active_session.updated_at is written via
// `.toISOString()` (genuinely UTC) but comes back from Postgres/PostgREST
// without a trailing "Z" (e.g. "2026-08-20T14:29:46.871", since the
// column type has no timezone info to include). Plain `new Date(...)`
// parses a timezone-less string as *local time to whatever machine runs
// the parsing* — on a dev machine set to IST that silently shifted an
// "updated 6 minutes ago" row 5.5 hours into the past, showing "340
// minutes ago" instead. Appending "Z" makes the UTC instant explicit
// instead of leaving it to the runtime's ambient timezone, same
// "never trust an implicit timezone" principle as todayIST() above.
export function parseUtcTimestamp(pgTimestamp) {
  return new Date(pgTimestamp.endsWith('Z') ? pgTimestamp : pgTimestamp + 'Z');
}

// Top 5 by focus minutes logged *last week* (Mon-start, IST), keyed to
// pomodoro_stats.total_minutes for the week before this one. Shared by
// tracker-data.js (the page-load batch, for the main-page champions card)
// and discord-weekly-leaderboard.js (the Monday-morning Discord post) so
// the two can't drift out of sync on this logic.
export async function fetchLastWeekLeaders(supabase, email) {
  const weekStart = weekBefore(weekStartIST());
  const { data: stats, error: statsError } = await supabase
    .from('pomodoro_stats')
    .select('email, total_minutes')
    .eq('week_start', weekStart)
    .order('total_minutes', { ascending: false })
    .limit(5);
  if (statsError) throw new Error(statsError.message);
  if (!stats.length) return { weekStart, leaders: [], viewerRank: null };

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('email, display_name')
    .in('email', stats.map(s => s.email));
  if (studentsError) throw new Error(studentsError.message);

  // Previous-week rank, for the same up/down arrow the top-20 board
  // shows (rankMovementHtml in progress.js, reused as-is here) — except
  // "previous" means the week before *this* week's top-5 snapshot,
  // rather than the last poll. A full ranked snapshot of that earlier
  // week (not just these 5 emails' own rows), since a leader's previous
  // rank can be well outside that week's own top 5 — someone who jumped
  // from #12 to #3 should still show as a big rise, not "no data".
  // Computed in JS from one query rather than a per-leader rank-count
  // query, since this whole function only ever runs on page load / an
  // explicit champions-card refresh, not on a poll.
  const prevWeekStart = weekBefore(weekStart);
  const { data: prevWeekStats, error: prevWeekError } = await supabase
    .from('pomodoro_stats')
    .select('email, total_minutes')
    .eq('week_start', prevWeekStart)
    .order('total_minutes', { ascending: false });
  if (prevWeekError) throw new Error(prevWeekError.message);
  const prevRankByEmail = Object.fromEntries(prevWeekStats.map((s, i) => [s.email, i + 1]));

  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));
  const leaders = stats.map((s, i) => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    is_me: !!email && s.email === email,
    previous_week_rank: prevRankByEmail[s.email] ?? null,
  }));

  // Same idea as pomodoro-leaderboard.js's viewerRank — a student outside
  // last week's top 5 otherwise has no way to see where they actually
  // stood, since this query never fetches their row at all.
  let viewerRank = null;
  const viewerInTop = leaders.some(l => l.is_me);
  if (email && !viewerInTop) {
    const { data: viewerStats, error: viewerError } = await supabase
      .from('pomodoro_stats')
      .select('total_minutes')
      .eq('email', email)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (viewerError) throw new Error(viewerError.message);

    if (viewerStats) {
      const { count, error: countError } = await supabase
        .from('pomodoro_stats')
        .select('*', { count: 'exact', head: true })
        .eq('week_start', weekStart)
        .gt('total_minutes', viewerStats.total_minutes);
      if (countError) throw new Error(countError.message);

      viewerRank = { rank: (count || 0) + 1, total_minutes: viewerStats.total_minutes, previous_week_rank: prevRankByEmail[email] ?? null };
    }
  }

  return { weekStart, leaders, viewerRank };
}

// Top 10 by focus minutes logged on a given IST date (todayIST() by
// default), keyed to pomo_daily_sessions.total_minutes — resets by
// construction every midnight IST since a new day is just a new row
// starting from zero. Shared by tracker-data.js (the page-load batch) and
// pomodoro-leaderboard.js (its 30s Focus Mode poll, so the "Today" card
// can auto-refresh alongside the top-20 board on the same request instead
// of needing a poll of its own) so the two can't drift out of sync on this
// logic — and by discord-daily-leader.js, which passes yesterdayIST()
// explicitly to report on the day that just fully ended.
export async function fetchTodayLeaders(supabase, email, date) {
  const today = date || todayIST();
  const { data: stats, error: statsError } = await supabase
    .from('pomo_daily_sessions')
    .select('email, total_minutes')
    .eq('date', today)
    .order('total_minutes', { ascending: false })
    .limit(10);
  if (statsError) throw new Error(statsError.message);
  if (!stats.length) return { date: today, leaders: [], viewerRank: null };

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('email, display_name')
    .in('email', stats.map(s => s.email));
  if (studentsError) throw new Error(studentsError.message);

  const nameByEmail = Object.fromEntries(students.map(s => [s.email, s.display_name]));
  const leaders = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    is_me: !!email && s.email === email,
  }));

  // A student outside today's top 10 otherwise has no way to see where
  // they actually stand.
  let viewerRank = null;
  const viewerInTop = leaders.some(l => l.is_me);
  if (email && !viewerInTop) {
    const { data: viewerStats, error: viewerError } = await supabase
      .from('pomo_daily_sessions')
      .select('total_minutes')
      .eq('email', email)
      .eq('date', today)
      .maybeSingle();
    if (viewerError) throw new Error(viewerError.message);

    if (viewerStats) {
      const { count, error: countError } = await supabase
        .from('pomo_daily_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('date', today)
        .gt('total_minutes', viewerStats.total_minutes);
      if (countError) throw new Error(countError.message);

      viewerRank = { rank: (count || 0) + 1, total_minutes: viewerStats.total_minutes };
    }
  }

  return { date: today, leaders, viewerRank };
}

// Posts one embed to the Discord channel wired to DISCORD_WEBHOOK_URL (set
// via the channel's Integrations -> Webhooks in Discord, stored as an env
// var, same as the Supabase credentials — never hardcoded). A webhook is
// just a URL that accepts a POST; no bot process or login needed. Used by
// discord-daily-leader.js and discord-weekly-leaderboard.js — both post
// under the same DISCORD_BOT_USERNAME identity, overriding whatever name
// the webhook itself happens to be configured with in Discord, so both
// kinds of post look like they're coming from one consistent account.
// Throws on failure — both callers are scheduled functions with nothing
// user-facing to degrade gracefully for, so a real error should show up
// in the function's own logs rather than fail silently.
export const DISCORD_BOT_USERNAME = 'Department of Propaganda';

export async function postToDiscordWebhook(embed) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed], username: DISCORD_BOT_USERNAME }),
  });
  if (!res.ok) throw new Error(`Discord webhook post failed: ${res.status} ${await res.text()}`);
}

// Validates "YYYY-MM" and returns the [start, end) date range for a SQL query.
export function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  return { start, end };
}
