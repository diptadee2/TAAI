// Shared, short-lived cache for the two leaderboard polls (2026-10-09).
//
// Why: Supabase started metering "Log Ingestion" (one log line per database
// request). The weekly leaderboard (pomodoro-leaderboard.js, polled every
// 60s in Focus Mode) made 19 database requests per refresh and the
// last-week champions card (last-week-leaders.js, polled every 60s on the
// checklist) made 10, for EVERY open tab, although almost all of that data
// is the same for every viewer. Measured 3.35 GB of logs against a 1 GB
// allowance.
//
// What: the parts that are identical for everyone are computed once per
// function instance every TTL_MS and shared by every request that instance
// serves; only the viewer's own row is looked up per request. Responses
// keep exactly the same shape as before, so no client change is needed.
// Concurrent requests share one in-flight computation, and a failed
// computation is never cached.
import {
  weekStartIST, weekBefore, todayIST, fetchAllRows, fetchFlaggedEmails, fetchLiveCount, fetchHourlyActivity,
  fetchLiveStatusByEmail, fetchAllTimeMinutesByEmail, fetchAboutTextByEmail, notInEmailList,
} from './supabase.js';

export const TTL_MS = 30000;
const store = new Map();

function cached(key, fn, ttl = TTL_MS) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || TTL_MS)) return hit.promise;
  const promise = fn().catch((err) => { if (store.get(key)?.promise === promise) store.delete(key); throw err; });
  store.set(key, { at: Date.now(), promise, ttl });
  // Keep the map tiny: drop anything stale.
  for (const [k, v] of store) if (Date.now() - v.at > (v.ttl || TTL_MS) * 4) store.delete(k);
  return promise;
}

export const byMinutesThenEmail = (a, b) => b.total_minutes - a.total_minutes || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0);

// Everything the weekly board (and the "today" board riding on it) needs
// that doesn't depend on who is looking.
export function getSharedWeekly(supabase) {
  const weekStart = weekStartIST();
  const today = todayIST();
  return cached('weekly:' + weekStart + ':' + today, async () => {
    const lastWeekStart = weekBefore(weekStart);
    const [flagged, weekRows, todayResult, liveCount] = await Promise.all([
      fetchFlaggedEmails(supabase),
      fetchAllRows(() => supabase.from('pomodoro_stats').select('email, total_minutes, total_sessions').eq('week_start', weekStart)),
      supabase.from('pomo_daily_sessions').select('email, total_minutes').eq('date', today),
      fetchLiveCount(supabase).catch(() => ({ count: 0, maxCount: 0 })),
    ]);
    if (todayResult.error) throw new Error(todayResult.error.message);

    const weekSorted = weekRows.filter((s) => !flagged.has(s.email)).sort(byMinutesThenEmail);
    const top = weekSorted.slice(0, 20);
    // One extra row each way, so a viewer's fresh minutes (merged in per
    // request, see mergeViewerRow) can't push in someone we have no name for.
    const topEmails = weekSorted.slice(0, 21).map((s) => s.email);

    const todayAll = todayResult.data || [];
    const todaySorted = todayAll.filter((s) => !flagged.has(s.email)).sort(byMinutesThenEmail);
    const todayTop = todaySorted.slice(0, 10);
    const todayTopEmails = todaySorted.slice(0, 11).map((s) => s.email);

    const lookup = [...new Set(topEmails.concat(todayTopEmails))];
    const [studentsResult, liveByEmail, lastWeekRanksResult, allTimeByEmail, aboutRowsResult, aboutTextByEmail] = await Promise.all([
      lookup.length ? supabase.from('students').select('email, display_name, current_streak').in('email', lookup) : Promise.resolve({ data: [], error: null }),
      fetchLiveStatusByEmail(supabase, lookup),
      topEmails.length ? supabase.from('pomodoro_stats').select('email, final_rank').eq('week_start', lastWeekStart).in('email', topEmails) : Promise.resolve({ data: [], error: null }),
      fetchAllTimeMinutesByEmail(supabase, lookup),
      topEmails.length
        ? supabase.from('students').select('email, about_text, about_changed_month, about_check_count, about_check_month').in('email', topEmails).then((r) => r, () => ({ data: null, error: true }))
        : Promise.resolve({ data: [], error: null }),
      fetchAboutTextByEmail(supabase, todayTopEmails),
    ]);
    if (studentsResult.error) throw new Error(studentsResult.error.message);
    if (lastWeekRanksResult.error) throw new Error(lastWeekRanksResult.error.message);

    return {
      weekStart, lastWeekStart, today, flagged, liveCount, weekSorted, top, todayAll, todaySorted, todayTop,
      nameByEmail: Object.fromEntries(studentsResult.data.map((s) => [s.email, s.display_name])),
      streakByEmail: Object.fromEntries(studentsResult.data.map((s) => [s.email, s.current_streak || 0])),
      liveByEmail,
      lastWeekRankByEmail: Object.fromEntries(lastWeekRanksResult.data.filter((r) => r.final_rank != null).map((r) => [r.email, r.final_rank])),
      allTimeByEmail,
      aboutRowByEmail: aboutRowsResult.error ? {} : Object.fromEntries((aboutRowsResult.data || []).map((r) => [r.email, r])),
      aboutTextByEmail,
    };
  });
}

