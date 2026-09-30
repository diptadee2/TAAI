// POST { email, about } — sets (or clears) the student's leaderboard
// "About" text: a short WhatsApp-style status shown as a chat bubble
// beside their name on the weekly top-20 board (progress.js,
// aboutBubbleHtml). Two rules, both enforced here, server-side:
//
//   1. Nothing is saved until Claude has reviewed it
//      (checkAboutAppropriate). Fails CLOSED — no API key, a timeout, or
//      any Claude error refuses the save with a "try again later"
//      message rather than letting unreviewed text onto a public board.
//      A rejected or failed check does NOT use up the monthly change.
//   2. One successful change per IST calendar month (about_changed_month).
//      Rejected attempts are separately capped at ABOUT_CHECK_LIMIT per
//      month (about_check_count/month) so the rejection path can't be
//      used to burn unlimited Claude calls — same reasoning as
//      rename.js's own gated-attempt cap.
//
// Clearing (about: '') is always allowed, never counted, never sent to
// Claude — removing text can't put anything inappropriate on the board.
//
// Trusts `email` from the body with no ownership proof, same as every
// other student-write endpoint here (deliberate open-tier decision —
// see CLAUDE.md).
import { getSupabase, json, todayIST } from './lib/supabase.js';
import { checkAboutAppropriate } from './lib/name-check.js';

const ABOUT_MAX_LENGTH = 80;
const ABOUT_CHECK_LIMIT = 3;

function currentMonth() {
  return todayIST().slice(0, 7); // 'YYYY-MM'
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  // Collapse runs of whitespace/newlines — this renders on one short
  // bubble line, never as multi-line text.
  const about = String(body.about || '').replace(/\s+/g, ' ').trim();
  if (!email) return json(400, { error: 'email is required' });
  if (about.length > ABOUT_MAX_LENGTH) return json(400, { error: 'Keep it under ' + ABOUT_MAX_LENGTH + ' characters.' });

  const supabase = getSupabase();
  const month = currentMonth();

  const { data: student, error: lookupError } = await supabase
    .from('students')
    .select('email, needs_rename, about_text, about_changed_month, about_check_count, about_check_month')
    .eq('email', email)
    .maybeSingle();
  // Pre-migration (the about_* columns don't exist yet) lands here too —
  // a clean "not available yet" rather than a raw Postgres error.
  if (lookupError) return json(503, { error: 'About isn\'t available just yet. Try again later.' });
  if (!student) return json(404, { error: 'student not found' });

  if (!about) {
    const { error } = await supabase.from('students').update({ about_text: null }).eq('email', email);
    if (error) return json(500, { error: error.message });
    return json(200, { about: null, canChange: student.about_changed_month !== month });
  }

  if (student.needs_rename) {
    return json(400, { error: 'Update your display name first, then you can set an About.' });
  }
  if (student.about_changed_month === month) {
    return json(400, { error: 'You\'ve already changed your About this month. You can change it again from the 1st.', canChange: false });
  }
  if (about === (student.about_text || '')) {
    return json(400, { error: 'That\'s already your About.' });
  }

  const priorChecks = student.about_check_month === month ? (student.about_check_count || 0) : 0;
  if (priorChecks >= ABOUT_CHECK_LIMIT) {
    return json(400, { error: 'Too many attempts this month. You can try again from the 1st.', canChange: false });
  }

  let result;
  try {
    result = await checkAboutAppropriate(about);
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
    return json(400, {
      error: 'That About isn\'t allowed here. Please try something different.',
      triesLeft: Math.max(0, ABOUT_CHECK_LIMIT - checksUsed),
    });
  }

  // Conditional on the month not already being used — closes the race
  // where two concurrent requests both pass the check above; only the
  // first write matches, the second updates zero rows.
  const { data: written, error: writeError } = await supabase
    .from('students')
    .update({
      about_text: about,
      about_changed_month: month,
      about_check_count: checksUsed,
      about_check_month: month,
    })
    .eq('email', email)
    .or('about_changed_month.is.null,about_changed_month.neq.' + month)
    .select('about_text');
  if (writeError) return json(500, { error: writeError.message });
  if (!written || !written.length) {
    return json(400, { error: 'You\'ve already changed your About this month. You can change it again from the 1st.', canChange: false });
  }

  return json(200, { about: written[0].about_text, canChange: false });
}
