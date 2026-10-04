// POST /api/pomo-claim-skipped  { email, phaseEndAt, phaseStartedAt, totalSeconds, clientNow }
//
// Diagnostic only (2026-10-04, after Yuvraj Makwana's 120-minute session
// went uncredited with no trace anywhere). When a work phase ends but the
// browser's own check (pomoPhaseRanFully in progress.js) decides not to
// send the completion claim, the session is lost silently: no credit, no
// row in pomodoro_credit_failures. This logs that skip there as its own
// reason, 'client_skipped', together with the server's current record of
// the phase, so the next report can be diagnosed instead of guessed.
// Never counts as malpractice (only insufficient_elapsed does) and never
// credits anything. Fire-and-forget from the client.
import { getSupabase, json } from './lib/supabase.js';

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email required' });

  const supabase = getSupabase();
  try {
    const { data: session } = await supabase
      .from('pomo_active_session')
      .select('mode, running, total_seconds, phase_end_at, phase_started_at, credited_through, owner_token, updated_at')
      .eq('email', email)
      .maybeSingle();
    const clientNow = num(body.clientNow);
    const clientStart = num(body.phaseStartedAt);
    const totalSeconds = num(body.totalSeconds);
    await supabase.from('pomodoro_credit_failures').insert({
      email,
      reason: 'client_skipped',
      claimed_phase_end_at: num(body.phaseEndAt),
      session_snapshot: {
        server: session || null,
        client: { phaseStartedAt: clientStart, phaseEndAt: num(body.phaseEndAt), totalSeconds, clientNow, serverNow: Date.now() },
      },
      elapsed_ms: clientNow != null && clientStart != null ? clientNow - clientStart : null,
      claimed_ms: totalSeconds != null ? totalSeconds * 1000 : null,
    });
  } catch (e) {
    console.error('pomo-claim-skipped.js: failed to log for', email, e);
  }
  return json(200, { ok: true });
}
