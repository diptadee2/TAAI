// Scheduled function (see netlify.toml) — runs once a day and deletes
// pomodoro_credit_failures rows older than 7 days.
//
// Unlike every other table this project writes to on a regular cadence
// (pomo_daily_sessions/pomodoro_stats are naturally bounded by active
// students x elapsed time, pomo_hourly_activity is a fixed 24 rows),
// pomodoro_credit_failures has no built-in cap at all — it's a pure
// diagnostic log, one row per rejected/errored completion attempt, with
// nothing that ever removes an old row. Growth is low in practice (it
// only fires on a FAILURE, not every completion — see its own comment in
// schema.sql), but "low but unbounded forever" is still worth capping
// rather than trusting to stay low indefinitely. A rejected completion is
// only useful to look at soon after it happens, while it's still
// possible to correlate with a real student report — nothing here needs
// to be kept long-term.
import { getSupabase, json } from './lib/supabase.js';

const RETENTION_DAYS = 7;

export async function handler() {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('pomodoro_credit_failures').delete().lt('created_at', cutoff);
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true, deletedBefore: cutoff });
}
