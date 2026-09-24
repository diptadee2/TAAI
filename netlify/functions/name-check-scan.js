// Scheduled function (see netlify.toml, every 15 minutes) — checks any
// student whose display_name hasn't been run through the Claude
// appropriateness classifier yet (lib/name-check.js). This is what
// actually reviews a brand-new registration or a voluntary rename —
// register.js and rename.js's own voluntary-rename branch both
// deliberately save the submitted name instantly with no Claude check
// at all (see register.js's top comment for the direct correction that
// led there: "save the name whatever it is instantly, while putting it
// on check — if it comes back with inappropriateness then gate the
// student to change it"), so THIS is where that check actually happens,
// separately, and where a flagged name gets gated (needs_rename=true)
// after the fact rather than being rejected up front. rename.js's own
// inline check (only while a student is already needs_rename-gated) is
// the separate, synchronous half that stops someone dodging an existing
// flag with a different-but-still-bad name — that one stays a real
// reject-and-retry flow, since the whole point there is confirming
// they've actually fixed it before letting them out of the gate.
//
// A student is a candidate only if BOTH: (1) they aren't already
// needs_rename (no point re-flagging someone already gated — the gated
// resolution flow re-checks the new name on its own), and (2) their
// current display_name doesn't match name_last_checked (never checked,
// or checked a since-changed name — including a fresh rename, which
// always qualifies since rename.js never touches name_last_checked
// itself). This is done entirely server-side via
// get_name_check_candidates() (schema.sql) — NOT a fetch-everything-
// then-filter-in-JS pattern. That was the original version, and it was
// a real, measured cost problem once this cron ran every 5 minutes:
// fetching all ~344 students on every tick to find usually-zero
// candidates measured out to ~339MB/month against real production data,
// almost entirely wasted. The RPC returns only the (usually zero, at
// most SCAN_LIMIT) rows that actually need checking — a near-empty
// response on a typical tick. 15 minutes (not 5) is the cadence this
// time, confirmed directly with the user as an acceptable delay ("if
// netlify functions run every 15 minutes so be it, gate the student
// after 15 minutes") rather than re-introducing the earlier cost issue.
//
// SCAN_LIMIT caps how many students get checked per run — every 15
// minutes is frequent enough that a brand-new signup or rename is
// normally caught within that window, so this only needs to be big
// enough to clear the occasional backlog (a fresh deploy's very first
// runs, a burst of signups) within a reasonable number of ticks, not a
// full day's worth of registrations in one go — a real ceiling against
// a runaway cost surprise if the candidate filter above ever misbehaves.
import { getSupabase, json } from './lib/supabase.js';
import { checkNameAppropriate } from './lib/name-check.js';

const SCAN_LIMIT = 20;

export async function handler() {
  const supabase = getSupabase();

  const { data: candidates, error } = await supabase.rpc('get_name_check_candidates', { p_limit: SCAN_LIMIT });
  if (error) {
    // Pre-migration (the RPC, or the columns it reads, not added to
    // production yet) or any other lookup hiccup — a clean no-op
    // response, not a scary 500 from a scheduled function nobody's
    // watching in real time. Retried automatically on the next run (15
    // minutes later) regardless.
    return json(200, { candidates: 0, checked: 0, flagged: 0, errors: [], skipped: error.message });
  }

  let checked = 0;
  let flagged = 0;
  const errors = [];

  for (const student of candidates || []) {
    try {
      const result = await checkNameAppropriate(student.display_name);
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
      }
      const { error: updateError } = await supabase.from('students').update(patch).eq('email', student.email);
      if (updateError) errors.push({ email: student.email, error: updateError.message });
    } catch (e) {
      // One student's check failing (API hiccup, rate limit) must never
      // stop the rest of the batch — it just stays a candidate and gets
      // picked up again on the next run (15 minutes later).
      errors.push({ email: student.email, error: e.message });
    }
  }

  return json(200, { candidates: (candidates || []).length, checked, flagged, errors });
}
