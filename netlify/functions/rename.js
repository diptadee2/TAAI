// POST /api/rename  { email, display_name }
// The one path that actually changes a student's display name. Deliberately
// separate from register.js, which recognizes a returning student by email
// and ignores whatever name they typed that time — this is only reachable
// from an explicit "Rename" action the student takes on purpose, not a
// side effect of registering again on a new device.
import { getSupabase, json } from './lib/supabase.js';
import { checkNameAppropriate } from './lib/name-check.js';

// Caps how many real Claude calls one gated student can trigger within
// a rolling window (see gate_name_check_count/window_start's own
// comment in schema.sql) — a direct question raised that a gated
// student could otherwise resubmit indefinitely, each one a real billed
// API call. Once spent, further attempts are rejected outright (no
// dodge-check-only fallback — see schema.sql for why an earlier version
// of this that fell back to "unchecked, anything passes" was a real
// exploit) until the window expires.
const GATE_CHECK_LIMIT = 3;
const GATE_CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

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

  // Only a student currently gated by needs_rename gets either of these
  // two extra checks — everyone else can rename to whatever they like,
  // any time, no restriction. Best-effort/fault-tolerant throughout: a
  // lookup failure (or a column not existing yet pre-migration) just
  // skips the corresponding check rather than blocking a legitimate
  // rename over it.
  let claudeVerifiedName = null; // set only if the AI check actually ran and passed
  try {
    const { data: existing } = await supabase
      .from('students')
      .select('display_name, needs_rename')
      .eq('email', email)
      .maybeSingle();
    if (existing && existing.needs_rename) {
      const oldNorm = normalizeForCompare(existing.display_name);
      const newNorm = normalizeForCompare(displayName);
      if (newNorm.length < 2 || newNorm === oldNorm) {
        return json(400, { error: 'That\'s not really a different name — please enter your actual name.' });
      }

      // The dodge check above only catches a trivial punctuation/case
      // tweak of the SAME name — it says nothing about whether a
      // genuinely different new name is itself still inappropriate.
      // Closes that gap: a flagged student's replacement name gets run
      // through the same Claude classifier used by the nightly scan
      // (lib/name-check.js), and is rejected outright if it's also
      // flagged, with Claude's own reason surfaced directly in the
      // gate's error message.
      //
      // Rate-limited to GATE_CHECK_LIMIT real attempts per rolling
      // GATE_CHECK_WINDOW_MS window — once spent, every further attempt
      // is rejected outright until the window expires (see schema.sql's
      // own comment: an earlier version of this fell back to letting the
      // name through unchecked once exhausted, which a direct follow-up
      // question caught as a real exploit — 3 obviously-bad names to burn
      // the cap, then a 4th equally-bad name slips through unverified).
      // One read (best-effort, fails open — a lookup hiccup just means
      // "don't rate-limit this one") decides whether the window is still
      // active and, if so, whether it's already spent.
      let locked = false;
      let priorCheckCount = 0;
      let windowStartIso = null;
      let unlockAt = null;
      try {
        const { data: rate } = await supabase
          .from('students')
          .select('gate_name_check_count, gate_name_check_window_start')
          .eq('email', email)
          .maybeSingle();
        if (rate && rate.gate_name_check_window_start) {
          const windowStartMs = new Date(rate.gate_name_check_window_start).getTime();
          if (Date.now() - windowStartMs < GATE_CHECK_WINDOW_MS) {
            // Window still active — carry its count/start forward.
            priorCheckCount = rate.gate_name_check_count || 0;
            windowStartIso = rate.gate_name_check_window_start;
            if (priorCheckCount >= GATE_CHECK_LIMIT) {
              locked = true;
              unlockAt = windowStartMs + GATE_CHECK_WINDOW_MS;
            }
          }
          // else: window expired — treat as fresh (priorCheckCount stays
          // 0, windowStartIso stays null, a new window starts below).
        }
      } catch (e) {
        console.error('rename.js: gate_name_check rate lookup failed for', email, e);
      }

      if (locked) {
        const hoursLeft = Math.max(1, Math.ceil((unlockAt - Date.now()) / (60 * 60 * 1000)));
        return json(400, { error: 'You\'ve used all your name-check attempts for now — try again in about ' + hoursLeft + (hoursLeft === 1 ? ' hour.' : ' hours.') });
      }

      try {
        const result = await checkNameAppropriate(displayName);
        if (!result.skipped) {
          try {
            await supabase
              .from('students')
              .update({
                gate_name_check_count: priorCheckCount + 1,
                gate_name_check_window_start: windowStartIso || new Date().toISOString(),
              })
              .eq('email', email);
          } catch (e) {
            console.error('rename.js: gate_name_check increment failed for', email, e);
          }
        }
        if (result.flagged) {
          return json(400, { error: 'That name still isn\'t appropriate for this site — ' + (result.reason || 'please pick a different one.') });
        }
        if (!result.skipped) claudeVerifiedName = displayName;
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
  // needs_rename_source (whatever flagged them no longer applies), and
  // — only when the Claude check above genuinely ran and passed for
  // this exact new name — records it in name_last_checked so the
  // nightly scan (name-check-scan.js) doesn't immediately re-bill an
  // API call re-checking a name that was just vetted seconds ago. A
  // plain voluntary (non-gated) rename deliberately leaves
  // name_last_checked untouched — that name has NOT been Claude-checked
  // by this request, and the nightly scan should still pick it up.
  // Tries with the new fields first, falls back to progressively fewer
  // fields on a pre-migration "column does not exist" error, same
  // fallback shape already used elsewhere in this codebase (e.g.
  // pomo-active.js's owner_token) — a rename must never fail outright
  // just because a newer column doesn't exist in production yet.
  const fullUpdate = { display_name: displayName, needs_rename: false, needs_rename_source: null };
  if (claudeVerifiedName) { fullUpdate.name_last_checked = claudeVerifiedName; fullUpdate.name_check_reason = null; }

  let { data, error } = await supabase
    .from('students')
    .update(fullUpdate)
    .eq('email', email)
    .select('email, display_name')
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
