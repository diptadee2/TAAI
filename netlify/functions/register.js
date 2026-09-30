// POST /api/register  { email, display_name, batch }
// First-visit registration. If the email already exists, returns the
// existing record as-is (the student is "recognised", not renamed) —
// re-registering on a new device shouldn't silently overwrite their name.
//
// batch (added 2026-09-28) is only ever meaningful for a genuinely NEW
// student — it's how a guest's first real action (ticking a task /
// starting Focus while previewing a batch's schedule via progress.js's
// batch dropdown) locks in which batch they belong to. Validated against
// a small allowlist, defaulting to 'C' (the original batch) for a
// missing/invalid value so a malformed or stale-client request can never
// create a batch-less row. An EXISTING student's batch is never
// re-assigned here — see the `if (existing) return` branch below.
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

// Hand-duplicated in progress.js (its batch-preview dropdown options) —
// same small-constant-across-the-client/server-boundary tradeoff already
// accepted elsewhere in this codebase (e.g. POMO_WORK_MAX_MINUTES).
const VALID_BATCHES = ['C', 'D'];

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const displayName = String(body.display_name || '').trim();
  const batch = VALID_BATCHES.includes(body.batch) ? body.batch : 'C';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'valid email is required' });
  if (!displayName) return json(400, { error: 'display_name is required' });

  const supabase = getSupabase();

  const { data: existing, error: fetchError } = await supabase
    .from('students')
    .select('email, display_name, batch')
    .eq('email', email)
    .maybeSingle();
  if (fetchError) return json(500, { error: fetchError.message });
  if (existing) return json(200, existing);

  const { data: created, error: insertError } = await supabase
    .from('students')
    .insert({ email, display_name: displayName, batch })
    .select('email, display_name, batch')
    .single();
  if (insertError) return json(500, { error: insertError.message });

  await triggerNameCheckBackground(event, email, displayName);

  return json(200, created);
}
