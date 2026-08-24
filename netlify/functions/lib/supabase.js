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
