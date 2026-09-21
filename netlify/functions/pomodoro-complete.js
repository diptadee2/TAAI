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
import { getSupabase, json, weekStartIST, todayIST, hourIST } from './lib/supabase.js';

// See pomodoro_credit_failures in supabase/schema.sql — a rejected/errored
// completion used to leave zero trace anywhere once the response was
// sent, which made a real report ("I completed a 2-hour session, it
// never showed up") impossible to actually diagnose after the fact, only
// guess at. Best-effort and never allowed to change the real response —
// wrapped in its own try/catch so a logging failure can't turn an
// already-decided rejection into a 500, or (worse) silently swallow the
// real error the caller needs to see.
async function logCreditFailure(supabase, { email, reason, claimedPhaseEndAt, session, elapsedMs, claimedMs }) {
  try {
    await supabase.from('pomodoro_credit_failures').insert({
      email,
      reason,
      claimed_phase_end_at: Number.isFinite(claimedPhaseEndAt) ? claimedPhaseEndAt : null,
      session_snapshot: session || null,
      elapsed_ms: elapsedMs != null ? elapsedMs : null,
      claimed_ms: claimedMs != null ? claimedMs : null,
    });
  } catch (e) {
    console.error('pomodoro-complete.js: failed to log credit failure for', email, e);
  }
}

// Malpractice detection — see record_malpractice_incident in schema.sql.
// Only ever called for the insufficient_elapsed reason (every other
// rejection reason has a known legitimate, non-malicious cause — see that
// function's own comment), and only once per genuinely NEW distinct
// phase, never once per retry: recordPomodoroCompletion (progress.js)
// retries a failed completion up to 2 more times, and without this
// dedupe check every one of those retries would independently count as
// its own "incident," inflating a single doomed attempt into 3.
// Deliberately checked BEFORE this rejection's own logCreditFailure call
// runs, so that insert is never mistaken for prior evidence of itself.
async function recordMalpracticeIfNewIncident(supabase, email, session) {
  try {
    const phaseStartedAt = session.phase_started_at;
    const { data: existing, error: existingError } = await supabase
      .from('pomodoro_credit_failures')
      .select('id')
      .eq('email', email)
      .eq('reason', 'insufficient_elapsed')
      .eq('session_snapshot->>phase_started_at', String(phaseStartedAt))
      .limit(1);
    if (existingError) { console.error('pomodoro-complete.js: malpractice dedupe check failed for', email, existingError.message); return; }
    if (existing && existing.length) return; // a retry of an already-counted incident

    const { error: recordError } = await supabase.rpc('record_malpractice_incident', { p_email: email });
    if (recordError) console.error('pomodoro-complete.js: failed to record malpractice incident for', email, recordError.message);
  } catch (e) {
    console.error('pomodoro-complete.js: malpractice tracking threw for', email, e);
  }
}