// Everything the last-week champions card needs that doesn't depend on
// who is looking. Same queries as lib fetchLastWeekLeaders, minus the
// viewer's own.
export function getSharedLastWeek(supabase) {
  const weekStart = weekBefore(weekStartIST());
  return cached('lastweek:' + weekStart, async () => {
    const prevWeekStart = weekBefore(weekStart);
    const [flagged, prevWeekResult, liveCount] = await Promise.all([
      fetchFlaggedEmails(supabase),
      supabase.from('pomodoro_stats').select('email, total_minutes').eq('week_start', prevWeekStart).order('total_minutes', { ascending: false }),
      fetchLiveCount(supabase).catch(() => ({ count: 0, maxCount: 0 })),
    ]);
    if (prevWeekResult.error) throw new Error(prevWeekResult.error.message);
    const flaggedFilter = notInEmailList(flagged);
    let topQuery = supabase.from('pomodoro_stats').select('email, total_minutes').eq('week_start', weekStart).order('total_minutes', { ascending: false }).limit(5);
    if (flaggedFilter) topQuery = topQuery.not('email', 'in', flaggedFilter);
    const [topResult, weekRows] = await Promise.all([
      topQuery,
      fetchAllRows(() => supabase.from('pomodoro_stats').select('email, total_minutes').eq('week_start', weekStart)),
    ]);
    if (topResult.error) throw new Error(topResult.error.message);
    const top = topResult.data;
    const topEmails = top.map((s) => s.email);
    const [studentsResult, allTimeByEmail, liveByEmail] = await Promise.all([
      topEmails.length ? supabase.from('students').select('email, display_name').in('email', topEmails) : Promise.resolve({ data: [], error: null }),
      fetchAllTimeMinutesByEmail(supabase, topEmails),
      fetchLiveStatusByEmail(supabase, topEmails),
    ]);
    if (studentsResult.error) throw new Error(studentsResult.error.message);
    return {
      weekStart, flagged, liveCount, top,
      eligibleWeekRows: weekRows.filter((s) => !flagged.has(s.email)),
      prevRankByEmail: Object.fromEntries(prevWeekResult.data.map((s, i) => [s.email, i + 1])),
      nameByEmail: Object.fromEntries(studentsResult.data.map((s) => [s.email, s.display_name])),
      allTimeByEmail, liveByEmail,
    };
  });
}

