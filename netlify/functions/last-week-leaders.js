// GET /api/last-week-leaders?email=...
// Standalone version of tracker-data.js's lastWeekLeaders — exists so the
// last-week champions card (shown outside Focus Mode, on the main
// checklist) can periodically refresh its live-status dots (see
// refreshLastWeekChampions in progress.js) without needing the whole
// page-load batch (schedule, streak, subject-progress, etc.) re-fetched
// alongside it, same "small independently-pollable endpoint" pattern
// streak.js/subject-progress.js/pomo-settings.js already use for the same
// reason.
//
// liveCount rides along here too — this poll and pomodoro-leaderboard.js's
// together already cover both contexts the Today card's busy meter can
// appear in (checklist vs. Focus Mode, mutually exclusive per viewer), so
// folding it into both existing 60s polls means the meter gets live
// updates with zero extra requests, instead of running its own separate
// always-on poll for every viewer regardless of context.
//
// 2026-10-09: rebuilt on lib/board-cache.js (see pomodoro-leaderboard.js):
// the shared parts are computed at most once per 30s per function
// instance, the viewer's rank is computed from the cached week (same "count
// of eligible students with more minutes, plus one" rule as lib
// fetchLastWeekLeaders), and only the viewer's own all-time minutes and
// live status are looked up per request. Same response shape.
import { getSupabase, json, fetchLiveStatusByEmail, fetchAllTimeMinutesByEmail } from './lib/supabase.js';
import { getSharedLastWeek } from './lib/board-cache.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase() || null;
  const supabase = getSupabase();
  try {
    const sh = await getSharedLastWeek(supabase);
    const liveCount = sh.liveCount;
    if (!sh.top.length) return json(200, { weekStart: sh.weekStart, leaders: [], viewerRank: null, liveCount });

    const topEmails = sh.top.map((s) => s.email);
    const viewerInTop = !!email && topEmails.includes(email);
    let viewerLive = null, viewerAllTime = null;
    if (email) {
      const [live, allTime] = await Promise.all([fetchLiveStatusByEmail(supabase, [email]), viewerInTop ? Promise.resolve(null) : fetchAllTimeMinutesByEmail(supabase, [email])]);
      viewerLive = live[email];
      viewerAllTime = allTime ? (allTime[email] || 0) : null;
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
    return json(200, { weekStart: sh.weekStart, leaders, viewerRank, liveCount });
  } catch (err) {
    return json(500, { error: err.message });
  }
}