// Matches the Focus settings panel's own max (progress.js's
// POMO_WORK_MAX_MINUTES, pomo-settings.js's own POST clamp) — a single
// real session can never legitimately exceed this, so cap credited
// minutes at it rather than trusting whatever total_seconds happens to
// hold. Was 180 (the pre-2026-09-06 max) until both of those other two
// places were tightened to 120 the same day this changed — left at 180
// until then specifically so an already-in-flight 180-minute session
// wouldn't have its real, legitimate credit clipped by this cap the
// moment the client-side max dropped. Nothing that old can still be
// running 10 days later, so nothing legitimate is affected by tightening
// this now — it only ever mattered as a ceiling against total_seconds
// being wrong (corrupted data, a bypass of the other two checks), never
// as the normal path for a real session.
const MAX_MINUTES_PER_SESSION = 120;

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

  // Each check logged with its own specific reason (see
  // pomodoro_credit_failures in schema.sql) rather than one combined OR —
  // "could not verify this session" was the only trace of a rejection
  // before, with nothing recorded about WHICH condition actually failed.
  if (!session) {
    await logCreditFailure(supabase, { email, reason: 'no_active_session', claimedPhaseEndAt: phaseEndAt });
    return json(400, { error: 'could not verify this session' });
  }
  if (session.mode !== 'work') {
    await logCreditFailure(supabase, { email, reason: 'wrong_mode', claimedPhaseEndAt: phaseEndAt, session });
    return json(400, { error: 'could not verify this session' });
  }
  if (session.phase_end_at !== phaseEndAt) {
    await logCreditFailure(supabase, { email, reason: 'phase_end_mismatch', claimedPhaseEndAt: phaseEndAt, session });
    return json(400, { error: 'could not verify this session' });
  }
  if (!session.phase_started_at) {
    await logCreditFailure(supabase, { email, reason: 'no_phase_started_at', claimedPhaseEndAt: phaseEndAt, session });
    return json(400, { error: 'could not verify this session' });
  }
  if (!Number.isFinite(session.total_seconds) || session.total_seconds <= 0) {
    await logCreditFailure(supabase, { email, reason: 'invalid_total_seconds', claimedPhaseEndAt: phaseEndAt, session });
    return json(400, { error: 'could not verify this session' });
  }

  const claimedMs = session.total_seconds * 1000;
  const elapsedMs = Date.now() - session.phase_started_at;
  if (elapsedMs < claimedMs - GRACE_MS) {
    // Checked BEFORE logCreditFailure's own insert below, so that row is
    // never mistaken for prior evidence of itself — see
    // recordMalpracticeIfNewIncident's own comment for why this has to
    // run first and only counts genuinely new phases, not retries.
    await recordMalpracticeIfNewIncident(supabase, email, session);
    await logCreditFailure(supabase, { email, reason: 'insufficient_elapsed', claimedPhaseEndAt: phaseEndAt, session, elapsedMs, claimedMs });
    return json(400, { error: 'not enough time has elapsed for this session' });
  }

  const minutes = Math.min(MAX_MINUTES_PER_SESSION, Math.round(session.total_seconds / 60));
  if (minutes <= 0) {
    await logCreditFailure(supabase, { email, reason: 'invalid_minutes', claimedPhaseEndAt: phaseEndAt, session, elapsedMs, claimedMs });
    return json(400, { error: 'invalid session duration' });
  }

  // Atomic claim-once (see credit_pomodoro_phase in schema.sql) — a second
  // completion call for the same phase (two tabs mirroring one real
  // session, a retried request) matches nothing here and gets no row back,
  // so it's treated as an idempotent no-op below rather than double-
  // crediting.
  const { data: claim, error: claimError } = await supabase
    .rpc('credit_pomodoro_phase', { p_email: email, p_phase_end_at: phaseEndAt })
    .maybeSingle();
  if (claimError) {
    await logCreditFailure(supabase, { email, reason: 'claim_rpc_error: ' + claimError.message, claimedPhaseEndAt: phaseEndAt, session });
    return json(500, { error: claimError.message });
  }
  if (!claim) return json(200, { ok: true, alreadyCredited: true });

  // Atomic UPSERTs (see increment_pomodoro_stats/increment_pomo_daily_sessions
  // in schema.sql), not a read-then-write from here — a lost-update race
  // between concurrent calls is avoided the same way credit_pomodoro_phase
  // avoids it above, via row-level locking during the UPDATE.
  const { data: weekData, error: weekError } = await supabase
    .rpc('increment_pomodoro_stats', { p_email: email, p_week_start: weekStartIST(), p_minutes: minutes })
    .single();
  if (weekError) {
    await logCreditFailure(supabase, { email, reason: 'week_increment_error: ' + weekError.message, claimedPhaseEndAt: phaseEndAt, session });
    return json(500, { error: weekError.message });
  }

  const { data: dayData, error: dayError } = await supabase
    .rpc('increment_pomo_daily_sessions', { p_email: email, p_date: todayIST(), p_minutes: minutes })
    .single();
  if (dayError) {
    await logCreditFailure(supabase, { email, reason: 'day_increment_error: ' + dayError.message, claimedPhaseEndAt: phaseEndAt, session });
    return json(500, { error: dayError.message });
  }

  // All-time total (see all_time_minutes in schema.sql) — powers the
  // leaderboard hover tooltip (progress.js). Best-effort, same as the
  // hourly-activity increment below: a supplementary display number, not
  // something a student is owed credit for, so a failure here must never
  // turn an already-successful completion (the week/day increments above
  // already landed) into an error response.
  try {
    const { error: allTimeError } = await supabase.rpc('increment_student_all_time_minutes', { p_email: email, p_minutes: minutes });
    if (allTimeError) console.error('pomodoro-complete.js: failed to increment all-time minutes for', email, allTimeError.message);
  } catch (e) {
    console.error('pomodoro-complete.js: failed to increment all-time minutes for', email, e);
  }

  // Batch-wide "when does everyone study" histogram (see
  // pomo_hourly_activity in schema.sql) — attributed to the hour the
  // session STARTED in (phase_started_at), not when it finished, so a
  // session that happens to straddle an hour boundary still counts once,
  // toward the hour someone actually sat down. Best-effort: this is a
  // supplementary chart, not part of what a student is owed credit for,
  // so a failure here must never turn an already-successful completion
  // (the week/day increments above already landed) into an error
  // response — same reasoning as logCreditFailure's own try/catch.
  try {
    const { error: hourlyError } = await supabase.rpc('increment_hourly_activity', { p_hour: hourIST(session.phase_started_at), p_minutes: minutes });
    if (hourlyError) console.error('pomodoro-complete.js: failed to increment hourly activity for', email, hourlyError.message);
  } catch (e) {
    console.error('pomodoro-complete.js: failed to increment hourly activity for', email, e);
  }

  return json(200, {
    ok: true,
    total_minutes: weekData.total_minutes,
    total_sessions: weekData.total_sessions,
    sessions_today: dayData.sessions_completed,
  });
}
