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
