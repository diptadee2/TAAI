// POST /api/register  { email, display_name }
// First-visit registration. If the email already exists, returns the
// existing record as-is (the student is "recognised", not renamed) —
// re-registering on a new device shouldn't silently overwrite their name.
//
// Deliberately does NOT call Claude inline — saves the submitted name
// instantly, no synchronous check, no rejection path. This went through
// several designs the same day before landing here for good, on a
// direct, explicit correction: "save the name whatever it is instantly,
// while putting it on check — if it comes back with inappropriateness
// then gate the student to change it." A synchronous reject-before-
// saving design (tried twice, in both directions) makes signup feel slow
// and risky over an AI opinion; this doesn't. What actually reviews a
// brand-new name: `triggerNameCheckBackground()` fires
// check-name-background.js (a Netlify Background Function) right after
// the insert below — a real, separate check that runs seconds later,
// without the student ever waiting on it, and gates the student
// (needs_rename=true) rather than blocking the signup if Claude flags
// it. This replaced an earlier 15-minute polling scan the same day, on
// direct follow-up ("how bout there is a condition if there are name
// changes or new signups the function gets called?") — strictly better
// on both latency (seconds, not up to 15 minutes) and resource cost (no
// more near-empty poll ticks). name-check-scan.js still exists as a
// once-daily safety net for the rare case the background check itself
// fails to run — see its own comment.
import { getSupabase, json } from './lib/supabase.js';
import { triggerNameCheckBackground } from './lib/name-check.js';

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

  await triggerNameCheckBackground(event, email, displayName);

  return json(200, created);
}
