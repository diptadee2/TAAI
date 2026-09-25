// POST /api/rename  { email, display_name }
// The one path that actually changes a student's display name. Deliberately
// separate from register.js, which recognizes a returning student by email
// and ignores whatever name they typed that time — this is only reachable
// from an explicit "Rename" action the student takes on purpose, not a
// side effect of registering again on a new device.
import { getSupabase, json, todayIST } from './lib/supabase.js';
import { checkNameAppropriate, crossStudentReviewNote, fetchOtherFlaggedNames } from './lib/name-check.js';

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
  let voluntaryChecked = false; // true only when the voluntary branch's OWN synchronous Claude check below genuinely ran (not skipped for a missing API key)
  let voluntaryFlagged = false; // the actual verdict, only meaningful when voluntaryChecked is true
  let voluntaryReason = null;
  let voluntaryReviewNote; // undefined = don't touch; null/string = the voluntary branch's own computed name_review_note, set only alongside voluntaryChecked
  let gatedNameVerified = false; // set only when the gated branch's own synchronous Claude check actually ran and passed for this exact name
  let gatedReviewNote; // undefined = don't touch; null/string = the gated branch's own computed name_review_note, set only alongside gatedNameVerified
  try {
    const { data: existing } = await supabase
      .from('students')
      .select('display_name, needs_rename, needs_rename_source, last_flagged_name')
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

      // Runs a real, SYNCHRONOUS Claude check right here, in the same
      // request that saves the new name — direct follow-up request
      // ("put it to claude check right after rename is done and then
      // let them use the timer"), reversing the earlier "save it
      // instantly, check separately via a background function a few
      // seconds later" design this file used to have (see
      // check-name-background.js's own top comment for that history —
      // it's still the real path for register.js, just not this one
      // anymore). The name is still saved unconditionally below either
      // way — this never REJECTS a voluntary rename outright, it only
      // decides whether the student walks away from this same request
      // already gated (needs_rename=true) or not, so the client can show
      // a genuine "Checking…" state and react immediately to the real
      // outcome instead of finding out invisibly, later. Fail-open on
      // any error/timeout, same as every other call site — a Claude
      // hiccup just means this rename goes through un-gated, with the
      // daily safety-net scan (name-check-scan.js) as the backstop.
      // existing.last_flagged_name (if any) is passed as context so a
      // softened reword of THIS student's own prior flagged name is
      // still caught (see checkNameAppropriate's own comment).
      try {
        const result = await checkNameAppropriate(displayName, existing.last_flagged_name || null);
        if (!result.skipped) {
          voluntaryChecked = true;
          voluntaryFlagged = !!result.flagged;
          voluntaryReason = result.reason || null;
          const otherFlagged = await fetchOtherFlaggedNames(supabase, email);
          voluntaryReviewNote = crossStudentReviewNote(displayName, email, otherFlagged);
        }
      } catch (e) {
        console.error('rename.js: voluntary synchronous Claude check failed for', email, e);
      }
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
        return json(400, { error: HANDED_OFF_MESSAGE, triesLeft: 0 });
      }

      try {
        // existing.display_name is the name CURRENTLY causing the gate —
        // passed as context so Claude can tell whether this new attempt
        // is a genuine fix or a softened reword of the same thing (see
        // checkNameAppropriate's own comment on last_flagged_name). Only
        // when needs_rename_source is 'ai_scan' — a real, content-based
        // Claude verdict — not 'admin', which can mean anything (a real
        // spotted problem, but just as easily a one-off manual/test flag
        // completely unrelated to the name's actual content, exactly
        // what a manually-flagged real account hit here: an innocent
        // name ("Dipta") got admin-flagged purely to test this gate's
        // UI, and passing it as "previously flagged inappropriate"
        // context caused Claude to read the student's own real, fine
        // follow-up name as evasion of a problem that never existed).
        // Getting this wrong costs a real student a genuine attempt at
        // the 3-try cap over nothing they actually did.
        const priorContext = existing.needs_rename_source === 'ai_scan' ? existing.display_name : null;
        const result = await checkNameAppropriate(displayName, priorContext);
        // Declared here, not inside the block below, specifically so the
        // triesLeft calculation further down (a real bug caught by
        // testing, not assumed away: a first version declared this with
        // const INSIDE the !result.skipped block, throwing
        // "newCount is not defined" the instant a real flagged result
        // tried to read it from the sibling if-block below) can read it.
        let newCount = priorCheckCount;
        if (!result.skipped) {
          newCount = priorCheckCount + 1;
          const escalateNow = result.flagged && newCount >= GATE_CHECK_LIMIT;
          const countPatch = { gate_name_check_count: newCount, gate_name_check_month: month, gate_escalated: escalateNow };
          // A rejected attempt is itself real evidence of what this
          // student just tried — recorded even though the gate isn't
          // resolved yet, so a LATER attempt (this session or a future
          // one) sees the most recent real try, not a stale one.
          if (result.flagged) countPatch.last_flagged_name = displayName;
          try {
            await supabase
              .from('students')
              .update(countPatch)
              .eq('email', email);
          } catch (e) {
            console.error('rename.js: gate_name_check increment failed for', email, e);
          }
          if (escalateNow) {
            return json(400, { error: HANDED_OFF_MESSAGE, triesLeft: 0 });
          }
        }
        if (result.flagged) {
          // result.flagged can only be true when !result.skipped also ran
          // above (a skipped check never comes back flagged), so newCount
          // here is always the real, just-incremented count from that
          // block, not the unchanged priorCheckCount fallback.
          return json(400, {
            error: 'That name still isn\'t appropriate for this site — ' + (result.reason || 'please pick a different one.'),
            triesLeft: Math.max(0, GATE_CHECK_LIMIT - newCount),
          });
        }
        if (!result.skipped) {
          gatedNameVerified = true;
          // Only computed here, on the name that's ACTUALLY about to be
          // saved — not on a rejected attempt above, which never becomes
          // the student's real display_name and would leave a note
          // describing a name nobody can even see.
          const otherFlagged = await fetchOtherFlaggedNames(supabase, email);
          gatedReviewNote = crossStudentReviewNote(displayName, email, otherFlagged);
        }
      } catch (e) {
        console.error('rename.js: Claude appropriateness check failed for', email, e);
      }
    }
  } catch (e) {
    console.error('rename.js: needs_rename dodge-check failed for', email, e);
  }

  // Clears needs_rename (see its own comment in schema.sql) as part of
  // the same write, not a separate call, UNLESS the voluntary branch's
  // own synchronous check above just flagged this exact new name
  // (voluntaryFlagged) — in that case the rename still SAVES (the whole
  // point of "save it, check it, gate them if it's bad" is that the name
  // change itself is never blocked), it just leaves the student gated
  // right away instead of clearing the flag, exactly as if they'd been
  // flagged any other way. needs_rename_source/name_check_reason mirror
  // that same either/or: 'ai_scan'+Claude's real reason when flagged,
  // cleared otherwise. gate_name_check_count/month/gate_escalated always
  // reset to a clean slate here regardless — those track attempts to
  // RESOLVE a gate, a different concept from how one started, so a
  // freshly (re-)gated student always gets a full, fresh GATE_CHECK_LIMIT
  // budget to fix it, never inheriting stale counters from an old episode.
  // **name_last_checked is written here whenever a synchronous Claude
  // check genuinely just ran for this exact name** — either branch's own
  // check (gatedNameVerified, or voluntaryChecked regardless of its
  // verdict) — so name-check-scan.js's daily safety net doesn't waste a
  // redundant re-check on something just reviewed seconds ago.
  // voluntaryRenameCountThisMonth is only non-null on the voluntary
  // path — incremented here (not earlier) since it should only count a
  // genuinely SUCCESSFUL rename (the name change itself, independent of
  // whether it then gates them), and this is the point where success is
  // certain. Tries with the new fields first, falls back to
  // progressively fewer fields on a pre-migration "column does not
  // exist" error, same fallback shape already used elsewhere in this
  // codebase (e.g. pomo-active.js's owner_token) — a rename must never
  // fail outright just because a newer column doesn't exist yet.
  const fullUpdate = {
    display_name: displayName,
    needs_rename: voluntaryFlagged,
    needs_rename_source: voluntaryFlagged ? 'ai_scan' : null,
    name_check_reason: voluntaryFlagged ? voluntaryReason : null,
    gate_name_check_count: 0,
    gate_name_check_month: null,
    gate_escalated: false,
  };
  if (gatedNameVerified || voluntaryChecked) { fullUpdate.name_last_checked = displayName; }
  if (voluntaryFlagged) { fullUpdate.last_flagged_name = displayName; }
  if (voluntaryRenameCountThisMonth != null) {
    fullUpdate.voluntary_rename_count = voluntaryRenameCountThisMonth + 1;
    fullUpdate.voluntary_rename_month = month;
  }

  let { data, error } = await supabase
    .from('students')
    .update(fullUpdate)
    .eq('email', email)
    .select('email, display_name, needs_rename, voluntary_rename_count, voluntary_rename_month')
    .maybeSingle();
  if (error) {
    ({ data, error } = await supabase
      .from('students')
      .update({ display_name: displayName, needs_rename: voluntaryFlagged })
      .eq('email', email)
      .select('email, display_name, needs_rename')
      .maybeSingle());
  }
  if (error) {
    ({ data, error } = await supabase
      .from('students')
      .update({ display_name: displayName })
      .eq('email', email)
      .select('email, display_name, needs_rename')
      .maybeSingle());
  }
  if (error) return json(500, { error: error.message });
  if (!data) return json(404, { error: 'student not found' });

  // Own separate, best-effort write — deliberately never merged into
  // fullUpdate above. Whichever branch actually ran a synchronous check
  // (gatedNameVerified or voluntaryChecked — never both, the two
  // branches are mutually exclusive) supplies its own already-computed
  // note; a still-pending name_review_note migration must never widen
  // fullUpdate's own fallback chain further than necessary —
  // name_last_checked/name_check_reason/etc. already exist and should
  // still be written even on a day name_review_note doesn't yet.
  const reviewNoteToWrite = gatedNameVerified ? gatedReviewNote : (voluntaryChecked ? voluntaryReviewNote : undefined);
  if (reviewNoteToWrite !== undefined) {
    try {
      await supabase.from('students').update({ name_review_note: reviewNoteToWrite }).eq('email', email);
    } catch (e) {
      console.error('rename.js: name_review_note write failed for', email, e);
    }
  }

  return json(200, data);
}
