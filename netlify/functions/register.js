// POST /api/register  { email, display_name }
// First-visit registration. If the email already exists, returns the
// existing record as-is (the student is "recognised", not renamed) —
// re-registering on a new device shouldn't silently overwrite their name.
//
// Deliberately does NOT call Claude here at all — saves the submitted
// name instantly, no check, no rejection path. This went through several
// designs the same day before landing here for good, on a direct,
// explicit correction: "save the name whatever it is instantly, while
// putting it on check — if it comes back with inappropriateness then
// gate the student to change it." A synchronous reject-before-saving
// design (tried twice, in both directions) makes signup feel slow and
// risky over an AI opinion; this doesn't. name-check-scan.js (see
// netlify.toml, every 15 minutes) is what actually reviews a brand-new
// name — picking it up via get_name_check_candidates() (schema.sql,
// name_last_checked IS NULL) within minutes of this insert — and sets
// needs_rename=true (gating Focus Mode, not the signup itself) if
// Claude flags it. Accepted, explicit tradeoff, confirmed with the user
// directly ("if netlify functions run every 15 minutes so be it, gate
// the student after 15 minutes"): a fresh signup is visible (on
// leaderboards, to other students) for up to ~15 minutes before a truly
// bad name would be caught — judged acceptable since a brand-new
// student has essentially zero visibility until real focus time is
// logged anyway, so there's no urgency the way there would be for
// something posted publicly at scale.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const displayName = String(body.display_name || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'valid email is required' });
  if (!displayName) return json(400, { error: 'display_name is required' });

  const supabase = getSupabase();

  const { data: existing, error: fetchError } = await supabase
    .from('students')
    .select('email, display_name')
    .eq('email', email)
    .maybeSingle();
  if (fetchError) return json(500, { error: fetchError.message });
  if (existing) return json(200, existing);

  const { data: created, error: insertError } = await supabase
    .from('students')
    .insert({ email, display_name: displayName })
    .select('email, display_name')
    .single();
  if (insertError) return json(500, { error: insertError.message });

  return json(200, created);
}
