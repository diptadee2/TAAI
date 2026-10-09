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
  weekStartIST, weekBefore, todayIST, fetchAllRows, fetchFlaggedEmails, fetchLiveCount,
  fetchLiveStatusByEmail, fetchAllTimeMinutesByEmail, fetchAboutTextByEmail, notInEmailList,
} from './supabase.js';

export const TTL_MS = 30000;
const store = new Map();

function cached(key, fn) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fn().catch((err) => { if (store.get(key)?.promise === promise) store.delete(key); throw err; });
  store.set(key, { at: Date.now(), promise });
  // Keep the map tiny: drop anything stale.
  for (const [k, v] of store) if (Date.now() - v.at > TTL_MS * 4) store.delete(k);
  return promise;
}

const byMinutesThenEmail = (a, b) => b.total_minutes - a.total_minutes || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0);

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
    const topEmails = top.map((s) => s.email);

    const todayAll = todayResult.data || [];
    const todaySorted = todayAll.filter((s) => !flagged.has(s.email)).sort(byMinutesThenEmail);
    const todayTop = todaySorted.slice(0, 10);
    const todayTopEmails = todayTop.map((s) => s.email);

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

// The viewer's own details, fetched per request (never cached).
export async function getViewerDetails(supabase, email, lastWeekStart) {
  const [studentResult, liveByEmail, finalRankResult] = await Promise.all([
    supabase.from('students').select('email, current_streak, all_time_minutes, about_text, about_changed_month, about_check_count, about_check_month, about_banned_until, about_reset_allowed').eq('email', email).maybeSingle().then((r) => r, () => ({ data: null, error: true })),
    fetchLiveStatusByEmail(supabase, [email]),
    lastWeekStart
      ? supabase.from('pomodoro_stats').select('final_rank').eq('email', email).eq('week_start', lastWeekStart).maybeSingle().then((r) => r, () => ({ data: null, error: true }))
      : Promise.resolve({ data: null, error: null }),
  ]);
  let row = studentResult.error ? null : studentResult.data;
  // Fallback for a column-level failure: the same narrower lookups the
  // old code used, each fault tolerant on its own.
  if (studentResult.error) {
    const [s, allTime] = await Promise.all([
      supabase.from('students').select('email, current_streak').eq('email', email).maybeSingle(),
      fetchAllTimeMinutesByEmail(supabase, [email]),
    ]);
    if (s.data) row = { ...s.data, all_time_minutes: allTime[email] || 0 };
  }
  return {
    exists: !!row,
    streak: row?.current_streak || 0,
    allTime: row?.all_time_minutes || 0,
    aboutRow: row && 'about_text' in row ? row : null,
    live: liveByEmail[email],
    lastWeekFinalRank: finalRankResult.error ? null : (finalRankResult.data?.final_rank ?? null),
  };
}
