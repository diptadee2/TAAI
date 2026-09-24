// POST /api/rename  { email, display_name }
// The one path that actually changes a student's display name. Deliberately
// separate from register.js, which recognizes a returning student by email
// and ignores whatever name they typed that time — this is only reachable
// from an explicit "Rename" action the student takes on purpose, not a
// side effect of registering again on a new device.
import { getSupabase, json, todayIST } from './lib/supabase.js';
import { checkNameAppropriate, triggerNameCheckBackground } from './lib/name-check.js';

// Both caps below are 3, but deliberately separate counters/columns (see
// schema.sql) — a gated student resolving their flag and an ordinary
// student renaming for fun are different situations with different
// consequences once exhausted (one escalates to the team, the other
// just waits until next month).
const GATE_CHECK_LIMIT = 3;
const VOLUNTARY_RENAME_LIMIT = 3;

function currentMonth() {
  return todayIST().slice(0, 7); // 'YYYY-MM'
}

// Strips everything but letters/digits and lowercases, so "Sandip",
// "Sandip.", "sandip_", "SANDIP " etc. all normalize identically — used
// only to catch someone satisfying the needs_rename gate (see schema.sql)
// with a trivial punctuation/case tweak of the exact name that got them
// flagged in the first place, not as a general "is this a real name"
// check (that's not something software can verify, and a voluntary,
// non-flagged rename is never restricted by this at all).
function normalizeForCompare(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const displayName = String(body.display_name || '').trim();
  if (!email) return json(400, { error: 'email is required' });
  if (!displayName) return json(400, { error: 'display_name is required' });

  const supabase = getSupabase();
  const month = currentMonth();

  // Best-effort/fault-tolerant throughout: a lookup failure (or a column
  // not existing yet pre-migration) just skips the corresponding check
  // rather than blocking a legitimate rename over it.
  let voluntaryRenameCountThisMonth = null; // set only on the voluntary path, used by the final write below
  let gatedNameVerified = false; // set only when the gated branch's own synchronous Claude check actually ran and passed for this exact name
  try {
    const { data: existing } = await supabase
      .from('students')
      .select('display_name, needs_rename')
      .eq('email', email)
      .maybeSingle();
    if (existing && !existing.needs_rename) {
      // A normal, non-gated rename. Capped at VOLUNTARY_RENAME_LIMIT
      // SUCCESSFUL renames per calendar month, added on direct request
      // ("everyone should have a three rename per month limit otherwise
      // we will unnecessarily use our claude resources") — checked
      // BEFORE calling Claude, not after, so an already-capped student
      // costs nothing, not even a wasted API call. Only a genuinely
      // successful rename counts against this (see the final write
      // below) — a rejected attempt doesn't cost them one of their 3.
      let priorVoluntaryCount = 0;
      try {
        const { data: rate } = await supabase
          .from('students')
          .select('voluntary_rename_count, voluntary_rename_month')
          .eq('email', email)
          .maybeSingle();
        if (rate && rate.voluntary_rename_month === month) {
          priorVoluntaryCount = rate.voluntary_rename_count || 0;
        }
        // else: no record, or a stale month — treat as a fresh 0, same
        // as the gated path's own monthly reset below.
      } catch (e) {
        console.error('rename.js: voluntary_rename rate lookup failed for', email, e);
      }

      if (priorVoluntaryCount >= VOLUNTARY_RENAME_LIMIT) {
        return json(400, { error: 'You\'ve used all your renames for this month — you can rename again from the 1st.' });
      }
      voluntaryRenameCountThisMonth = priorVoluntaryCount; // carried into the final write's increment

      // Deliberately NOT checked here — same "save it instantly, check
      // separately" design as register.js (see its own top comment for
      // the direct correction that led here). The new name is saved
      // unconditionally below; `triggerNameCheckBackground()` (called
      // right before the final return) fires a real, separate Claude
      // check a few seconds later and sets needs_rename=true if it's
      // flagged. The monthly cap above still applies here, unchanged —
      // it's not about avoiding a synchronous wait, it's about bounding
      // how many real Claude calls a student can cause via repeated
      // renaming, which is exactly as true regardless of when the check
      // actually runs.
    } else if (existing && existing.needs_rename) {
      const oldNorm = normalizeForCompare(existing.display_name);
      const newNorm = normalizeForCompare(displayName);
      if (newNorm.length < 2 || newNorm === oldNorm) {
        return json(400, { error: 'That\'s not really a different name — please enter your actual name.' });
      }

      // The dodge check above only catches a trivial punctuation/case
      // tweak of the SAME name — it says nothing about whether a
      // genuinely different new name is itself still inappropriate.
      // Closes that gap: a flagged student's replacement name gets run
      // through the same shared Claude classifier (lib/name-check.js) as
      // every other check in this file, and is rejected outright if
      // it's also flagged, with Claude's own reason surfaced directly in
      // the gate's error message.
      //
      // Capped at GATE_CHECK_LIMIT real attempts per calendar month —
      // once already escalated (an admin hasn't cleared it, and the
      // month hasn't rolled over yet), or once this exact attempt would
      // be the 3rd real one this month AND it's also rejected, no more
      // self-service tries: the student is handed off to the team
      // instead. A stored month that doesn't match the current one is
      // treated as a fresh start — resets BOTH the count and any
      // escalation, a backstop alongside the manual /team clear (see
      // schema.sql) so nobody waits more than "the rest of this month"
      // even if nobody intervenes. One read (best-effort, fails open —
      // a lookup hiccup just means "don't escalate this one, let it
      // through as a normal check") decides current state.
      let alreadyEscalated = false;
      let priorCheckCount = 0;
      try {
        const { data: rate } = await supabase
          .from('students')
          .select('gate_name_check_count, gate_name_check_month, gate_escalated')
          .eq('email', email)
          .maybeSingle();
        if (rate && rate.gate_name_check_month === month) {
          alreadyEscalated = !!rate.gate_escalated;
          priorCheckCount = rate.gate_name_check_count || 0;
        }
        // else: no record, or a stale month — fresh start (both stay 0/false).
      } catch (e) {
        console.error('rename.js: gate_name_check rate lookup failed for', email, e);
      }

      const HANDED_OFF_MESSAGE = 'Please reach out to our team directly on Discord — they\'ll help you sort out your name.';
      if (alreadyEscalated) {
        return json(400, { error: HANDED_OFF_MESSAGE });
      }

      try {
        const result = await checkNameAppropriate(displayName);
        if (!result.skipped) {
          const newCount = priorCheckCount + 1;
          const escalateNow = result.flagged && newCount >= GATE_CHECK_LIMIT;
          try {
            await supabase
              .from('students')
              .update({ gate_name_check_count: newCount, gate_name_check_month: month, gate_escalated: escalateNow })
              .eq('email', email);
          } catch (e) {
            console.error('rename.js: gate_name_check increment failed for', email, e);
          }
          if (escalateNow) {
            return json(400, { error: HANDED_OFF_MESSAGE });
          }
        }
        if (result.flagged) {
          return json(400, { error: 'That name still isn\'t appropriate for this site — ' + (result.reason || 'please pick a different one.') });
        }
        if (!result.skipped) gatedNameVerified = true;
      } catch (e) {
        console.error('rename.js: Claude appropriateness check failed for', email, e);
      }
    }
  } catch (e) {
    console.error('rename.js: needs_rename dodge-check failed for', email, e);
  }

  // Clears needs_rename (see its own comment in schema.sql) as part of
  // the same write, not a separate call — the whole point of that flag
  // is "blocked until they rename," so the act of renaming itself is
  // what resolves it, with no separate admin step needed. Also clears
  // needs_rename_source, name_check_reason, and the
  // gate_name_check_count/month/gate_escalated bookkeeping (harmless
  // no-op for a voluntary renamer, who was never gated in the first
  // place; for a formerly-gated one, whatever flagged them no longer
  // applies, and a future flag should start with a clean slate rather
  // than inheriting an old count/reason). name_check_reason is cleared
  // unconditionally now, not just when the gated check verified it — on
  // the voluntary path nothing here verifies the new name synchronously
  // anymore (see the comment above), so a stale reason from BEFORE this
  // rename is never accurate for the new name either way: if the new
  // name also turns out bad, check-name-background.js (fired below)
  // writes a fresh reason of its own within seconds; if it's fine,
  // there's nothing to explain. **name_last_checked is written here
  // ONLY on the gated path, and only when its own synchronous Claude
  // check genuinely ran and passed** (`gatedNameVerified`) — a name that
  // just cleared a real Claude check seconds ago shouldn't cost a
  // second, redundant check. A voluntary rename deliberately leaves
  // name_last_checked untouched (still whatever it was before this
  // rename) so it stays a genuine mismatch against the NEW display_name
  // — that mismatch is exactly what the background check (and, as a
  // backstop, the daily safety-net scan) look for.
  // voluntaryRenameCountThisMonth is only non-null on the voluntary
  // path — incremented here (not earlier) since it should only count a
  // genuinely SUCCESSFUL rename, and this is the point where success is
  // certain. Tries with the new fields first, falls back to
  // progressively fewer fields on a pre-migration "column does not
  // exist" error, same fallback shape already used elsewhere in this
  // codebase (e.g. pomo-active.js's owner_token) — a rename must never
  // fail outright just because a newer column doesn't exist yet.
  const fullUpdate = {
    display_name: displayName,
    needs_rename: false,
    needs_rename_source: null,
    name_check_reason: null,
    gate_name_check_count: 0,
    gate_name_check_month: null,
    gate_escalated: false,
  };
  if (gatedNameVerified) { fullUpdate.name_last_checked = displayName; }
  if (voluntaryRenameCountThisMonth != null) {
    fullUpdate.voluntary_rename_count = voluntaryRenameCountThisMonth + 1;
    fullUpdate.voluntary_rename_month = month;
  }

  let { data, error } = await supabase
    .from('students')
    .update(fullUpdate)
    .eq('email', email)
    .select('email, display_name, voluntary_rename_count, voluntary_rename_month')
    .maybeSingle();
  if (error) {
    ({ data, error } = await supabase
      .from('students')
      .update({ display_name: displayName, needs_rename: false })
      .eq('email', email)
      .select('email, display_name')
      .maybeSingle());
  }
  if (error) {
    ({ data, error } = await supabase
      .from('students')
      .update({ display_name: displayName })
      .eq('email', email)
      .select('email, display_name')
      .maybeSingle());
  }
  if (error) return json(500, { error: error.message });
  if (!data) return json(404, { error: 'student not found' });

  // Only the voluntary path needs a real check dispatched — the gated
  // path already ran its own synchronous check above (and, on success,
  // recorded it via gatedNameVerified, so it wouldn't be a candidate for
  // this anyway).
  if (voluntaryRenameCountThisMonth != null) {
    await triggerNameCheckBackground(event, email, displayName);
  }

  return json(200, data);
}
