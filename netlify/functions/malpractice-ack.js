// POST /api/malpractice-ack  { email }
//
// Called once when a student clicks Okay on the (non-freeze) malpractice
// warning gate — see renderPomoMalpracticeGateHtml/the Okay button's click
// handler in progress.js, and increment_malpractice_warning_ack in
// schema.sql. This is what makes a specific warning tier nag at most 3
// times before going quiet on its own — the underlying
// malpractice_incident_count never decreases (a permanent record for
// admin visibility), only how many more times the gate is willing to show
// itself for THIS particular incident count.
//
// Fire-and-forget from the client, same as pomo-active/pomo-settings — a
// lost write here just means the local dismiss still worked for this one
// visit, but the server-side nag budget didn't decrement, so the gate
// might show one extra time than intended on a future visit. Harmless
// either way, never worth blocking the dismiss animation on.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('increment_malpractice_warning_ack', { p_email: email }).maybeSingle();
  if (error) return json(500, { error: error.message });

  return json(200, { ok: true, malpracticeWarningAckCount: data ? data.malpractice_warning_ack_count : null });
}