// The viewer's own details, fetched per request (never cached). Includes
// the viewer's own week/today minutes, so their own row and rank are never
// up to TTL_MS stale right after they finish a session.
export async function getViewerDetails(supabase, email, lastWeekStart, weekStart, today) {
  const [studentResult, liveByEmail, finalRankResult, weekResult, todayResult] = await Promise.all([
    supabase.from('students').select('email, display_name, current_streak, all_time_minutes, about_text, about_changed_month, about_check_count, about_check_month, about_banned_until, about_reset_allowed').eq('email', email).maybeSingle().then((r) => r, () => ({ data: null, error: true })),
    fetchLiveStatusByEmail(supabase, [email]),
    lastWeekStart
      ? supabase.from('pomodoro_stats').select('final_rank').eq('email', email).eq('week_start', lastWeekStart).maybeSingle().then((r) => r, () => ({ data: null, error: true }))
      : Promise.resolve({ data: null, error: null }),
    weekStart
      ? supabase.from('pomodoro_stats').select('email, total_minutes, total_sessions').eq('email', email).eq('week_start', weekStart).maybeSingle().then((r) => r, () => ({ data: null, error: true }))
      : Promise.resolve({ data: null, error: null }),
    today
      ? supabase.from('pomo_daily_sessions').select('email, total_minutes').eq('email', email).eq('date', today).maybeSingle().then((r) => r, () => ({ data: null, error: true }))
      : Promise.resolve({ data: null, error: null }),
  ]);
  let row = studentResult.error ? null : studentResult.data;
  // Fallback for a column-level failure: the same narrower lookups the
  // old code used, each fault tolerant on its own.
  if (studentResult.error) {
    const [s, allTime] = await Promise.all([
      supabase.from('students').select('email, display_name, current_streak').eq('email', email).maybeSingle(),
      fetchAllTimeMinutesByEmail(supabase, [email]),
    ]);
    if (s.data) row = { ...s.data, all_time_minutes: allTime[email] || 0 };
  }
  return {
    exists: !!row,
    name: row?.display_name || null,
    // undefined = lookup failed (keep the cached value); null = no row yet.
    week: weekResult.error ? undefined : (weekResult.data || null),
    today: todayResult.error ? undefined : (todayResult.data || null),
    streak: row?.current_streak || 0,
    allTime: row?.all_time_minutes || 0,
    aboutRow: row && 'about_text' in row ? row : null,
    live: liveByEmail[email],
    lastWeekFinalRank: finalRankResult.error ? null : (finalRankResult.data?.final_rank ?? null),
  };
}

// Replace the viewer's (possibly stale) entry in a cached, sorted list with
// their fresh one and re-sort. Returns the list unchanged when the fresh
// lookup failed.
export function mergeViewerRow(sorted, email, fresh) {
  if (!email || fresh === undefined) return sorted;
  const rest = sorted.filter((s) => s.email !== email);
  if (fresh && fresh.total_minutes > 0) rest.push(fresh);
  return rest.sort(byMinutesThenEmail);
}

// ── Page-load helpers (tracker-data.js), added 2026-10-17 ─────────────

// The Today card's hourly chart is the same for everyone.
export function getSharedHourly(supabase) {
  return cached('hourly', () => fetchHourlyActivity(supabase));
}

