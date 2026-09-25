// Scheduled function (see netlify.toml, once daily) — a SAFETY NET, not
// the primary detection path. Checks any student whose display_name
// hasn't been run through the Claude appropriateness classifier yet
// (lib/name-check.js). The primary path is now event-driven:
// register.js and rename.js's voluntary-rename branch both save a name
// instantly, then fire check-name-background.js (a Netlify Background
// Function) to do the actual review a few seconds later — see that
// file's own comment. This scan exists only to catch what that misses:
// a background dispatch that never landed, a transient Claude/network
// error mid-check (check-name-background.js deliberately leaves
// name_last_checked unset on any failure, specifically so it still
// reads as a real candidate here). In steady state this should find
// ~zero candidates on a typical run. Originally the ONLY detection
// mechanism (15-minute polling, before that 5-minute, before that once
// a day) — moved to daily and demoted to backstop-only the same day the
// event-driven design shipped, on direct follow-up ("how bout there is
// a condition if there are name changes or new signups the function
// gets called?"): polling every 15 minutes for a check that now almost
// always already happened seconds after the fact was pure waste once
// the background function existed. rename.js's own gated-resolution
// branch (a student already needs_rename-gated, actively trying to fix
// it) still calls Claude SYNCHRONOUSLY, unrelated to any of this — that
// one stays a real reject-and-retry flow, since the whole point there is
// confirming a fix before letting the student out of the gate.
//
// A student is a candidate only if BOTH: (1) they aren't already
// needs_rename (no point re-flagging someone already gated — the gated
// resolution flow re-checks the new name on its own), and (2) their
// current display_name doesn't match name_last_checked (never checked,
// or checked a since-changed name that the background check somehow
// never got to). This is done entirely server-side via
// get_name_check_candidates() (schema.sql) — NOT a fetch-everything-
// then-filter-in-JS pattern, which was the original version and a real,
// measured cost problem once the cron briefly ran every 5 minutes
// (~339MB/month against real production data, almost entirely wasted).
// The RPC returns only the (now almost always zero) rows that actually
// need checking.
//
// SCAN_LIMIT caps how many students get checked per run — sized to
// clear a real backlog (a fresh deploy's very first run, a burst of
// background-check failures) within a reasonable number of ticks, not a
// full day's registrations in one go — a real ceiling against a runaway
// cost surprise if the candidate filter above ever misbehaves. Existing
// students from before this whole feature existed are NOT swept by this
// — see CLAUDE.md's "Name moderation" section for the one-time backfill
// that grandfathered the pre-existing roster in as unverified, by direct
// instruction, rather than retroactively reviewing it.
import { getSupabase, json } from './lib/supabase.js';
import { checkNameAppropriate, crossStudentReviewNote, fetchOtherFlaggedNames } from './lib/name-check.js';

const SCAN_LIMIT = 20;

export async function handler() {
  const supabase = getSupabase();

  const { data: candidates, error } = await supabase.rpc('get_name_check_candidates', { p_limit: SCAN_LIMIT });
  // Fetched once for the whole batch (not per-candidate) — the same
  // pool applies to every candidate this run, each one just excludes
  // itself when crossStudentReviewNote runs below.
  const otherFlagged = error ? [] : await fetchOtherFlaggedNames(supabase, null);
  if (error) {
    // Pre-migration (the RPC, or the columns it reads, not added to
    // production yet) or any other lookup hiccup — a clean no-op
    // response, not a scary 500 from a scheduled function nobody's
    // watching in real time. Retried automatically on the next run
    // (tomorrow) regardless.
    return json(200, { candidates: 0, checked: 0, flagged: 0, errors: [], skipped: error.message });
  }

  let checked = 0;
  let flagged = 0;
  const errors = [];

  for (const student of candidates || []) {
    try {
      const result = await checkNameAppropriate(student.display_name, student.last_flagged_name);
      if (result.skipped) break; // no API key configured — stop the whole run, not just this student, nothing else will succeed either

      // A student can rename again between when this candidate list was
      // fetched and when we actually get to writing this result — re-read
      // display_name right before writing so we never gate (or clear a
      // stale name_last_checked onto) a name that's already been
      // superseded by a newer save; a stale write here would also
      // silently mask the newer name from ever being picked up as its
      // own candidate on the next run.
      const { data: freshRow } = await supabase
        .from('students')
        .select('display_name')
        .eq('email', student.email)
        .maybeSingle();
      if (!freshRow || freshRow.display_name !== student.display_name) continue;

      checked++;
      const patch = { name_check_reason: result.reason || null, name_last_checked: student.display_name };
      if (result.flagged) {
        flagged++;
        patch.needs_rename = true;
        patch.needs_rename_source = 'ai_scan';
        patch.last_flagged_name = student.display_name; // permanent record — see its own comment in schema.sql
      }
      const { error: updateError } = await supabase.from('students').update(patch).eq('email', student.email);
      if (updateError) errors.push({ email: student.email, error: updateError.message });

      // Own separate, best-effort write — never merged into patch above.
      // See check-name-background.js's own comment for the real
      // regression this avoids: a still-pending name_review_note
      // migration must never take down the actual gating write too.
      try {
        const note = crossStudentReviewNote(student.display_name, student.email, otherFlagged);
        await supabase.from('students').update({ name_review_note: note }).eq('email', student.email);
      } catch (e2) {
        errors.push({ email: student.email, error: 'name_review_note write failed: ' + e2.message });
      }
    } catch (e) {
      // One student's check failing (API hiccup, rate limit) must never
      // stop the rest of the batch — it just stays a candidate and gets
      // picked up again on the next run (tomorrow).
      errors.push({ email: student.email, error: e.message });
    }
  }

  return json(200, { candidates: (candidates || []).length, checked, flagged, errors });
}
