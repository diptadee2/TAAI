// Scheduled function (see netlify.toml, every 5 minutes) — checks any
// student whose display_name hasn't been run through the Claude
// appropriateness classifier yet (lib/name-check.js) for a name that
// slipped past manual review entirely. This is what actually covers a
// brand-new registration — register.js itself deliberately doesn't call
// Claude at all (instant signup, no rejection path), so THIS is the
// first and only thing that ever checks a new student's name. rename.js's
// own inline check (only while a student is already needs_rename-gated)
// is the separate, reactive half that stops someone dodging an existing
// flag with a different-but-still-bad name.
//
// A student is a candidate here only if BOTH: (1) they aren't already
// needs_rename (no point re-flagging someone already gated — whatever
// resolves that at rename time will re-check the new name on its own),
// and (2) their current display_name doesn't match name_last_checked
// (never checked, or checked a since-changed name). This second
// condition is what keeps this cheap on every run once caught up: once a
// name has been checked and passed, it's never re-billed against the
// API again unless the student actually changes it.
//
// SCAN_LIMIT caps how many students get checked per run — every 5
// minutes is frequent enough that a brand-new signup is normally caught
// within minutes, so this only needs to be big enough to clear the
// occasional backlog (a fresh deploy's very first runs, a burst of
// signups) within a reasonable number of ticks, not a full day's worth
// of registrations in one go — a real ceiling against a runaway cost
// surprise if the candidate filter above ever misbehaves.
import { getSupabase, json } from './lib/supabase.js';
import { checkNameAppropriate } from './lib/name-check.js';

const SCAN_LIMIT = 20;

export async function handler() {
  const supabase = getSupabase();

  const { data: students, error } = await supabase
    .from('students')
    .select('email, display_name, needs_rename, name_last_checked');
  if (error) {
    // Pre-migration (needs_rename_source/name_check_reason/
    // name_last_checked not added to production yet) or any other
    // lookup hiccup — a clean no-op response, not a scary 500 from a
    // scheduled function nobody's watching in real time. Retried
    // automatically on the next run (5 minutes later) regardless.
    return json(200, { candidates: 0, checked: 0, flagged: 0, errors: [], skipped: error.message });
  }

  const candidates = (students || [])
    .filter((s) => !s.needs_rename && s.display_name && s.display_name !== s.name_last_checked)
    .slice(0, SCAN_LIMIT);

  let checked = 0;
  let flagged = 0;
  const errors = [];

  for (const student of candidates) {
    try {
      const result = await checkNameAppropriate(student.display_name);
      if (result.skipped) break; // no API key configured — stop the whole run, not just this student, nothing else will succeed either
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
      // picked up again on the next run (5 minutes later).
      errors.push({ email: student.email, error: e.message });
    }
  }

  return json(200, { candidates: candidates.length, checked, flagged, errors });
}
