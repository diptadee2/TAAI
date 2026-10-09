// GET /api/pomodoro-leaderboard?email=...
// Top students by focus minutes logged *this week* (Mon-start, IST), for
// Focus Mode's weekly leaderboard. Display names are shown publicly by
// design; no email or other identity is returned in the response. The
// optional `email` query param (the viewer's own, if logged in) is only
// used to flag their own row with is_me, never anyone else's.
//
// 2026-10-09: rebuilt on lib/board-cache.js to cut Supabase requests (its
// "Log Ingestion" meter). Everything that's the same for every viewer
// (this week's ranking, the top 20's details, today's leaders, the live
// count) is computed at most once per 30s per function instance; only the
// viewer's own details are looked up per request. The response shape is
// unchanged. The pre-change version is in git history (commit before
// "Leaderboards: shared 30s cache") if this ever needs comparing again.
import { getSupabase, json } from './lib/supabase.js';
import { getSharedWeekly, getViewerDetails, mergeViewerRow } from './lib/board-cache.js';

const EMPTY_POMO = { is_live: false, pomo_status: null, pomo_phase_end_at: null, pomo_phase_total_seconds: null, pomo_last_seen_at: null };

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const viewerEmail = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  const supabase = getSupabase();

  let sh, viewer = null;
  try {
    sh = await getSharedWeekly(supabase);
    if (viewerEmail) viewer = await getViewerDetails(supabase, viewerEmail, sh.lastWeekStart, sh.weekStart, sh.today);
  } catch (err) {
    return json(500, { error: err.message });
  }

  // The viewer's own minutes come fresh from this request, never the cache.
  const viewerFlagged = !!viewerEmail && sh.flagged.has(viewerEmail);
  const weekSorted = viewerFlagged ? sh.weekSorted : mergeViewerRow(sh.weekSorted, viewerEmail, viewer?.week);
  const top = weekSorted.slice(0, 20);
  const nameFor = (email) => sh.nameByEmail[email] || (email === viewerEmail && viewer?.name) || 'Anonymous';

  const todayLeaders = buildToday(sh, viewerEmail, viewer, viewerFlagged, nameFor);
  const liveCount = sh.liveCount;
  if (!top.length) return json(200, { leaderboard: [], viewerRank: null, todayLeaders, liveCount });

  const pomoFor = (email) => (email === viewerEmail && viewer ? viewer.live : sh.liveByEmail[email]) || EMPTY_POMO;

  const isViewer = (email) => !!viewerEmail && email === viewerEmail && !!viewer;
  const leaderboard = top.map((s) => ({
    display_name: nameFor(s.email),
    total_minutes: s.total_minutes,
    total_sessions: s.total_sessions,
    streak: isViewer(s.email) ? viewer.streak : (sh.streakByEmail[s.email] || 0),
    all_time_minutes: isViewer(s.email) ? viewer.allTime : (sh.allTimeByEmail[s.email] || 0),
    about: (isViewer(s.email) && viewer.aboutRow ? viewer.aboutRow.about_text : sh.aboutRowByEmail[s.email]?.about_text) || null,
    previous_week_rank: isViewer(s.email) ? viewer.lastWeekFinalRank : (sh.lastWeekRankByEmail[s.email] ?? null),
    ...pomoFor(s.email),
    is_me: !!viewerEmail && s.email === viewerEmail,
  }));

  let viewerRank = null;
  const viewerInTop = leaderboard.some((r) => r.is_me);
  if (viewerEmail && !viewerInTop && !sh.flagged.has(viewerEmail)) {
    const idx = weekSorted.findIndex((s) => s.email === viewerEmail);
    if (idx !== -1) {
      const v = weekSorted[idx];
      viewerRank = {
        rank: idx + 1,
        total_minutes: v.total_minutes,
        total_sessions: v.total_sessions,
        streak: viewer ? viewer.streak : 0,
        all_time_minutes: viewer ? viewer.allTime : 0,
        about: viewer?.aboutRow?.about_text || null,
        previous_week_rank: viewer ? viewer.lastWeekFinalRank : null,
        ...(viewer?.live || EMPTY_POMO),
      };
    }
  }

  let viewerAbout = null;
  const mine = viewerEmail ? (viewerInTop ? sh.aboutRowByEmail[viewerEmail] : null) || viewer?.aboutRow : null;
  if (viewerEmail && mine) {
    const weekStart = sh.weekStart;
    const changed = mine.about_changed_month === weekStart;
    const outOfTries = mine.about_check_month === weekStart && (mine.about_check_count || 0) >= 2;
    viewerAbout = { text: mine.about_text || null, canChange: !changed && !outOfTries, lockReason: changed ? 'changed' : (outOfTries ? 'tries' : null) };
    try {
      // The viewer's own row already carries these (getViewerDetails);
      // only fall back to a separate lookup if it didn't.
      const own = viewer?.aboutRow;
      const { data: b, error: bErr } = own && 'about_banned_until' in own
        ? { data: own, error: null }
        : await supabase.from('students').select('about_banned_until, about_reset_allowed').eq('email', viewerEmail).maybeSingle();
      if (!bErr && b) {
        if (b.about_banned_until && new Date(b.about_banned_until) > new Date()) {
          viewerAbout = Object.assign(viewerAbout, { canChange: false, lockReason: 'banned', bannedUntil: b.about_banned_until });
        } else if (b.about_reset_allowed) {
          viewerAbout = Object.assign(viewerAbout, { canChange: true, lockReason: null, removedByTeam: true });
        }
      }
    } catch (e) { /* not migrated yet */ }
  }

  return json(200, { leaderboard, viewerRank, todayLeaders, liveCount, viewerAbout });
}

// Same output as lib fetchTodayLeaders(supabase, viewerEmail), built from
// the shared cache plus the viewer's own details.
function buildToday(sh, viewerEmail, viewer, viewerFlagged, nameFor) {
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
