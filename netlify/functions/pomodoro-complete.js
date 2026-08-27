// POST /api/pomodoro-complete  { email, phaseEndAt, minutes }
// Called once a focus (work) pomodoro session actually finishes, accumulating
// this week's focus time per student for Focus Mode's weekly leaderboard,
// and today's session count for the session dots. Only the genuine
// tick-to-zero completion path calls this (see progress.js's pomoTick), not
// Skip, otherwise a student could spam Skip for free credit on either stat.
//
// `minutes` is NOT trusted for the actual credited amount — this endpoint
// used to just take it at face value, which meant anyone could POST here
// directly with a fake value and top the (now public, name-attached)
// leaderboard with zero real focus time. Credit is instead verified against
// pomo_active_session, the server-side mirror of the timer's state that
// /pomo-active already maintains for cross-device sync (see
// pomo-active.js) — specifically phase_started_at, which that endpoint
// stamps with its OWN clock (never the client's) the moment it first sees
// a given phase begin. A claimed completion is only credited if the server
// itself has a matching record of that exact phase, and enough real
// wall-clock time has genuinely passed since it began. `phaseEndAt` is
// still accepted/logged but likewise not what's credited — see below.
import { getSupabase, json, weekStartIST, todayIST } from './lib/supabase.js';

// Matches the Focus settings panel's own max (progress.js's pomo-set-work
// input has max="180") — a single real session can never legitimately
// exceed this, so reject anything bigger rather than trusting the caller.
const MAX_MINUTES_PER_SESSION = 180;

// Slack between the real start and when phase_started_at actually gets
// stamped server-side — not a cheating allowance (someone still has to
// wait out virtually the entire real session either way), just headroom
// for how long the Start-time /pomo-active call can realistically take to
// land: a Netlify Function cold start plus the read-before-write it now
// does for new-phase detection can add real seconds, especially on a slow
// connection, and that gap directly eats into how much "elapsed" time the
// server sees by completion. 3s (the original value) proved too tight in
// production — legitimate completions were being rejected.
const GRACE_MS = 15000;

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const phaseEndAt = Number(body.phaseEndAt);
  if (!email || !Number.isFinite(phaseEndAt)) {
    return json(400, { error: 'email and phaseEndAt are required' });
  }

  const supabase = getSupabase();

  // Strict by design: if the server has no matching record of this exact
  // phase — e.g. its own /pomo-active sync call never landed, or this is a
  // fabricated request with no real session behind it at all — the
  // completion is rejected rather than falling back to trusting the
  // client. This is a deliberate call for a now-public, name-attached
  // leaderboard; progress.js retries the /pomo-active sync a couple of
  // times specifically to keep this rare in practice.
  const { data: session, error: sessionError } = await supabase
    .from('pomo_active_session')
    .select('mode, total_seconds, phase_started_at, phase_end_at')
    .eq('email', email)
    .maybeSingle();
  if (sessionError) return json(500, { error: sessionError.message });

  if (
    !session ||
    session.mode !== 'work' ||
    session.phase_end_at !== phaseEndAt ||
    !session.phase_started_at ||
    !Number.isFinite(session.total_seconds) ||
    session.total_seconds <= 0
  ) {
    return json(400, { error: 'could not verify this session' });
  }

  const claimedMs = session.total_seconds * 1000;
  const elapsedMs = Date.now() - session.phase_started_at;
  if (elapsedMs < claimedMs - GRACE_MS) {
    return json(400, { error: 'not enough time has elapsed for this session' });
  }

  const minutes = Math.min(MAX_MINUTES_PER_SESSION, Math.round(session.total_seconds / 60));
  if (minutes <= 0) return json(400, { error: 'invalid session duration' });

  // Atomic claim-once (see credit_pomodoro_phase in schema.sql) — a second
  // completion call for the same phase (two tabs mirroring one real
  // session, a retried request) matches nothing here and gets no row back,
  // so it's treated as an idempotent no-op below rather than double-
  // crediting.
  const { data: claim, error: claimError } = await supabase
    .rpc('credit_pomodoro_phase', { p_email: email, p_phase_end_at: phaseEndAt })
    .maybeSingle();
  if (claimError) return json(500, { error: claimError.message });
  if (!claim) return json(200, { ok: true, alreadyCredited: true });

  // Atomic UPSERTs (see increment_pomodoro_stats/increment_pomo_daily_sessions
  // in schema.sql), not a read-then-write from here — a lost-update race
  // between concurrent calls is avoided the same way credit_pomodoro_phase
  // avoids it above, via row-level locking during the UPDATE.
  const { data: weekData, error: weekError } = await supabase
    .rpc('increment_pomodoro_stats', { p_email: email, p_week_start: weekStartIST(), p_minutes: minutes })
    .single();
  if (weekError) return json(500, { error: weekError.message });

  const { data: dayData, error: dayError } = await supabase
    .rpc('increment_pomo_daily_sessions', { p_email: email, p_date: todayIST() })
    .single();
  if (dayError) return json(500, { error: dayError.message });

  return json(200, {
    ok: true,
    total_minutes: weekData.total_minutes,
    total_sessions: weekData.total_sessions,
    sessions_today: dayData.sessions_completed,
  });
}
