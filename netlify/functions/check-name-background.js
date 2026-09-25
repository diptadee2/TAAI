// Netlify Background Function — the `-background.js` filename suffix is
// what makes Netlify's own infrastructure treat this specially: the
// caller gets an immediate 202 ack, and this keeps running afterward for
// real (confirmed with a disposable local test before this was built: a
// 4-second sleep genuinely completed in the background while the caller
// had already moved on). Triggered fire-and-forget by register.js (every
// new signup) the instant a name is saved — this is where the actual
// Claude review happens, seconds later, without the student ever
// waiting on it. See register.js's own top comment for the direct
// correction that led here ("save the name whatever it is instantly,
// while putting it on check"). rename.js's voluntary-rename branch used
// to fire this too, but now runs its own synchronous check inline
// instead (direct follow-up request — see its own comment), so a rename
// response can tell the student right away whether they're gated.
import { getSupabase } from './lib/supabase.js';
import { checkNameAppropriate, crossStudentReviewNote, fetchOtherFlaggedNames } from './lib/name-check.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };

  // Internal-only — shares a secret with its two callers (triggerNameCheckBackground
  // in lib/name-check.js) rather than adding a new env var just for this.
  // SUPABASE_SERVICE_KEY is already a required, always-present server-side
  // secret, never exposed to the browser. A missing/mismatched header just
  // silently no-ops — nobody is waiting on this response either way, so
  // there's nothing to reject to, only something to skip.
  const secret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'];
  if (!process.env.SUPABASE_SERVICE_KEY || secret !== process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, body: '' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 200, body: '' }; }
  const email = String(body.email || '').trim().toLowerCase();
  const displayName = String(body.display_name || '').trim();
  if (!email || !displayName) return { statusCode: 200, body: '' };

  const supabase = getSupabase();

  // Fetched before the Claude call so it can be passed AS context to it
  // (see checkNameAppropriate's own comment on last_flagged_name) — not
  // just used afterward for the race-guard below.
  let priorFlaggedName = null;
  try {
    const { data: existing } = await supabase.from('students').select('last_flagged_name').eq('email', email).maybeSingle();
    priorFlaggedName = existing?.last_flagged_name || null;
  } catch (e) {
    console.error('check-name-background.js: last_flagged_name lookup failed for', email, e);
  }

  let result;
  try {
    result = await checkNameAppropriate(displayName, priorFlaggedName);
  } catch (e) {
    console.error('check-name-background.js: Claude check failed for', email, e);
    // Deliberately no write here at all — leaving name_last_checked
    // untouched means this name still reads as an unreviewed candidate,
    // so name-check-scan.js's daily safety-net run (see its own comment)
    // picks it up and retries, rather than a one-shot failure here
    // silently going unnoticed forever.
    return { statusCode: 200, body: '' };
  }
  if (result.skipped) return { statusCode: 200, body: '' }; // no API key configured — nothing to record either way

  // Only apply if the student's name is STILL what was actually checked —
  // by the time this runs (a few seconds later), a fast-fingered student
  // may have already renamed again (which fires its own, newer background
  // check for the newer name), or an admin may have already cleared/
  // renamed them via /team. Gating over a name that's no longer even
  // current would be confusing and wrong.
  try {
    const { data: current } = await supabase
      .from('students')
      .select('display_name')
      .eq('email', email)
      .maybeSingle();
    if (!current || current.display_name !== displayName) return { statusCode: 200, body: '' };

    const patch = { name_last_checked: displayName, name_check_reason: result.reason || null };
    if (result.flagged) {
      patch.needs_rename = true;
      patch.needs_rename_source = 'ai_scan';
      patch.last_flagged_name = displayName; // permanent record — see its own comment in schema.sql
    }
    await supabase.from('students').update(patch).eq('email', email);

    // Deliberately its OWN separate, best-effort write, never merged
    // into the patch above — a real regression caught during testing,
    // not avoided by luck: name_review_note is a newer column than
    // needs_rename/name_last_checked/etc., and a single .update() call
    // fails ENTIRELY if even one column in it doesn't exist yet.
    // Combining them would have meant a still-pending name_review_note
    // migration silently breaking the actual gating write too, not just
    // the new advisory feature — the exact mistake this codebase's own
    // history already flags (see malpractice_warning_ack_count's
    // writeup in CLAUDE.md).
    try {
      const otherFlagged = await fetchOtherFlaggedNames(supabase, email);
      const note = crossStudentReviewNote(displayName, email, otherFlagged);
      await supabase.from('students').update({ name_review_note: note }).eq('email', email);
    } catch (e2) {
      console.error('check-name-background.js: name_review_note write failed for', email, e2);
    }
  } catch (e) {
    console.error('check-name-background.js: write failed for', email, e);
  }

  return { statusCode: 200, body: '' };
}
