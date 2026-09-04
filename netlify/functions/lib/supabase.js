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
export const CLIENT_VERSION = '2026-09-04-2';

export function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Netlify Functions auto-populate context.clientContext.user from a valid
// Identity JWT sent in the request's Authorization header (standard
// Netlify behavior, the same mechanism git-gateway already relies on for
// the blog CMS at /admin) — no custom JWT verification needed here.
// Gated on an explicit 'admin' role rather than "any logged-in Identity
// user", since the same Identity login also covers the blog CMS, and a
// blog writer has no reason to reach /team's student data or Discord
// webhook controls. The role itself is assigned per-user in the Netlify
// Identity dashboard (a one-time manual step, not something committable —
// same category as Identity/git-gateway setup itself).
export function requireAdmin(context) {
  const roles = context?.clientContext?.user?.app_metadata?.roles || [];
  if (!roles.includes('admin')) {
    return { authorized: false, response: json(401, { error: 'unauthorized' }) };
  }
  return { authorized: true, user: context.clientContext.user };
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

// The IST calendar date before todayIST() — used by discord-dispatch.js's
// 'daily_leader' source to report on the day that just fully ended, not
// the in-progress one.
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
// and discord-dispatch.js's 'weekly_leaderboard' source (the Monday-
// morning Discord post) so the two can't drift out of sync on this logic.
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

// "Live now" status for a set of emails — a student counts as currently
// in a focus session if their pomo_active_session row (the cross-device
// sync mirror savePomoActiveState writes to, see progress.js) says
// running=true AND their current phase's countdown hasn't finished yet.
// running alone isn't enough: a browser tab closed mid-session without a
// final sync leaves the row stuck at running=true forever, so
// phase_end_at (ms epoch, only meaningful while running — see
// schema.sql) still being in the future is what actually confirms the
// session hasn't just been left stale — this naturally "expires" a dead
// session once its nominal length is up, without needing a heartbeat.
// mode ('work' | 'break') is what drives the Status column for someone
// who IS live; updated_at backs "last seen" for anyone with a session
// row who isn't. Shared by pomodoro-leaderboard.js's weekly top-20 board
// and fetchTodayLeaders' daily leaders, so the two can't disagree on
// what counts as "live".
export async function fetchLiveStatusByEmail(supabase, emails) {
  if (!emails.length) return {};
  const { data: activeSessions, error } = await supabase
    .from('pomo_active_session')
    .select('email, running, phase_end_at, mode, updated_at')
    .in('email', emails);
  if (error) throw new Error(error.message);

  const now = Date.now();
  const sessionByEmail = Object.fromEntries(activeSessions.map(r => [r.email, r]));
  const result = {};
  for (const email of emails) {
    const session = sessionByEmail[email];
    const live = session && session.running && session.phase_end_at && session.phase_end_at > now ? session : null;
    result[email] = {
      is_live: !!live,
      pomo_status: live?.mode || null,
      pomo_phase_end_at: live?.phase_end_at || null,
      pomo_last_seen_at: (!live && session) ? parseUtcTimestamp(session.updated_at).getTime() : null,
    };
  }
  return result;
}

// Top 10 by focus minutes logged on a given IST date (todayIST() by
// default), keyed to pomo_daily_sessions.total_minutes — resets by
// construction every midnight IST since a new day is just a new row
// starting from zero. Shared by tracker-data.js (the page-load batch) and
// pomodoro-leaderboard.js (its 30s Focus Mode poll, so the "Today" card
// can auto-refresh alongside the top-20 board on the same request instead
// of needing a poll of its own) so the two can't drift out of sync on this
// logic — and by discord-dispatch.js's 'daily_leader' source, which
// passes yesterdayIST() explicitly to report on the day that just fully
// ended.
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
  const liveStatusByEmail = await fetchLiveStatusByEmail(supabase, stats.map(s => s.email));
  const leaders = stats.map(s => ({
    display_name: nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    is_me: !!email && s.email === email,
    ...liveStatusByEmail[s.email],
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

      const viewerLiveStatus = await fetchLiveStatusByEmail(supabase, [email]);
      viewerRank = { rank: (count || 0) + 1, total_minutes: viewerStats.total_minutes, ...viewerLiveStatus[email] };
    }
  }

  return { date: today, leaders, viewerRank };
}

// The single highest total_minutes any student has ever logged in one
// calendar day, across all of pomo_daily_sessions — distinct from
// fetchTodayLeaders (one day's top few), this looks across every day
// ever recorded. Used to give the daily Discord post "how does this
// compare to the all-time record" context, not just yesterday's ranking.
export async function fetchAllTimeDailyRecord(supabase) {
  const { data, error } = await supabase
    .from('pomo_daily_sessions')
    .select('email, date, total_minutes')
    .order('total_minutes', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const { data: student, error: studentError } = await supabase
    .from('students').select('display_name').eq('email', data.email).maybeSingle();
  if (studentError) throw new Error(studentError.message);
  return { display_name: student?.display_name || 'Anonymous', total_minutes: data.total_minutes, date: data.date };
}

// Same idea as fetchAllTimeDailyRecord, one level up: the single highest
// total_minutes any student has ever logged in one week, across all of
// pomodoro_stats — for the weekly Discord post's "all-time record" line.
export async function fetchAllTimeWeeklyRecord(supabase) {
  const { data, error } = await supabase
    .from('pomodoro_stats')
    .select('email, week_start, total_minutes')
    .order('total_minutes', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const { data: student, error: studentError } = await supabase
    .from('students').select('display_name').eq('email', data.email).maybeSingle();
  if (studentError) throw new Error(studentError.message);
  return { display_name: student?.display_name || 'Anonymous', total_minutes: data.total_minutes, week_start: data.week_start };
}

// Posts one or more embeds (Discord renders each full-width, stacked, in
// one message — up to 10 per message, Discord's own hard limit) to a
// Discord channel webhook — by default the one wired
// to DISCORD_WEBHOOK_URL (set via the channel's Integrations -> Webhooks
// in Discord, stored as an env var, same as the Supabase credentials —
// never hardcoded), or an explicit `webhookUrl` override for a post
// targeting a different channel (see /team, scheduled_posts.webhook_url —
// any post can go to any channel, not just the one env-var default). A
// webhook is just a URL that accepts a POST; no bot process or login
// needed. Posts under the same DISCORD_BOT_USERNAME identity regardless of
// destination, overriding whatever name the webhook itself happens to be
// configured with in Discord, so every post looks like it's coming from
// one consistent account. Throws on failure — every caller is either a
// scheduled function or the dispatcher processing one row at a time, with
// nothing user-facing to degrade gracefully for, so a real error should
// show up in logs rather than fail silently.
export const DISCORD_BOT_USERNAME = 'Department of Propaganda';

// `content`, if given, is plain text shown above the embed — the only
// place a real mention (@everyone, @here, a role `<@&ID>`, a user `<@ID>`)
// can go (Discord ignores mentions written inside embed fields). Discord
// also silently suppresses even literal mention text in a webhook's
// content unless the request explicitly opts in via allowed_mentions,
// specifically to stop APIs from being able to spam a whole server by
// accident — so that's only sent when content is actually provided, not
// on every post. `parse` covers all three mention kinds regardless of
// which one is actually present in `content` — that's safe (Discord only
// pings what's syntactically in the text; granting parse permission for a
// kind that isn't present just does nothing), and simpler than inspecting
// `content` to guess which kinds it needs.
export async function postToDiscordWebhook(embeds, content, webhookUrl) {
  const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set');
  if (embeds.length > 10) throw new Error(`Discord allows at most 10 embeds per message, got ${embeds.length}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds,
      username: DISCORD_BOT_USERNAME,
      ...(content ? { content, allowed_mentions: { parse: ['everyone', 'roles', 'users'] } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Discord webhook post failed: ${res.status} ${await res.text()}`);
}

// Combines a scheduled_posts row's tag_everyone checkbox and free-text
// extra_mentions field into the single content string postToDiscordWebhook
// actually sends — e.g. tag_everyone=true + extra_mentions="<@&123>" both
// present becomes "@everyone <@&123>". Returns undefined (not '') when
// there's nothing to mention, matching postToDiscordWebhook's own "only
// send content/allowed_mentions when there's actually something" check.
export function buildMentionContent(row) {
  const parts = [];
  if (row.tag_everyone) parts.push('@everyone');
  if (row.extra_mentions) parts.push(row.extra_mentions.trim());
  return parts.length ? parts.join(' ') : undefined;
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

// The calendar month before todayIST()'s — used by discord-monthly-
// consistency.js, which runs on the 1st and reports on the month that
// just closed (e.g. an Oct 1 run reports September).
export function previousMonthIST() {
  const today = todayIST();
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

// "Most consistent" for a given "YYYY-MM" month: median daily focus
// minutes, zero-filled across every calendar day of the month (a day with
// no session counts as a real 0, not an excluded day — every day is
// meant to be a work day here) rather than a raw average, so one huge
// binge day can't outrank someone who studied moderately but genuinely
// every day. Only students who registered by the 7th of that month are
// eligible — a 2-3 day-old account with one great day would otherwise
// have too few data points for a median to mean anything. Ties broken by
// total minutes (not just median) as the secondary sort.
export async function computeMonthlyConsistency(supabase, month) {
  const range = monthRange(month);
  if (!range) throw new Error('invalid month');
  const daysInMonth = (new Date(range.end) - new Date(range.start)) / 86400000;
  const cutoff = `${month}-07T23:59:59`;

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('email, display_name, created_at')
    .lte('created_at', cutoff);
  if (studentsError) throw new Error(studentsError.message);
  if (!students.length) return { month, top: [] };

  const emails = students.map(s => s.email);
  const { data: sessions, error: sessionsError } = await supabase
    .from('pomo_daily_sessions')
    .select('email, date, total_minutes')
    .in('email', emails)
    .gte('date', range.start)
    .lt('date', range.end);
  if (sessionsError) throw new Error(sessionsError.message);

  const minutesByEmailDate = {};
  for (const row of sessions) {
    if (!minutesByEmailDate[row.email]) minutesByEmailDate[row.email] = {};
    minutesByEmailDate[row.email][row.date] = row.total_minutes;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const results = students.map(s => {
    const byDate = minutesByEmailDate[s.email] || {};
    const values = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${month}-${String(d).padStart(2, '0')}`;
      values.push(byDate[dateStr] || 0);
    }
    return {
      email: s.email,
      display_name: s.display_name,
      medianMinutes: median(values),
      totalMinutes: values.reduce((a, b) => a + b, 0),
    };
  });

  results.sort((a, b) => b.medianMinutes - a.medianMinutes || b.totalMinutes - a.totalMinutes);
  return { month, top: results.slice(0, 3) };
}

// Fills {{placeholders}} in a template string with values from `vars` —
// lets a scheduled_posts row's title/body carry {{name}}/{{hours}}-style
// placeholders for a built-in dynamic source (see discord-dispatch.js)
// while a 'custom' post's literal text just passes through untouched
// (no {{...}} in it to match).
export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? String(vars[key]) : ''));
}

// A 'YYYY-MM-DD' IST calendar date + 'HH:MM' IST wall-clock time -> the
// exact UTC instant it refers to. IST has no DST and a fixed +05:30
// offset, so specifying it directly in the ISO string is both correct and
// simpler than manual arithmetic — the Date constructor does the
// UTC conversion itself.
function istWallClockToUtc(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+05:30`);
}

// 0 (Sun) - 6 (Sat) for a 'YYYY-MM-DD' calendar date, independent of the
// server's own timezone — parsing with an explicit "T00:00:00Z" pins the
// day-of-week to the calendar date itself, not whatever the runtime's
// local offset would otherwise shift it to.
function dateStrDayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The real last calendar day of the IST month containing `dateStr` — day 0
// of the *next* month is always the last day of *this* one.
function lastDayOfIstMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The next UTC instant, strictly after `afterDate` (defaults to now), that
// a scheduled_posts row's recurrence rule refers to — used both when a
// post is saved (its initial next_fire_at) and by discord-dispatch.js
// after every firing (to schedule the next occurrence of a recurring
// post). 'once' just resolves schedule_date/schedule_time directly;
// daily/weekly/monthly walk forward one IST calendar day at a time
// (bounded to 32 days — comfortably more than any of the three actually
// need) checking the recurrence rule against each date, since extracting
// a day-of-week or day-of-month from an already-UTC Date object would be
// server-timezone-dependent in a way plain date-string arithmetic isn't.
// schedule_day_of_month is clamped to the real last day of a short month
// (e.g. 31 in a 30-day month resolves to the 30th), never skipped.
export function computeNextFireAt(schedule, afterDate) {
  const after = afterDate || new Date();
  const timeStr = schedule.schedule_time;

  if (schedule.schedule_type === 'once') {
    return istWallClockToUtc(schedule.schedule_date, timeStr);
  }

  let dateStr = todayIST();
  for (let i = 0; i < 32; i++) {
    let matches = false;
    if (schedule.schedule_type === 'daily') {
      matches = true;
    } else if (schedule.schedule_type === 'weekly') {
      matches = dateStrDayOfWeek(dateStr) === Number(schedule.schedule_day_of_week);
    } else if (schedule.schedule_type === 'monthly') {
      const day = Number(dateStr.slice(8, 10));
      const target = Math.min(Number(schedule.schedule_day_of_month), lastDayOfIstMonth(dateStr));
      matches = day === target;
    } else {
      throw new Error('invalid schedule_type');
    }
    if (matches) {
      const candidate = istWallClockToUtc(dateStr, timeStr);
      if (candidate > after) return candidate;
    }
    dateStr = addDaysToDateStr(dateStr, 1);
  }
  throw new Error('could not compute next fire time');
}

const SCHEDULED_POST_MEDALS = ['🥇', '🥈', '🥉'];
const SCHEDULED_POST_TRACKER_URL = 'https://taai.live/gate-da-progress-tracker';

function formatHoursDecimal(minutes) {
  return (minutes / 60).toFixed(1) + 'h';
}

function monthLabel(month) {
  return new Date(month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// {{name}}/{{hours}} for rank 1 (matching the single-entity sources'
// convention), plus {{name2}}/{{hours2}} through {{nameN}}/{{hoursN}} for
// every other rank — lets a ranked-list source's body template reference
// each position individually (e.g. "shoutout to {{name}}, {{name2}} and
// {{name3}}!") instead of only being able to override the title. An
// unmatched placeholder (e.g. {{name4}} when only 3 leaders exist) just
// renders blank, same as renderTemplate already does for any unknown key.
function rankedVars(list, minutesKey) {
  const vars = {};
  list.forEach((entry, i) => {
    const suffix = i === 0 ? '' : String(i + 1);
    vars['name' + suffix] = entry.display_name;
    vars['hours' + suffix] = formatHoursDecimal(entry[minutesKey]);
  });
  return vars;
}

// Appended to the daily/weekly Discord posts so they carry "how does this
// compare to the all-time record" context, not just the current
// day's/week's ranking in isolation. Returns '' (not thrown) when there's
// no record yet, matching resolveScheduledPostEmbed's own "nothing to
// show yet" tolerance rather than failing the whole post over it.
async function allTimeDailyRecordLine(supabase) {
  const record = await fetchAllTimeDailyRecord(supabase);
  if (!record) return '';
  return `\n\n🏅 *All-time daily record: **${record.display_name}** — ${formatHoursDecimal(record.total_minutes)}, set ${record.date}*`;
}
async function allTimeWeeklyRecordLine(supabase) {
  const record = await fetchAllTimeWeeklyRecord(supabase);
  if (!record) return '';
  return `\n\n🏅 *All-time weekly record: **${record.display_name}** — ${formatHoursDecimal(record.total_minutes)}, week of ${record.week_start}*`;
}

// Resolves a scheduled_posts row into an ARRAY of Discord embeds (a single
// message can carry several — Discord renders them stacked, each
// full-width, which is what the weekly-schedule-style post needs: one
// header card plus one full-width card per subject, not squeezed
// side-by-side into one embed's fields) — pulling live data for a built-in
// source (with the row's title/body used as an override template, falling
// back to hardcoded defaults if blank) or using the row's literal
// title/body/sections as-is for 'custom'. Returns null when there's
// genuinely nothing to post yet (no data for that day/week/month) — same
// silent no-op pattern the tracker's own leaderboard cards use. Every
// branch returns an array (usually length 1) rather than a bare embed
// object, even the single-embed sources, so callers never need to special-
// case "is this one embed or many" — always spread/iterate.
//
// Exported (not just used internally by discord-dispatch.js) so
// team-posts.js's preview endpoint can call the exact same logic a real
// firing would — a preview that used separate, similar-but-not-identical
// code could drift from what actually posts, silently. `row` here doesn't
// need to be a saved database row — the preview endpoint passes an
// in-memory object built straight from the /team form's current values,
// never persisted.
export async function resolveScheduledPostEmbed(supabase, row) {
  if (row.source === 'custom') {
    const mainEmbed = {
      title: row.title || undefined,
      description: row.body || '',
      color: row.color ?? 0x8b5cf6,
    };
    // `sections` (added for the weekly-schedule use case — a full-width
    // card per subject, e.g. Python / Calculus) is an optional array of
    // {title, body, color} typed in via /team's repeatable Sections sub-
    // form; each becomes its own additional embed appended after the
    // main one, so a channel gets one message with several stacked cards
    // instead of one cramped embed.
    const extraEmbeds = (Array.isArray(row.sections) ? row.sections : []).map(s => ({
      title: s.title || undefined,
      description: s.body || '',
      color: s.color ?? row.color ?? 0x8b5cf6,
    }));
    return [mainEmbed, ...extraEmbeds];
  }

  if (row.source === 'daily_leader') {
    const date = yesterdayIST();
    const { leaders } = await fetchTodayLeaders(supabase, null, date);
    if (!leaders.length) return null;
    const top = leaders[0];
    const text = renderTemplate(
      row.body || '**{{name}}** logged the most focus time yesterday — **{{hours}}**!',
      { name: top.display_name, hours: formatHoursDecimal(top.total_minutes) }
    );
    return [{
      title: row.title || '🏆 Yesterday\'s Top Focus Session',
      url: SCHEDULED_POST_TRACKER_URL,
      description: `${text}${await allTimeDailyRecordLine(supabase)}\n\n[📊 View the progress tracker](${SCHEDULED_POST_TRACKER_URL})`,
      color: row.color ?? 0xf59e0b,
      footer: { text: date },
    }];
  }

  if (row.source === 'daily_leaderboard') {
    const date = yesterdayIST();
    const { leaders } = await fetchTodayLeaders(supabase, null, date);
    if (!leaders.length) return null;
    const top3 = leaders.slice(0, 3);
    const lines = top3.map((l, i) =>
      `${SCHEDULED_POST_MEDALS[i] || (i + 1) + '.'} **${l.display_name}** — ${formatHoursDecimal(l.total_minutes)}`
    );
    const intro = row.body ? renderTemplate(row.body, rankedVars(top3, 'total_minutes')) + '\n\n' : '';
    return [{
      title: row.title || '🏆 Yesterday\'s Top 3',
      url: SCHEDULED_POST_TRACKER_URL,
      description: `${intro}${lines.join('\n')}${await allTimeDailyRecordLine(supabase)}\n\n[📊 View the progress tracker](${SCHEDULED_POST_TRACKER_URL})`,
      color: row.color ?? 0xf59e0b,
      footer: { text: date },
    }];
  }

  if (row.source === 'weekly_leaderboard') {
    const { weekStart, leaders } = await fetchLastWeekLeaders(supabase, null);
    if (!leaders.length) return null;
    const lines = leaders.map((l, i) =>
      `${SCHEDULED_POST_MEDALS[i] || (i + 1) + '.'} **${l.display_name}** — ${formatHoursDecimal(l.total_minutes)}`
    );
    const intro = row.body ? renderTemplate(row.body, rankedVars(leaders, 'total_minutes')) + '\n\n' : '';
    return [{
      title: row.title || '📅 Weekly Top 5 Leaderboard',
      url: SCHEDULED_POST_TRACKER_URL,
      description: `${intro}${lines.join('\n')}${await allTimeWeeklyRecordLine(supabase)}\n\n[📊 View the progress tracker](${SCHEDULED_POST_TRACKER_URL})`,
      color: row.color ?? 0x8b5cf6,
      footer: { text: 'Week of ' + weekStart },
    }];
  }

  if (row.source === 'monthly_consistency') {
    const month = previousMonthIST();
    const { top } = await computeMonthlyConsistency(supabase, month);
    if (!top.length) return null;
    const label = monthLabel(month);
    const winner = top[0];
    const runnersUp = top.slice(1).map((s, i) =>
      `${SCHEDULED_POST_MEDALS[i + 1] || (i + 2) + '.'} **${s.display_name}** — ${formatHoursDecimal(s.medianMinutes)} typical day`
    );
    const winnerText = renderTemplate(
      row.body || '**{{name}}** was the most consistent student this month — a **typical day of {{hours}}** of focused study, day after day, all month long.',
      { name: winner.display_name, hours: formatHoursDecimal(winner.medianMinutes) }
    );
    const description =
      `${winnerText}\n\n` +
      '*How this is measured:* we look at every day of the month, including the quiet ones, and find your "typical" day — not your best day, not your worst, just what a normal day looked like for you. Someone who shows up a little every day beats someone who crams once and disappears for the rest of the month, even if their total hours end up about the same.' +
      (runnersUp.length ? `\n\n${runnersUp.join('\n')}` : '') +
      `\n\n[📊 View the progress tracker](${SCHEDULED_POST_TRACKER_URL})`;
    return [{
      title: row.title || `🏅 Most Consistent Student — ${label}`,
      url: SCHEDULED_POST_TRACKER_URL,
      description,
      color: row.color ?? 0xf59e0b,
      footer: { text: label },
    }];
  }

  throw new Error('unknown source: ' + row.source);
}
