// POST /api/team-clear-name-check { email, new_display_name? }
//
// Backs /team's Students view "Clear block" / "Rename" actions for a
// gate_escalated student (see schema.sql's own comment on that column —
// added on direct request for a real /team UI, replacing the earlier
// "one-off SQL statement only" instruction). Admin-gated like every
// other /team endpoint.
//
// Two modes in one endpoint rather than two separate ones, since they
// share almost all their logic:
// - No `new_display_name`: just clears the block (gate_escalated,
//   gate_name_check_count, gate_name_check_month) so the student can try
//   resolving their own gate again themselves, with a fresh 3 attempts.
//   needs_rename stays true — they still need to pick an acceptable
//   name, only the block on trying is lifted.
// - With `new_display_name`: the admin picks the name directly (e.g.
//   after actually talking to the student) — also clears needs_rename
//   itself, resolving the gate outright, not just unblocking it.
import { getSupabase, json, requireAdmin } from './lib/supabase.js';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;

  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });
  const newDisplayName = body.new_display_name ? String(body.new_display_name).trim() : null;

  const supabase = getSupabase();

  const patch = { gate_escalated: false, gate_name_check_count: 0, gate_name_check_month: null };
  if (newDisplayName) {
    patch.display_name = newDisplayName;
    patch.needs_rename = false;
    patch.needs_rename_source = null;
  }

  // Same progressively-smaller fallback chain as rename.js — a
  // pre-migration "column does not exist" error must never stop this
  // action from doing whatever subset of it still can be done. If
  // there's a display name to set, that alone is still a real,
  // meaningful action even without the gate_* columns existing yet; if
  // there's nothing but the gate_* clear and those columns don't exist,
  // there's genuinely nothing to fall back to — say so plainly instead
  // of pretending a no-op update accomplished something.
  let { data, error } = await supabase.from('students').update(patch).eq('email', email).select('email, display_name, needs_rename, gate_escalated').maybeSingle();
  if (error && newDisplayName) {
    ({ data, error } = await supabase
      .from('students')
      .update({ display_name: newDisplayName, needs_rename: false, needs_rename_source: null })
      .eq('email', email)
      .select('email, display_name, needs_rename')
      .maybeSingle());
  } else if (error) {
    return json(500, { error: 'The gate_escalated/gate_name_check_count columns don\'t exist in the database yet — run the schema migration first. (' + error.message + ')' });
  }
  if (error) return json(500, { error: error.message });
  if (!data) return json(404, { error: 'student not found' });

  return json(200, { ok: true, student: data });
}
