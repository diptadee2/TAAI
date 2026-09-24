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
// A student is a candidate only if BOTH: (1) they aren't already
// needs_rename (no point re-flagging someone already gated — whatever
// resolves that at rename time will re-check the new name on its own),
// and (2) their current display_name doesn't match name_last_checked
// (never checked, or checked a since-changed name). This is done
// entirely server-side via get_name_check_candidates() (schema.sql) —
// NOT a fetch-everything-then-filter-in-JS pattern. That was the
// original version, and it was a real, measured cost problem once this
// cron widened from once-a-day to every 5 minutes: fetching all ~344
// students on every tick to find usually-zero candidates measured out to
// ~339MB/month against real production data, almost entirely wasted.
// The RPC returns only the (usually zero, at most SCAN_LIMIT) rows that
// actually need checking — a near-empty response on a typical tick.
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

  const { data: candidates, error } = await supabase.rpc('get_name_check_candidates', { p_limit: SCAN_LIMIT });
  if (error) {
    // Pre-migration (the RPC, or the columns it reads, not added to
    // production yet) or any other lookup hiccup — a clean no-op
    // response, not a scary 500 from a scheduled function nobody's
    // watching in real time. Retried automatically on the next run (5
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

  return json(200, { candidates: (candidates || []).length, checked, flagged, errors });
}
