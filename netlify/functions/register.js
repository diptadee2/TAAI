// POST /api/register  { email, display_name }
// First-visit registration. If the email already exists, returns the
// existing record as-is (the student is "recognised", not renamed) —
// re-registering on a new device shouldn't silently overwrite their name.
//
// Checks the name with Claude synchronously, same as rename.js — this
// went through two earlier, opposite decisions the same day before
// landing here. First: checked synchronously, rejecting outright.
// Second: reverted to instant/unchecked, relying on a scheduled scan
// instead, on the reasoning that a fresh signup has zero visibility
// until real focus time is logged, so there's no urgency. Final, on a
// direct follow-up ("we can assume every name is correct and then
// whenever someone renames or joins new we can just call claude for
// it"): register.js and rename.js are the ONLY two places
// students.display_name is ever written (confirmed by checking, not
// assumed) — checking synchronously at both, with no separate async
// scan at all, is a strictly simpler architecture than "check most
// things immediately, plus a periodic catch-all for the one path that
// isn't" — so name-check-scan.js was removed entirely rather than kept
// as a redundant backstop. The one real tradeoff, worth knowing: with
// no scan, a name that slips through because Claude was genuinely
// unavailable at that exact moment (no API key, an outage, a timeout)
// is never automatically re-checked later — fail-open here is a
// deliberately accepted, expected-to-be-rare risk, not a guaranteed-
// eventually-caught one anymore.
import { getSupabase, json } from './lib/supabase.js';
import { checkNameAppropriate } from './lib/name-check.js';

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

  // A brand-new name, the one moment before it's ever written or shown
  // anywhere. Fails open on any Claude error (missing key, API down,
  // timeout) — a moderation hiccup must never block a legitimate
  // registration; see this file's own top comment for the accepted
  // tradeoff of no longer having a scan as a backstop for that case.
  try {
    const result = await checkNameAppropriate(displayName);
    if (result.flagged) {
      return json(400, { error: 'That name isn\'t appropriate for this site — ' + (result.reason || 'please pick a different one.') });
    }
  } catch (e) {
    console.error('register.js: Claude appropriateness check failed for', email, e);
  }

  const { data: created, error: insertError } = await supabase
    .from('students')
    .insert({ email, display_name: displayName })
    .select('email, display_name')
    .single();
  if (insertError) return json(500, { error: insertError.message });

  return json(200, created);
}
