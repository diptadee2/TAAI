// Scheduled function (see netlify.toml) — runs once a day and, if last
// week's final ranks haven't been computed yet, computes and stores them.
// Deliberately a daily "catch up if needed" check rather than a single
// precisely-timed once-a-week firing: Netlify Scheduled Function cron
// times are UTC regardless of IST logic elsewhere (same gotcha
// discord-dispatch.js already has to account for), so a fixed "exactly
// once a week" cron would need converting "00:something IST on Monday"
// into the correct UTC day/time by hand and would silently miss its one
// chance if that single run ever failed. A daily check is self-healing —
// if it fails one day, or the week's data wasn't fully written yet at
// the first attempt, the next day's run just catches it up — and it's
// idempotent (compute_weekly_final_ranks always recomputes cleanly from
// scratch), so running it more than once for the same week is harmless.
//
// This function only ever WRITES a new, previously-unused column
// (pomodoro_stats.final_rank) — nothing currently reads it. Deploying
// this has zero effect on any student-facing behavior until a separate,
// later change switches pomodoro-leaderboard.js's read path to actually
// use the stored value instead of its current live re-fetch-and-rank.
import { getSupabase, json, weekStartIST, weekBefore } from './lib/supabase.js';

export async function handler() {
  const supabase = getSupabase();
  const lastCompletedWeek = weekBefore(weekStartIST());

  const { count, error: checkError } = await supabase
    .from('pomodoro_stats')
    .select('*', { count: 'exact', head: true })
    .eq('week_start', lastCompletedWeek)
    .is('final_rank', null);
  if (checkError) return json(500, { error: checkError.message });

  if (!count) {
    return json(200, { week_start: lastCompletedWeek, action: 'skipped', reason: 'already computed (or no rows for this week)' });
  }

  const { error: rpcError } = await supabase.rpc('compute_weekly_final_ranks', { p_week_start: lastCompletedWeek });
  if (rpcError) return json(500, { error: rpcError.message });

  return json(200, { week_start: lastCompletedWeek, action: 'computed', rows_updated: count });
}
