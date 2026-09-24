// POST /api/register  { email, display_name }
// First-visit registration. If the email already exists, returns the
// existing record as-is (the student is "recognised", not renamed) —
// re-registering on a new device shouldn't silently overwrite their name.
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

  // A brand-new name entering the system for the very first time — the
  // one moment before this is ever written anywhere or shown on a
  // public leaderboard. Without this, an inappropriate name would sit
  // live until name-check-scan.js's nightly pass caught it, up to ~24h
  // later. Checked here, not left to the nightly scan alone, since that
  // gap is real exposure on a public, educational site — worth the
  // extra latency on this one, rare, first-time action. Fails open on
  // any Claude error (API down, no key configured) so a moderation
  // hiccup can never block someone from registering at all — the
  // nightly scan remains as a backstop for exactly that case.
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
