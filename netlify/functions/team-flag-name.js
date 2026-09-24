// POST /api/team-flag-name { email, unflag? }
//
// Backs /team's Students view "🚩 Flag inappropriate name" action —
// replaces the earlier one-off-SQL-statement workflow (see
// students.needs_rename's own comment in schema.sql) with a real,
// role-gated endpoint. The admin's click IS the decision — this always
// sets needs_rename=true (or clears it, for `unflag`) regardless of what
// Claude thinks — but it also runs the same checkNameAppropriate()
// classifier used by rename.js/name-check-scan.js on the student's
// CURRENT name and returns that opinion alongside the result, so the
// admin sees a "second opinion" (agrees / disagrees + reason) rather
// than flagging blind. Claude disagreeing never blocks the flag; this is
// purely informational, same "the human call still wins" reasoning the
// site's own malpractice/freeze systems never apply to a manual admin
// action either.
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { checkNameAppropriate } from './lib/name-check.js';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;

  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });

  const supabase = getSupabase();

  if (body.unflag) {
    // Falls back to just the original needs_rename column on a
    // pre-migration "column does not exist" error — same discipline as
    // rename.js's own fallback chain, so this action still works before
    // needs_rename_source has been added to production.
    let { error } = await supabase
      .from('students')
      .update({ needs_rename: false, needs_rename_source: null })
      .eq('email', email);
    if (error) {
      ({ error } = await supabase.from('students').update({ needs_rename: false }).eq('email', email));
    }
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, needsRename: false });
  }

  const { data: student, error: lookupError } = await supabase
    .from('students')
    .select('display_name')
    .eq('email', email)
    .maybeSingle();
  if (lookupError) return json(500, { error: lookupError.message });
  if (!student) return json(404, { error: 'student not found' });

  // The Claude call is genuinely optional here — if it fails (API down,
  // no key configured), the admin's flag still goes through, just
  // without a second opinion attached, rather than the whole action
  // failing over an informational extra.
  let claude = null;
  try {
    claude = await checkNameAppropriate(student.display_name);
  } catch (e) {
    console.error('team-flag-name.js: Claude check failed for', email, e);
  }

  const patch = { needs_rename: true, needs_rename_source: 'admin' };
  if (claude && !claude.skipped) {
    patch.name_check_reason = claude.reason || null;
    patch.name_last_checked = student.display_name;
  }
  // Same progressively-smaller fallback chain as rename.js — a
  // pre-migration "column does not exist" error must never stop the
  // admin's actual flag (needs_rename itself, the original, already-
  // migrated column) from going through.
  let { error: updateError } = await supabase.from('students').update(patch).eq('email', email);
  if (updateError) {
    ({ error: updateError } = await supabase.from('students').update({ needs_rename: true, needs_rename_source: 'admin' }).eq('email', email));
  }
  if (updateError) {
    ({ error: updateError } = await supabase.from('students').update({ needs_rename: true }).eq('email', email));
  }
  if (updateError) return json(500, { error: updateError.message });

  return json(200, {
    ok: true,
    needsRename: true,
    claudeAgrees: claude ? claude.flagged : null,
    claudeReason: claude ? claude.reason : null,
    claudeSkipped: claude ? !!claude.skipped : true,
  });
}
