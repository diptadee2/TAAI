// POST { email, about } — sets (or clears) the student's leaderboard
// "About" text: a short WhatsApp-style status shown as a chat bubble
// beside their name on the weekly top-20 board (progress.js,
// aboutBubbleHtml). Two rules, both enforced here, server-side:
//
//   1. Nothing is saved until Claude has reviewed it
//      (checkAboutAppropriate). Fails CLOSED — no API key, a timeout, or
//      any Claude error refuses the save with a "try again later"
//      message rather than letting unreviewed text onto a public board.
//      A rejected or failed check does NOT use up the weekly change.
//   2. One successful change per IST week, Monday to Sunday, the same week
//      as the weekly leaderboard (weekStartIST). Was once a month until
//      2026-10-01. The period key lives in about_changed_month, now holding a
//      week-start date (YYYY-MM-DD) despite the column's name; old YYYY-MM
//      values simply never match, so nobody is locked out by the switch.
//      Rejected attempts are separately capped at ABOUT_CHECK_LIMIT per
//      week (about_check_count/month columns, same week key) so the rejection path can't be
//      used to burn unlimited Claude calls — same reasoning as
//      rename.js's own gated-attempt cap.
//
// Clearing (about: '') is always allowed, never counted, never sent to
// Claude — removing text can't put anything inappropriate on the board.
//
// Trusts `email` from the body with no ownership proof, same as every
// other student-write endpoint here (deliberate open-tier decision —
// see CLAUDE.md).
import { getSupabase, json, weekStartIST } from './lib/supabase.js';
import { checkAboutAppropriate, normalizeAboutText } from './lib/name-check.js';

const ABOUT_MAX_LENGTH = 80;
// 2 tries a week (direct request 2026-10-01, was 3): after 2 rejections the
// student can't post an About until Monday. Every check counts, so at most
// 2 Claude calls per student per week.
const ABOUT_CHECK_LIMIT = 2;

