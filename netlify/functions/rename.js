// POST /api/rename  { email, display_name }
// The one path that actually changes a student's display name. Deliberately
// separate from register.js, which recognizes a returning student by email
// and ignores whatever name they typed that time — this is only reachable
// from an explicit "Rename" action the student takes on purpose, not a
// side effect of registering again on a new device.
import { getSupabase, json, todayIST } from './lib/supabase.js';
import { checkNameAppropriate } from './lib/name-check.js';

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
  let claudeVerified = false; // set only if the AI check actually ran and passed
  let voluntaryRenameCountThisMonth = null; // set only on the voluntary path, used by the final write below
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

      // Checked synchronously — register.js and this file are the only
      // two places display_name is ever written (see lib/name-check.js's
      // own top comment), so there's no separate scan to defer to
      // anymore. Simpler than the gated path below — no dodge-check
      // (nothing to dodge, they're not currently flagged), no
      // escalation (failing once here just means retyping, not "already
      // in trouble"). Fails open exactly like every other Claude call
      // site — see register.js's own comment for the accepted tradeoff
      // of no longer having a scan as a backstop for that case.
      try {
        const result = await checkNameAppropriate(displayName);
        if (result.flagged) {
          return json(400, { error: 'That name isn\'t appropriate for this site — ' + (result.reason || 'please pick a different one.') });
        }
        if (!result.skipped) claudeVerified = true;
      } catch (e) {
        console.error('rename.js: Claude appropriateness check (voluntary rename) failed for', email, e);
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
        if (!result.skipped) claudeVerified = true;
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
  // needs_rename_source and the gate_name_check_count/month/gate_escalated
  // bookkeeping (harmless no-op for a voluntary renamer, who was never
  // gated in the first place; for a formerly-gated one, whatever flagged
  // them no longer applies, and a future flag should start with a clean
  // slate rather than inheriting an old count) — and, whenever the
  // Claude check above genuinely ran and passed for this exact new name
  // (true on BOTH paths now — voluntary and gated), clears any stale
  // name_check_reason left over from a previous flag, since it no
  // longer describes the current name. (name_last_checked itself is
  // NOT written here anymore — it only ever existed for
  // name-check-scan.js's own "don't re-bill an unchanged name" check,
  // and that scan is gone; see this file's own top comment. The column
  // is left in schema.sql, just unused now, rather than needing another
  // migration to drop it.) voluntaryRenameCountThisMonth is only
  // non-null on the voluntary path — incremented here (not earlier)
  // since it should only count a genuinely SUCCESSFUL rename, and this
  // is the point where success is certain. Tries with the new fields
  // first, falls back to progressively fewer fields on a pre-migration
  // "column does not exist" error, same fallback shape already used
  // elsewhere in this codebase (e.g. pomo-active.js's owner_token) — a
  // rename must never fail outright just because a newer column doesn't
  // exist yet.
  const fullUpdate = {
    display_name: displayName,
    needs_rename: false,
    needs_rename_source: null,
    gate_name_check_count: 0,
    gate_name_check_month: null,
    gate_escalated: false,
  };
  if (claudeVerified) { fullUpdate.name_check_reason = null; }
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

  return json(200, data);
}