// A batch's whole schedule and its lesson links are the same for every
// student and only change when someone runs load-schedule/load-task-links,
// so they're cached for SCHEDULE_TTL_MS. A newly loaded schedule shows
// within that time. rows keep the database's natural order (what the old
// per-request queries returned).
export const SCHEDULE_TTL_MS = 5 * 60 * 1000;
export function getBatchSchedule(supabase, batch) {
  return cached('schedule:' + batch, async () => {
    const [rows, linksResult] = await Promise.all([
      fetchAllRows(() => supabase.from('schedule_tasks').select('date, subject, task_text, position').eq('batch', batch)),
      supabase.from('schedule_task_links').select('subject, task_text, url').eq('batch', batch).then((r) => r, () => ({ data: null, error: true })),
    ]);
    let links = null;
    if (!linksResult.error) {
      links = {};
      for (const r of linksResult.data || []) {
        if (!/^https:\/\/learn\.taai\.live\//.test(r.url)) continue;
        (links[r.subject] = links[r.subject] || {})[r.task_text] = r.url;
      }
    }
    let latest = null;
    for (const r of rows) if (!latest || r.date > latest) latest = r.date;
    return { rows, latestMonth: latest ? latest.slice(0, 7) : null, links };
  }, SCHEDULE_TTL_MS);
}

// Same output as lib fetchTodayLeaders(supabase, viewerEmail), built from
// the shared weekly cache plus the viewer's own details. Shared by
// pomodoro-leaderboard.js and tracker-data.js.
export function buildTodayLeaders(sh, viewerEmail, viewer, viewerFlagged, nameFor) {
  const todaySorted = viewerFlagged ? sh.todaySorted : mergeViewerRow(sh.todaySorted, viewerEmail, viewer?.today);
  if (!todaySorted.length) return { date: sh.today, leaders: [], viewerRank: null };
  const isViewer = (email) => !!viewerEmail && email === viewerEmail && !!viewer;
  const liveFor = (email) => (isViewer(email) ? viewer.live : sh.liveByEmail[email]);
  const leaders = todaySorted.slice(0, 10).map((s) => ({
    display_name: nameFor(s.email),
    total_minutes: s.total_minutes,
    all_time_minutes: isViewer(s.email) ? viewer.allTime : (sh.allTimeByEmail[s.email] || 0),
    about: (isViewer(s.email) && viewer.aboutRow ? viewer.aboutRow.about_text : sh.aboutTextByEmail[s.email]) || null,
    is_me: !!viewerEmail && s.email === viewerEmail,
    ...liveFor(s.email),
  }));
  let viewerRank = null;
  if (viewerEmail && !leaders.some((l) => l.is_me)) {
    const idx = todaySorted.findIndex((s) => s.email === viewerEmail);
    if (idx !== -1) {
      viewerRank = {
        rank: idx + 1,
        total_minutes: todaySorted[idx].total_minutes,
        all_time_minutes: viewer ? viewer.allTime : 0,
        about: viewer?.aboutRow?.about_text || null,
        ...(viewer?.live || {}),
      };
    }
  }
  return { date: sh.today, leaders, viewerRank };
}

// Same output as lib fetchLastWeekLeaders(supabase, email) (plus liveCount),
// from the shared last-week cache. known = { live, allTime } for the
// viewer, when the caller already has them, skips those two lookups.
export async function buildLastWeekLeaders(supabase, email, known) {
  const sh = await getSharedLastWeek(supabase);
  const liveCount = sh.liveCount;
  if (!sh.top.length) return { weekStart: sh.weekStart, leaders: [], viewerRank: null, liveCount };

  const topEmails = sh.top.map((s) => s.email);
  const viewerInTop = !!email && topEmails.includes(email);
  let viewerLive = null, viewerAllTime = null;
  if (email) {
    if (known) {
      viewerLive = known.live;
      viewerAllTime = viewerInTop ? null : (known.allTime || 0);
    } else {
      const [live, allTime] = await Promise.all([fetchLiveStatusByEmail(supabase, [email]), viewerInTop ? Promise.resolve(null) : fetchAllTimeMinutesByEmail(supabase, [email])]);
      viewerLive = live[email];
      viewerAllTime = allTime ? (allTime[email] || 0) : null;
    }
  }

  const leaders = sh.top.map((s) => ({
    display_name: sh.nameByEmail[s.email] || 'Anonymous',
    total_minutes: s.total_minutes,
    all_time_minutes: sh.allTimeByEmail[s.email] || 0,
    is_me: !!email && s.email === email,
    previous_week_rank: sh.prevRankByEmail[s.email] ?? null,
    ...(s.email === email && viewerLive ? viewerLive : sh.liveByEmail[s.email]),
  }));

  let viewerRank = null;
  const viewerEligible = !!email && !sh.flagged.has(email);
  const viewerStats = viewerEligible ? sh.eligibleWeekRows.find((r) => r.email === email) : null;
  if (viewerStats && !viewerInTop) {
    const greater = sh.eligibleWeekRows.filter((r) => r.total_minutes > viewerStats.total_minutes).length;
    viewerRank = { rank: greater + 1, total_minutes: viewerStats.total_minutes, all_time_minutes: viewerAllTime || 0, previous_week_rank: sh.prevRankByEmail[email] ?? null, ...viewerLive };
  }
  return { weekStart: sh.weekStart, leaders, viewerRank, liveCount };
}
