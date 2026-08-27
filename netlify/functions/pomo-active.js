// POST /api/pomo-active  { email, mode, running, secondsLeft, totalSeconds, phaseEndAt, completedSessions }
//
// Persists the pomodoro timer's active/paused state server-side, mirroring
// what's already written to this device's own localStorage (see
// savePomoActiveState in progress.js). Called on every meaningful client-
// side change — start, pause, skip, reset, phase-advance — the same
// choke point that already writes localStorage. This is what lets a
// student open the tracker on a different browser/device and correctly
// see an already-running session (see tracker-data.js's pomoActive field
// for the read side) instead of a fresh, unaware timer.
//
// Fire-and-forget from the client (non-critical if it fails, same as
// pomo-settings) — a lost write here just means cross-device sync is
// stale until the next successful one, not that the timer itself breaks;
// localStorage remains the authoritative same-device state regardless.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });
  if (body.mode !== 'work' && body.mode !== 'break') return json(400, { error: 'mode must be "work" or "break"' });

  const totalSeconds = Number.isFinite(body.totalSeconds) ? body.totalSeconds : null;
  const secondsLeft = Number.isFinite(body.secondsLeft) ? body.secondsLeft : null;
  const running = !!body.running;

  const supabase = getSupabase();

  // phase_started_at backs pomodoro-complete.js's server-side verification
  // that a claimed session actually ran (see credit_pomodoro_phase in
  // schema.sql) — it has to be this server's own clock, never anything the
  // client sends, so a fresh Date.now() is only stamped here when this
  // update genuinely represents a NEW phase starting: mode or duration
  // changed from what's currently stored, or running just flipped on with
  // a full, unconsumed duration (a real Start/Skip/Reset-then-Start, not a
  // Pause/Resume of the same in-progress phase, which should keep
  // accumulating from when it first began).
  const { data: existing, error: readError } = await supabase
    .from('pomo_active_session')
    .select('mode, total_seconds, phase_started_at')
    .eq('email', email)
    .maybeSingle();
  if (readError) return json(500, { error: readError.message });

  const isNewPhase = !existing ||
    existing.mode !== body.mode ||
    existing.total_seconds !== totalSeconds ||
    (running && secondsLeft === totalSeconds);
  const phaseStartedAt = isNewPhase ? Date.now() : (existing.phase_started_at ?? Date.now());

  const { error } = await supabase
    .from('pomo_active_session')
    .upsert({
      email,
      mode: body.mode,
      running,
      phase_end_at: Number.isFinite(body.phaseEndAt) ? body.phaseEndAt : null,
      seconds_left: secondsLeft,
      total_seconds: totalSeconds,
      completed_sessions: Number.isFinite(body.completedSessions) ? body.completedSessions : 0,
      phase_started_at: phaseStartedAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });
  if (error) return json(500, { error: error.message });

  return json(200, { ok: true });
}