function currentPeriod() {
  return weekStartIST(); // 'YYYY-MM-DD' of this IST week's Monday
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  // Normalized (whitespace collapsed, invisible characters stripped,
  // compatibility characters folded) BEFORE the check, and this exact
  // string is what gets saved, so Claude reviews precisely what shows.
  const about = normalizeAboutText(body.about);
  if (!email) return json(400, { error: 'email is required' });
  if (about.length > ABOUT_MAX_LENGTH) return json(400, { error: 'Keep it under ' + ABOUT_MAX_LENGTH + ' characters.' });

  const supabase = getSupabase();
  const month = currentPeriod(); // named for the column it's compared against

  const { data: student, error: lookupError } = await supabase
    .from('students')
    .select('email, needs_rename, about_text, about_changed_month, about_check_count, about_check_month')
    .eq('email', email)
    .maybeSingle();
  // Pre-migration (the about_* columns don't exist yet) lands here too —
  // a clean "not available yet" rather than a raw Postgres error.
  if (lookupError) return json(503, { error: 'About isn\'t available just yet. Try again later.' });
  if (!student) return json(404, { error: 'student not found' });

  // Team moderation for an About that got past the check (direct requests
  // 2026-10-01), applied by scripts/flag-about.mjs. The student always
  // stays on the leaderboards:
  //   1st flag - About removed, about_reset_allowed = true: they may set a
  //              new one right away, even if this week's change was used.
  //   2nd+ flag (circumventing) - About removed and about_banned_until set
  //              two weeks out: no new About until then.
  // Best-effort, separate query (columns added later than the others).
  // Checked before any Claude call.
  let bannedUntil = null;
  let resetAllowed = false;
  try {
    const { data: b, error: bErr } = await supabase.from('students').select('about_banned_until, about_reset_allowed').eq('email', email).maybeSingle();
    if (!bErr && b) {
      if (b.about_banned_until && new Date(b.about_banned_until) > new Date()) bannedUntil = b.about_banned_until;
      resetAllowed = !!b.about_reset_allowed;
    }
  } catch (e) { /* not migrated yet */ }

  if (!about) {
    const { error } = await supabase.from('students').update({ about_text: null }).eq('email', email);
    if (error) return json(500, { error: error.message });
    return json(200, { about: null, canChange: student.about_changed_month !== month });
  }

  if (student.needs_rename) {
    return json(400, { error: 'Update your display name first, then you can set an About.' });
  }
  if (bannedUntil) {
    const until = new Date(bannedUntil).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
    const days = Math.max(1, Math.ceil((new Date(bannedUntil).getTime() - Date.now()) / 86400000));
    return json(400, { error: 'Your About was removed by the team. You can set a new one in ' + days + ' day' + (days === 1 ? '' : 's') + ' (' + until + ').', canChange: false, lockReason: 'banned', bannedUntil, daysLeft: days });
  }
  if (student.about_changed_month === month && !resetAllowed) {
    return json(400, { error: 'You\'ve already changed your About this week. You can change it again on Monday.', canChange: false });
  }
  if (about === (student.about_text || '')) {
    return json(400, { error: 'That\'s already your About.' });
  }

  const priorChecks = student.about_check_month === month ? (student.about_check_count || 0) : 0;
  if (priorChecks >= ABOUT_CHECK_LIMIT) {
    return json(400, { error: 'You\'re out of tries for this week. You can post an About again on Monday.', canChange: false, lockReason: 'tries' });
  }

  // Best-effort, its own query (a column added after the rest): the last
  // rejected About, so a softened re-try of it is judged in context.
  let priorFlagged = null;
  try {
    const { data: prior } = await supabase.from('students').select('about_last_flagged').eq('email', email).maybeSingle();
    priorFlagged = (prior && prior.about_last_flagged) || null;
  } catch (e) { /* column not migrated yet: no context, still checked */ }

  let result;
  try {
    result = await checkAboutAppropriate(about, priorFlagged);
  } catch (e) {
    console.error('set-about: Claude check failed for', email, e);
    return json(503, { error: 'Couldn\'t check that right now. Please try again in a bit.' });
  }
  if (result.skipped) {
    return json(503, { error: 'Couldn\'t check that right now. Please try again in a bit.' });
  }

  const checksUsed = priorChecks + 1;

  if (result.flagged) {
    await supabase
      .from('students')
      .update({ about_check_count: checksUsed, about_check_month: month })
      .eq('email', email);
    // Separate write, so a not-yet-migrated column can't block the count above.
    try { await supabase.from('students').update({ about_last_flagged: about }).eq('email', email); } catch (e) { /* non-critical */ }
    const triesLeft = Math.max(0, ABOUT_CHECK_LIMIT - checksUsed);
    return json(400, triesLeft > 0
      ? { error: 'That About isn\'t allowed here. You have ' + triesLeft + ' more try this week.', triesLeft }
      : { error: 'That About isn\'t allowed here, and you\'re out of tries. You can post an About again on Monday.', triesLeft: 0, canChange: false, lockReason: 'tries' });
  }

  // Conditional on this week's change not already being used — closes the race
  // where two concurrent requests both pass the check above; only the
  // first write matches, the second updates zero rows.
  let writeQuery = supabase
    .from('students')
    .update({
      about_text: about,
      about_changed_month: month,
      about_check_count: checksUsed,
      about_check_month: month,
    })
    .eq('email', email);
  // Replacing a team-removed About skips the weekly condition.
  if (!resetAllowed) writeQuery = writeQuery.or('about_changed_month.is.null,about_changed_month.neq.' + month);
  const { data: written, error: writeError } = await writeQuery.select('about_text');
  if (writeError) return json(500, { error: writeError.message });
  if (!written || !written.length) {
    return json(400, { error: 'You\'ve already changed your About this week. You can change it again on Monday.', canChange: false });
  }

  if (resetAllowed) {
    try { await supabase.from('students').update({ about_reset_allowed: false }).eq('email', email); } catch (e) { /* non-critical */ }
  }
  return json(200, { about: written[0].about_text, canChange: false });
}
