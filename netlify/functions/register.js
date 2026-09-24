// POST /api/register  { email, display_name }
// First-visit registration. If the email already exists, returns the
// existing record as-is (the student is "recognised", not renamed) —
// re-registering on a new device shouldn't silently overwrite their name.
//
// Deliberately does NOT call Claude here — a real Claude check was
// briefly added right before the INSERT, then removed the same day on
// direct instruction: a brand-new registration has zero leaderboard
// visibility until the student has actually logged real focus time, so
// there's no urgency to block signup itself on a moderation call.
// Registration stays instant; name-check-scan.js's nightly pass covers
// every new student for free (name_last_checked starts null, so a
// brand-new row is always a candidate on the very next run) — up to
// ~24h of exposure, accepted as fine given a fresh signup isn't visible
// to anyone yet regardless.
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
